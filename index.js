const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const { google } = require("googleapis");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const DAYS = [
  { key: "MON", label: "월" },
  { key: "TUE", label: "화" },
  { key: "WED", label: "수" },
  { key: "THU", label: "목" },
  { key: "FRI", label: "금" },
  { key: "SAT", label: "토" },
  { key: "SUN", label: "일" },
];
const VALID_DAY_KEYS = new Set(DAYS.map((d) => d.key));

/** 마감·조회 집계: 한 주를 수요일 → 다음 주 화요일 순으로 표시 */
const BOARD_WEEK_DAY_KEYS = ["WED", "THU", "FRI", "SAT", "SUN", "MON", "TUE"];

function getDaysInBoardWeekOrder() {
  return BOARD_WEEK_DAY_KEYS.map((key) => DAYS.find((d) => d.key === key)).filter(Boolean);
}

/** 조율판 embed **안내** 블록 기본 문구 (`user-work-schedule.json` 의 `global.boardGuideText` 로 덮어쓸 수 있음) */
const DEFAULT_BOARD_GUIDE = [
  "요일 버튼으로 먼저 대상 요일을 선택한 뒤, 시간 버튼으로 해당 요일 시간을 선택해 주세요. (복수 선택 가능)",
  "",
  "🔴 **빨간색으로 표시된 요일은 선택할 수 없습니다.**",
  "조율 주간(일자): 수요일 ~ 다음 주 화요일까지 한 주로 표시됩니다.",
  "진행 기준: 가장 많은 인원이 선택한 시간대를 선정합니다.",
  "진행 시점: 차주 아이온2 정기점검 종료 후, 확정된 시간에 진행됩니다.",
].join("\n");

const BOARD_GUIDE_MAX_LEN = 2000;

/** 조율판 일자: 한 주의 시작을 수요일로 두고 MON=+5 … TUE=+6 (수~화 7일) */
const DAY_OFFSET_FROM_WEDNESDAY = {
  WED: 0,
  THU: 1,
  FRI: 2,
  SAT: 3,
  SUN: 4,
  MON: 5,
  TUE: 6,
};
const TIME_SLOTS = ["19:00", "19:30", "20:00", "20:30", "21:00"];

const sessions = new Map();
const liveSyncTimers = new Map();
/** 시트 반복 가져오기 시 members.fetch 부담 완화 */
let guildMemberLabelIndexCache = { map: null, atMs: 0 };
const GUILD_MEMBER_LABEL_INDEX_TTL_MS = 60_000;

const SCHEDULE_TZ = "Asia/Seoul";
/** 조율판 버튼 클릭마다 `console.log`. 서버 로그가 시끄러우면 `SCHEDULE_LOG_BUTTON_INTERACTIONS=0` */
function isScheduleButtonInteractionLogEnabled() {
  const v = String(process.env.SCHEDULE_LOG_BUTTON_INTERACTIONS ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}
/** @type {{ sessionId: string; channelId: string; messageId: string } | null} */
let weeklyAutoSession = null;
let sheetsClient = null;
let sheetsDisabledLogPrinted = false;

/** @type {{ users: Record<string, unknown>; global: unknown | null; mtimeMs: number; resolvedPath: string }} */
let userWorkScheduleCache = { users: {}, global: null, mtimeMs: -1, resolvedPath: "" };

function getUserWorkSchedulePath() {
  const raw = process.env.USER_WORK_SCHEDULE_PATH;
  return raw ? path.resolve(raw) : path.join(__dirname, "user-work-schedule.json");
}

function formatCalendarDateInTz(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

function addCalendarDaysToIsoYmd(isoYmd, deltaDays) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return formatCalendarDateInTz(ms, SCHEDULE_TZ);
}

/** ISO 날짜(YYYY-MM-DD)를 서울 달력 그날로 본 뒤, `session.createdAt` 계산에 쓸 UTC 정오 ms */
function isoYmdToCreatedAtUtcNoonMs(isoYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoYmd)) {
    return NaN;
  }
  const [y, m, d] = isoYmd.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

/**
 * 투표 주가 시작하는 수요일(서울) `voteStartWedIso`에 맞추기 위한 `createdAt` ms.
 * 기본 모드: 게시일이 속한 수~화 블록의 수요일 +7 = 투표 시작이므로 게시 **달력일**은 그보다 7일 앞 수요일.
 * 특수 모드: +0 이므로 게시 달력일 = 투표 시작 수요일.
 */
function createdAtMsForVoteStartWednesday(voteStartWedIso, priorWeekVoteWindow) {
  if (priorWeekVoteWindow) {
    return isoYmdToCreatedAtUtcNoonMs(voteStartWedIso);
  }
  const postDayIso = addCalendarDaysToIsoYmd(voteStartWedIso, -7);
  return isoYmdToCreatedAtUtcNoonMs(postDayIso);
}

function loadUserWorkScheduleMap() {
  const resolvedPath = getUserWorkSchedulePath();
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      userWorkScheduleCache = { users: {}, global: null, mtimeMs: stat.mtimeMs, resolvedPath };
      return userWorkScheduleCache.users;
    }
    if (
      userWorkScheduleCache.resolvedPath === resolvedPath &&
      userWorkScheduleCache.mtimeMs === stat.mtimeMs
    ) {
      return userWorkScheduleCache.users;
    }

    const rawText = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(rawText);
    const users =
      parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object"
        ? parsed.users
        : {};
    const globalCfg =
      parsed && typeof parsed === "object" && parsed.global && typeof parsed.global === "object"
        ? parsed.global
        : null;

    userWorkScheduleCache = { users, global: globalCfg, mtimeMs: stat.mtimeMs, resolvedPath };
    console.log(
      `user-work-schedule.json 로드: 사용자 ${Object.keys(users).length}명, 전역 규칙 ${globalCfg ? "있음" : "없음"} (${resolvedPath})`
    );
    return users;
  } catch (error) {
    if (error.code === "ENOENT") {
      userWorkScheduleCache = {
        users: {},
        global: null,
        mtimeMs: -1,
        resolvedPath: getUserWorkSchedulePath(),
      };
      return userWorkScheduleCache.users;
    }
    console.error("user-work-schedule.json 로드 실패:", error.message || error);
    return {};
  }
}

/** .env SCHEDULE_GLOBAL_WORK_DATES=2026-05-08,2026-05-09 (Asia/Seoul 달력 기준) */
function getEnvGlobalWorkDateSet() {
  const raw = process.env.SCHEDULE_GLOBAL_WORK_DATES;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  const dates = String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) {
    return null;
  }
  return new Set(dates);
}

const WEEKDAY_SHORT_TO_KEY = {
  Mon: "MON",
  Tue: "TUE",
  Wed: "WED",
  Thu: "THU",
  Fri: "FRI",
  Sat: "SAT",
  Sun: "SUN",
};

function weekdayKeyFromIsoYmd(isoYmd, timeZone = SCHEDULE_TZ) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const short = fmt.format(new Date(utcNoon));
  return WEEKDAY_SHORT_TO_KEY[short] || null;
}

/** 해당 날짜가 속한 **수~화** 주간의 시작 수요일 (한국 달력 기준) */
function getWednesdayIsoContaining(isoYmd) {
  for (let back = 0; back < 7; back++) {
    const cand = addCalendarDaysToIsoYmd(isoYmd, -back);
    if (weekdayKeyFromIsoYmd(cand, SCHEDULE_TZ) === "WED") {
      return cand;
    }
  }
  return isoYmd;
}

/** .env `SCHEDULE_GLOBAL_WORK_DATES` + JSON `global.workDates` 합친 달력 근무일 목록 (표시·시트 등; 요일 버튼 빨강과는 무관) */
function getMergedWorkDatesConfigForComputation() {
  loadUserWorkScheduleMap();
  const g = userWorkScheduleCache.global;

  const envDatesSet = getEnvGlobalWorkDateSet();
  const jsonWd =
    g && typeof g === "object" && Array.isArray(g.workDates)
      ? g.workDates.filter((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x))
      : [];

  let workDatesArr = [];
  if (envDatesSet) {
    workDatesArr.push(...envDatesSet);
  }
  workDatesArr.push(...jsonWd);
  workDatesArr = [...new Set(workDatesArr)];

  if (workDatesArr.length === 0) {
    return null;
  }

  return {
    timezone: SCHEDULE_TZ,
    workDates: workDatesArr,
  };
}

/** .env SCHEDULE_BLOCKED_DAY_KEYS 파싱 (로그 안내용; 요일 빨강에는 사용하지 않음) */
function parseEnvBlockedDayKeysSet() {
  const raw = process.env.SCHEDULE_BLOCKED_DAY_KEYS;
  if (!raw || !String(raw).trim()) {
    return new Set();
  }
  const set = new Set();
  for (const part of String(raw).split(/[\s,]+/)) {
    const k = part.trim().toUpperCase();
    if (VALID_DAY_KEYS.has(k)) {
      set.add(k);
    }
  }
  return set;
}

/** 대시보드에서 저장한 `user-work-schedule.json` global.blockedDayKeys 만 반영 (.env·근무일·슬래시 잠금 없음) */
function getDashboardGlobalBlockedDayKeysSet() {
  const merged = new Set();
  loadUserWorkScheduleMap();
  const g = userWorkScheduleCache.global;
  if (g && typeof g === "object" && Array.isArray(g.blockedDayKeys)) {
    for (const k of g.blockedDayKeys) {
      if (typeof k === "string" && VALID_DAY_KEYS.has(k.toUpperCase())) {
        merged.add(k.toUpperCase());
      }
    }
  }
  return merged;
}

/** 세션별 관리자 잠금 집합(레거시; 슬래시 제거로 항상 비어 있음) */
function getSessionManualLockedDayKeysSet(session) {
  if (!session.manualLockedDayKeys) {
    session.manualLockedDayKeys = new Set();
  } else if (!(session.manualLockedDayKeys instanceof Set)) {
    const arr = Array.isArray(session.manualLockedDayKeys) ? session.manualLockedDayKeys : [];
    session.manualLockedDayKeys = new Set(
      arr.map((k) => String(k).toUpperCase()).filter((k) => VALID_DAY_KEYS.has(k))
    );
  }
  return session.manualLockedDayKeys;
}

function getMergedBlockedDayKeysForSession(_session) {
  return new Set(getDashboardGlobalBlockedDayKeysSet());
}

function mergeBlockedDayKeysForSessionAndUser(session, _userId) {
  return new Set(getMergedBlockedDayKeysForSession(session));
}

/** @returns {Set<string> | null} null이면 제한 없음 */
function getOptionalUserIdSetFromEnv(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  const ids = String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return null;
  }
  return new Set(ids);
}

function isUserAllowedScheduleButtons(userId) {
  const allow = getOptionalUserIdSetFromEnv("SCHEDULE_BUTTON_ALLOW_USER_IDS");
  if (allow && !allow.has(userId)) {
    return false;
  }
  const deny = getOptionalUserIdSetFromEnv("SCHEDULE_BUTTON_DENY_USER_IDS");
  if (deny && deny.has(userId)) {
    return false;
  }
  return true;
}

/** 일부 환경에서 memberPermissions 가 비어 관리자도 막히는 경우가 있어 채널 기준으로 한 번 더 확인 */
function interactionMemberIsAdministrator(interaction) {
  if (!interaction.inGuild()) {
    return false;
  }
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  const member = interaction.member;
  const channel = interaction.channel;
  if (member && channel && typeof member.permissionsIn === "function") {
    try {
      return member.permissionsIn(channel).has(PermissionFlagsBits.Administrator);
    } catch (_) {
      return false;
    }
  }
  return false;
}

const commands = [
  new SlashCommandBuilder()
    .setName("일정생성")
    .setDescription(
      "주간(수~화, 한국 달력) 요일/시간 참여를 조율판으로 생성합니다. 투표 주간은 게시 블록 시작 수요일 기준 1주 뒤 수요일이 첫날인 7일입니다."
    )
    .addStringOption((option) =>
      option
        .setName("모드")
        .setDescription("비우면 기본(투표 주 1주 뒤 수 시작). 특수는 그보다 1주 앞(게시 주의 수요일 시작).")
        .setRequired(false)
        .addChoices(
          { name: "기본", value: "default" },
          { name: "특수", value: "special" }
        )
    ),
  new SlashCommandBuilder()
    .setName("일정생성특수")
    .setDescription(
      "일정생성(기본)보다 투표·조율 주간이 1주 앞섭니다. 게시 수~화 블록이 속한 주의 수요일이 투표 주 시작입니다."
    ),
  new SlashCommandBuilder()
    .setName("schedule_special")
    .setDescription(
      "Same as /일정생성특수 — vote Wed–Tue window starts one week earlier than /일정생성 default."
    ),
  new SlashCommandBuilder()
    .setName("일정마감")
    .setDescription("현재 채널의 최신 조율판을 즉시 마감하고 집계를 확정합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("시트불러오기")
    .setDescription(
      "실시간 Google 시트(`.env`의 GOOGLE_SHEET_LIVE_RANGE 또는 마감 후 저장된 탭 범위)를 읽어 같은 투표 주간의 조율판 임베드를 갱신합니다."
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("sheet_sync")
    .setDescription("Same as /시트불러오기 — import live sheet into matching schedule boards.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((command) => command.toJSON());

async function registerCommands(client) {
  const token = process.env.DISCORD_TOKEN;
  const envClientId = process.env.CLIENT_ID;
  const runtimeClientId = client?.application?.id;
  const clientId = runtimeClientId || envClientId;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.log("DISCORD_TOKEN 또는 애플리케이션 ID가 없어 슬래시 명령어 등록을 건너뜁니다.");
    return;
  }

  if (envClientId && runtimeClientId && envClientId !== runtimeClientId) {
    console.warn(
      `CLIENT_ID(${envClientId})와 로그인된 앱 ID(${runtimeClientId})가 달라 로그인된 앱 ID를 사용합니다.`
    );
  }

  const rest = new REST({ version: "10" }).setToken(token);

  const commandNames = commands.map((c) => c.name).join(", ");
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`길드 전용 슬래시 명령어 등록 완료 (${commandNames})`);
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`전역 슬래시 명령어 등록 완료 (${commandNames}) — 디스코드에 반영까지 수 분 걸릴 수 있음`);
}

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ createdAtMs?: number; priorWeekVoteWindow?: boolean }} [options]
 *   createdAtMs — 세션 생성 시각(기본: 지금). 테스트·크론 등에서만 지정.
 *   priorWeekVoteWindow — true면 투표 주 시작 수요일이 기본보다 1주 앞(게시 주와 같은 수요일 시작).
 */
function registerSession(createdBy, channelId = null, options = {}) {
  const createdAt =
    typeof options.createdAtMs === "number" && Number.isFinite(options.createdAtMs)
      ? options.createdAtMs
      : Date.now();
  const sessionId = makeSessionId();
  const session = {
    id: sessionId,
    users: new Map(),
    createdBy,
    channelId,
    messageId: null,
    createdAt,
    priorWeekVoteWindow: options.priorWeekVoteWindow === true,
    manualLockedDayKeys: new Set(),
  };
  sessions.set(sessionId, session);
  return { sessionId, session };
}

async function getSheetsClient() {
  if (sheetsClient) {
    return sheetsClient;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKeyRaw) {
    if (!sheetsDisabledLogPrinted) {
      console.log("Google Sheets 연동 비활성화: GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY 미설정");
      sheetsDisabledLogPrinted = true;
    }
    return null;
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

function getCountForDay(session, dayKey) {
  let count = 0;
  for (const [, userData] of session.users.entries()) {
    const times = userData.selectedDayTimes?.get(dayKey);
    if (times && times.size > 0) {
      count += 1;
    }
  }
  return count;
}

function getCountForTime(session, time) {
  let count = 0;
  for (const [, userData] of session.users.entries()) {
    const dayTimes = userData.selectedDayTimes;
    if (!(dayTimes instanceof Map)) {
      continue;
    }
    for (const times of dayTimes.values()) {
      if (times.has(time)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function buildSheetRowsForSession(session) {
  const sourceSession = session.createdAt ? session : { ...session, createdAt: Date.now() };
  const { voteStartIso, voteEndIso } = getVoteWindowIsoForSession(sourceSession);
  const startLabel = formatIsoYmdForBoard(voteStartIso);
  const endLabel = formatIsoYmdForBoard(voteEndIso);
  const headerRow = ["참여자", "시작일", "마감일", "시간", ...DAYS.map((day) => `${day.label}요일`)];

  const rows = [];
  rows.push(headerRow);
  for (const [, userData] of session.users.entries()) {
    if (rows.length > 1) {
      rows.push(headerRow);
    }
    TIME_SLOTS.forEach((time, timeIndex) => {
      const row = [
        timeIndex === 0 ? userData.username || "" : "",
        timeIndex === 0 ? startLabel : "",
        timeIndex === 0 ? endLabel : "",
        time,
      ];
      for (const day of DAYS) {
        const times = userData.selectedDayTimes?.get(day.key);
        row.push(times && times.has(time) ? "O" : "X");
      }
      rows.push(row);
    });
  }

  if (session.users.size === 0) {
    TIME_SLOTS.forEach((time, timeIndex) => {
      rows.push([
        timeIndex === 0 ? "참여자 없음" : "",
        timeIndex === 0 ? startLabel : "",
        timeIndex === 0 ? endLabel : "",
        time,
        ...DAYS.map(() => "X"),
      ]);
    });
  }
  return rows;
}

/**
 * 시트에 헤더가 이미 있을 때 쓰는 실시간 동기화용: 참가자당 `TIME_SLOTS` 길이만큼의 행만(헤더 없음).
 * @returns {string[][][]}
 */
function buildLiveSyncParticipantGroups(session) {
  const sourceSession = session.createdAt ? session : { ...session, createdAt: Date.now() };
  const { voteStartIso, voteEndIso } = getVoteWindowIsoForSession(sourceSession);
  const startLabel = formatIsoYmdForBoard(voteStartIso);
  const endLabel = formatIsoYmdForBoard(voteEndIso);
  /** @type {string[][][]} */
  const groups = [];

  function pushUserRows(userData) {
    const chunk = [];
    TIME_SLOTS.forEach((time, timeIndex) => {
      chunk.push([
        timeIndex === 0 ? userData.username || "" : "",
        timeIndex === 0 ? startLabel : "",
        timeIndex === 0 ? endLabel : "",
        time,
        ...DAYS.map((day) => {
          const times = userData.selectedDayTimes?.get(day.key);
          return times && times.has(time) ? "O" : "X";
        }),
      ]);
    });
    groups.push(chunk);
  }

  for (const [, userData] of session.users.entries()) {
    pushUserRows(userData);
  }
  if (session.users.size === 0) {
    const chunk = [];
    TIME_SLOTS.forEach((time, timeIndex) => {
      chunk.push([
        timeIndex === 0 ? "참여자 없음" : "",
        timeIndex === 0 ? startLabel : "",
        timeIndex === 0 ? endLabel : "",
        time,
        ...DAYS.map(() => "X"),
      ]);
    });
    groups.push(chunk);
  }
  return groups;
}

function getSheetTitleFromRange(range, fallback = "Sheet1") {
  const rawSheetName = range.includes("!") ? range.split("!")[0] : fallback;
  return rawSheetName.replace(/^'(.*)'$/, "$1");
}

function getRangeStartA1(range, fallback = "A1") {
  if (!range.includes("!")) {
    return range || fallback;
  }
  const a1 = range.split("!")[1];
  if (!a1) {
    return fallback;
  }
  return a1.split(":")[0] || fallback;
}

/** 조율판 값 열 수(참여자·시작·마감·시간 + 요일) — 실시간 시트는 이 너비만 clear/update */
function getScheduleGridColumnCount() {
  return 4 + DAYS.length;
}

function a1ColumnLettersToIndex(letters) {
  const u = String(letters || "").toUpperCase();
  let n = 0;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i) - 64;
    if (c < 1 || c > 26) {
      return NaN;
    }
    n = n * 26 + c;
  }
  return n;
}

function a1IndexToColumnLetters(index) {
  let n = index;
  let s = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

function parseA1Cell(ref) {
  const m = String(ref || "").trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!m) {
    return null;
  }
  const col = m[1].toUpperCase();
  const colIndex = a1ColumnLettersToIndex(col);
  const row = Number.parseInt(m[2], 10);
  if (!Number.isFinite(row) || !Number.isFinite(colIndex)) {
    return null;
  }
  return { col, colIndex, row };
}

function isLiveSyncFixedSheetHeadersEnabled() {
  const v = String(process.env.SCHEDULE_LIVE_SYNC_FIXED_SHEET_HEADERS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 첫 블록의 헤더 행(1-based). 시트에 고정된 「참여자 / 시작일 / …」 줄. */
function getLiveSyncTemplateHeaderRow1() {
  const n = Number.parseInt(String(process.env.SCHEDULE_LIVE_SYNC_TEMPLATE_HEADER_ROW ?? "1").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** 헤더 1행 + 참가자별 `TIME_SLOTS` 행까지 한 블록의 행 수(기본 6). */
function getLiveSyncTemplateBlockRowCount() {
  const minBlock = TIME_SLOTS.length + 1;
  const n = Number.parseInt(String(process.env.SCHEDULE_LIVE_SYNC_TEMPLATE_BLOCK_ROWS ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < minBlock) {
    return minBlock;
  }
  return n;
}

/**
 * LIVE A1 span의 **왼쪽 위 셀** — `getLiveSyncDataStartRow1FromLiveRange`에서 **행** 힌트만 씀.
 * 조율 표 **열**은 항상 A부터 11열(고정); LIVE에 M9 등이 있어도 쓰기·읽기 열은 A로 둠.
 */
function getLiveSyncGridAnchorFromLiveRange(liveRange) {
  const bang = liveRange.indexOf("!");
  const a1Part = (bang >= 0 ? liveRange.slice(bang + 1) : liveRange).trim();
  const span = a1Part.includes(":") ? a1Part : `${a1Part}:${a1Part}`;
  const leftRaw = (span.split(":")[0] || "A1").trim();
  return parseA1Cell(leftRaw) || { col: "A", colIndex: 1, row: 1 };
}

let warnedLiveSyncDataStartRowClamp = false;

/**
 * 조율 표가 들어갈 **첫 데이터 행(1-based)** (실시간 쓰기 기준).
 * - `SCHEDULE_LIVE_SYNC_FIXED_SHEET_HEADERS=1` 이면 첫 데이터는 기본 `TEMPLATE_HEADER_ROW+1`. `DATA_START_ROW`가 헤더 행 이하이면 **헤더를 덮지 않도록** 올림.
 * - 고정 헤더가 아니면 `DATA_START_ROW`가 있으면 그대로.
 * - 없으면 LIVE 왼쪽 위 **행**: **1행이면 기본 9행**.
 */
function getLiveSyncDataStartRow1FromLiveRange(liveRange) {
  const headerRow1 = getLiveSyncTemplateHeaderRow1();
  const ovrRaw = process.env.SCHEDULE_LIVE_SYNC_DATA_START_ROW && String(process.env.SCHEDULE_LIVE_SYNC_DATA_START_ROW).trim();
  let fromOvr = null;
  if (ovrRaw) {
    const n = Number.parseInt(ovrRaw, 10);
    if (Number.isFinite(n) && n >= 1) {
      fromOvr = n;
    }
  }

  if (isLiveSyncFixedSheetHeadersEnabled()) {
    const minimal = headerRow1 + 1;
    if (fromOvr !== null && fromOvr <= headerRow1) {
      if (!warnedLiveSyncDataStartRowClamp) {
        warnedLiveSyncDataStartRowClamp = true;
        console.warn(
          "[실시간시트] SCHEDULE_LIVE_SYNC_DATA_START_ROW=",
          fromOvr,
          "은 고정 헤더 행(" + headerRow1 + ")과 겹칩니다. 서버 .env에서 삭제하거나",
          minimal,
          "이상으로 두세요. 지금은 행",
          minimal,
          "부터 씁니다."
        );
      }
      return minimal;
    }
    if (fromOvr !== null) {
      return fromOvr;
    }
    return minimal;
  }

  if (fromOvr !== null) {
    return fromOvr;
  }

  const anchor = getLiveSyncGridAnchorFromLiveRange(liveRange);
  const r = Math.max(1, anchor.row);
  if (r === 1) {
    return 9;
  }
  return r;
}

/** 시트 →디스코드 읽기 시 첫 행(1-based). 고정 헤더 모드면 1행부터 읽어 중간 헤더 줄도 파싱에 넘김. */
function getLiveSyncReadTopRow1(liveRange) {
  if (isLiveSyncFixedSheetHeadersEnabled()) {
    return 1;
  }
  return getLiveSyncDataStartRow1FromLiveRange(liveRange);
}

/** 실시간 조율 값: **항상 A열~11열**. `opts.forImport` 이면 읽기 시작 행은 `getLiveSyncReadTopRow1`. */
function getLiveSyncValuesOnlyRange(liveRange, dataRowCount, verticalMode = "full", opts = {}) {
  const forImport = opts && opts.forImport === true;
  const bang = liveRange.indexOf("!");
  const a1Part = (bang >= 0 ? liveRange.slice(bang + 1) : liveRange).trim();
  const span = a1Part.includes(":") ? a1Part : `${a1Part}:${a1Part}`;
  const parts = span.split(":");
  const rightRaw = (parts[1] || parts[0] || "A1").trim();
  const anchor = getLiveSyncGridAnchorFromLiveRange(liveRange);
  const endParsed = parseA1Cell(rightRaw) || anchor;
  const rowSpan = Math.max(1, Number(dataRowCount) || 1);
  const envBottom = Math.max(anchor.row, endParsed.row);
  const topRow1 = forImport ? getLiveSyncReadTopRow1(liveRange) : getLiveSyncDataStartRow1FromLiveRange(liveRange);
  const bottomRow =
    verticalMode === "tight"
      ? topRow1 + rowSpan - 1
      : Math.max(envBottom, topRow1 + rowSpan - 1);
  const endCol = a1IndexToColumnLetters(getScheduleGridColumnCount());
  const sheetTitle = getSheetTitleFromRange(liveRange, "Sheet1");
  return makeQuotedSheetRange(sheetTitle, `A${topRow1}:${endCol}${bottomRow}`);
}

function getLiveSheetStatePath() {
  const raw = process.env.SCHEDULE_LIVE_SHEET_STATE_PATH;
  if (raw && String(raw).trim()) {
    const t = String(raw).trim();
    return path.isAbsolute(t) ? t : path.join(__dirname, t);
  }
  return path.join(__dirname, ".schedule-live-sheet.json");
}

function readLiveSheetRangeOverride() {
  try {
    const p = getLiveSheetStatePath();
    if (!fs.existsSync(p)) {
      return null;
    }
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const r = j && typeof j.liveRange === "string" ? j.liveRange.trim() : "";
    if (!r || !r.includes("!")) {
      return null;
    }
    return r;
  } catch {
    return null;
  }
}

function writeLiveSheetRangeOverride(liveRange) {
  const p = getLiveSheetStatePath();
  const payload = JSON.stringify({ liveRange: String(liveRange).trim(), updatedAtMs: Date.now() }, null, 0);
  fs.writeFileSync(p, payload, "utf8");
}

function getEffectiveLiveRange() {
  const env = process.env.GOOGLE_SHEET_LIVE_RANGE && String(process.env.GOOGLE_SHEET_LIVE_RANGE).trim();
  const fromFile = readLiveSheetRangeOverride();

  /** 상태 JSON은 “어느 탭에 쓸지”만 기억하고, A1·행 개수 등은 .env LIVE와 맞춤(예전에 A40으로 저장돼 영원히 밀리는 문제 방지). */
  if (fromFile && env && env.includes("!")) {
    const stateTitle = getSheetTitleFromRange(fromFile, "").trim();
    if (stateTitle) {
      const span = getA1SpanFromLiveRange(env);
      return makeQuotedSheetRange(stateTitle, span);
    }
  }

  if (fromFile) {
    return fromFile;
  }

  return env || null;
}

/**
 * 마감 후 탭 복제 시 **원본으로 삼을 시트** 범위.
 * `.env`의 `GOOGLE_SHEET_LIVE_RANGE`가 있으면 항상 그 탭(마스터·서식 템플릿)을 복제하고,
 * 없을 때만 현재 effective(상태 파일 또는 env)를 씁니다.
 * — 상태 JSON이 날짜 탭만 가리킬 때 복제 원본이 빈 탭이 되는 문제를 막습니다.
 */
function getLiveSheetDuplicateSourceRange() {
  const env = process.env.GOOGLE_SHEET_LIVE_RANGE && String(process.env.GOOGLE_SHEET_LIVE_RANGE).trim();
  if (env && env.includes("!")) {
    return env;
  }
  return getEffectiveLiveRange();
}

function isLiveSheetRotateOnCloseEnabled() {
  const v = String(process.env.SCHEDULE_LIVE_SHEET_ROTATE_ON_CLOSE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function getA1SpanFromLiveRange(liveRange) {
  const s = String(liveRange || "").trim();
  const b = s.indexOf("!");
  const rest = b >= 0 ? s.slice(b + 1).trim() : s;
  if (!rest) {
    return "A1:K50";
  }
  if (!rest.includes(":")) {
    return `${rest}:${rest}`;
  }
  const parts = rest.split(":").map((x) => String(x || "").trim());
  const p1 = parseA1Cell(parts[0] || "A1");
  const p2 = parseA1Cell(parts[1] || parts[0] || "A1");
  if (p1 && p2) {
    return rest;
  }
  /** `A:Z` 같이 행 번호가 없으면 앵커·clear 계산이 깨짐 → A1…로 보정 */
  const m1 = (parts[0] || "A").match(/^([A-Za-z]+)/);
  const m2 = (parts[1] || "K").match(/^([A-Za-z]+)/);
  const c1 = (m1 && m1[1] ? m1[1] : "A").toUpperCase();
  const c2 = (m2 && m2[1] ? m2[1] : "K").toUpperCase();
  return `${c1}1:${c2}500`;
}

/** 로테이트 직후 `values.clear` 세로 끝(1-based): LIVE span 아래쪽 행과 `clearRows` 중 큰 값. */
function getClearValuesBottomRow1FromA1Span(a1Span, minBottomRow1) {
  const span = String(a1Span || "A1:K50").trim();
  const [rawL, rawR] = span.includes(":") ? span.split(":").map((x) => x.trim()) : [span, span];
  const p1 = parseA1Cell(rawL) || { row: 1 };
  const p2 = parseA1Cell(rawR) || p1;
  const spanBottom = Math.max(p1.row, p2.row);
  return Math.max(1, spanBottom, Number(minBottomRow1) || 1);
}

function makeQuotedSheetRange(sheetTitle, a1Span) {
  const esc = String(sheetTitle).replace(/'/g, "''");
  return `'${esc}'!${a1Span}`;
}

function findSheetByTitleLoose(sheetsList, wantedTitle) {
  const list = sheetsList || [];
  const raw = String(wantedTitle || "").trim();
  if (!raw) {
    return null;
  }
  const exact = list.find((s) => String(s.properties?.title || "").trim() === raw);
  if (exact) {
    return exact;
  }
  const low = raw.toLowerCase();
  return list.find((s) => String(s.properties?.title || "").trim().toLowerCase() === low) || null;
}

function buildRowDataForUserEnteredGrid(rows2d) {
  const colCount = getScheduleGridColumnCount();
  return (rows2d || []).map((row) => ({
    values: Array.from({ length: colCount }, (_, i) => ({
      userEnteredValue: {
        stringValue: String(row && row[i] !== undefined && row[i] !== null ? row[i] : ""),
      },
    })),
  }));
}

async function sheetsGetSheetIdByTitle(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const sh = findSheetByTitleLoose(meta.data.sheets || [], sheetTitle);
  if (sh?.properties?.sheetId === undefined || sh?.properties?.sheetId === null) {
    return null;
  }
  return sh.properties.sheetId;
}

/** `values.clear` / `values.update` 가 한글 탭 A1 문자열을 파싱 못 할 때 — `sheetId` + `updateCells`. 행·열은 0-based 그리드 인덱스. */
async function sheetsOverwriteUserEnteredGridFromA1(
  sheets,
  spreadsheetId,
  sheetId,
  rows2d,
  startRowIndex0 = 0,
  startColumnIndex0 = 0
) {
  if (!rows2d || rows2d.length === 0) {
    return;
  }
  const colCount = getScheduleGridColumnCount();
  const rowData = buildRowDataForUserEnteredGrid(rows2d);
  const startR = Math.max(0, Number(startRowIndex0) || 0);
  const startC = Math.max(0, Number(startColumnIndex0) || 0);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            range: {
              sheetId,
              startRowIndex: startR,
              endRowIndex: startR + rows2d.length,
              startColumnIndex: startC,
              endColumnIndex: startC + colCount,
            },
            rows: rowData,
            fields: "userEnteredValue",
          },
        },
      ],
    },
  });
}

/** 고정 헤더 시트: 참가자별 블록만 `updateCells`(헤더 행은 건드리지 않음). */
async function sheetsWriteLiveSyncFixedParticipantBlocks(sheets, spreadsheetId, sheetId, groups, liveRange) {
  const firstDataRow1 = getLiveSyncDataStartRow1FromLiveRange(liveRange);
  const br = getLiveSyncTemplateBlockRowCount();
  const colCount = getScheduleGridColumnCount();
  if (br < TIME_SLOTS.length + 1) {
    console.warn("[실시간시트] TEMPLATE_BLOCK_ROWS 가 너무 작음 — 최소", TIME_SLOTS.length + 1);
  }
  const requests = (groups || []).map((rows, u) => {
    const startR = Math.max(0, firstDataRow1 - 1 + u * br);
    const rowData = buildRowDataForUserEnteredGrid(rows);
    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: startR,
          endRowIndex: startR + rows.length,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        rows: rowData,
        fields: "userEnteredValue",
      },
    };
  });
  if (requests.length === 0) {
    return;
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

async function rotateLiveWorksheetAfterClose(session) {
  if (!isLiveSheetRotateOnCloseEnabled()) {
    return;
  }
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const base = getEffectiveLiveRange();
  if (!spreadsheetId || !base) {
    console.warn("[시트탭로테이트] GOOGLE_SPREADSHEET_ID 또는 실시간 범위(.env 또는 상태 파일)가 없어 건너뜁니다.");
    return;
  }
  const dupSourceRange = getLiveSheetDuplicateSourceRange();
  if (!dupSourceRange) {
    console.warn("[시트탭로테이트] 복제 원본 범위를 정하지 못했습니다.");
    return;
  }
  const sheets = await getSheetsClient();
  if (!sheets) {
    return;
  }
  const a1Span = getA1SpanFromLiveRange(dupSourceRange);
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const sheetsList = meta.data.sheets || [];
  const titles = new Set(sheetsList.map((s) => s.properties?.title).filter(Boolean));
  const src = session.createdAt ? session : { ...session, createdAt: Date.now() };
  const { voteStartIso } = getVoteWindowIsoForSession(src);
  const iso =
    voteStartIso && /^\d{4}-\d{2}-\d{2}$/.test(String(voteStartIso).trim())
      ? String(voteStartIso).trim()
      : formatCalendarDateInTz(Date.now(), SCHEDULE_TZ);
  /** 탭 이름은 ASCII만(투표 시작 수요일 `YYYYMMDD`) — 한글 탭명으로 API·메타 매칭 꼬임 방지 */
  const ymdDigits = iso.replace(/-/g, "").replace(/\D/g, "").slice(0, 8) || "00000000";
  let baseTitle = ymdDigits.replace(/[\[\]\*\?\/\\:]/g, "_").slice(0, 90);
  let newTitle = baseTitle;
  let n = 0;
  while (titles.has(newTitle)) {
    n += 1;
    newTitle = `${baseTitle}_${n}`.slice(0, 100);
  }

  const sourceTitle = getSheetTitleFromRange(dupSourceRange, "Sheet1");
  const sourceSheet = findSheetByTitleLoose(sheetsList, sourceTitle);
  const sourceSheetId = sourceSheet?.properties?.sheetId;
  let finalTitle = newTitle;

  if (sourceSheetId === undefined || sourceSheetId === null) {
    const available = sheetsList.map((s) => s.properties?.title).filter(Boolean);
    console.warn(
      `[시트탭로테이트] 소스 시트 이름을 찾지 못했습니다. LIVE 범위에서 읽은 이름: "${sourceTitle}". ` +
        `스프레드시트 탭 목록: ${available.length ? available.join(", ") : "(없음)"} — 빈 탭으로 만듭니다.`
    );
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: newTitle,
                gridProperties: { rowCount: 200, columnCount: 30 },
              },
            },
          },
        ],
      },
    });
    finalTitle = newTitle;
  } else {
    try {
      const dupRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              duplicateSheet: {
                sourceSheetId,
                newSheetName: newTitle,
              },
            },
          ],
        },
      });
      const r0 = dupRes.data?.replies?.[0];
      const dupProps = r0?.duplicateSheet?.properties;
      if (dupProps && typeof dupProps.title === "string" && dupProps.title.trim()) {
        finalTitle = dupProps.title.trim();
      }
      if (!r0?.duplicateSheet) {
        console.warn(
          "[시트탭로테이트] duplicateSheet API 응답에 duplicateSheet 필드가 없습니다. replies[0]=",
          JSON.stringify(r0)
        );
      } else {
        console.log(
          `[시트탭로테이트] 시트 복제 성공: "${sourceSheet.properties?.title}" → "${finalTitle}" (sheetId ${dupProps?.sheetId ?? "?"})`
        );
      }
    } catch (dupErr) {
      const apiData = dupErr && dupErr.response && dupErr.response.data;
      console.warn(
        "[시트탭로테이트] 시트 복제(duplicateSheet) 실패 — 빈 탭으로 대체:",
        dupErr?.message || dupErr,
        apiData ? JSON.stringify(apiData) : ""
      );
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: newTitle,
                  gridProperties: { rowCount: 200, columnCount: 30 },
                },
              },
            },
          ],
        },
      });
      finalTitle = newTitle;
    }
  }

  const newRangeQuoted = makeQuotedSheetRange(finalTitle, a1Span);
  /** 마스터 복제본에 예전 참가자 블록이 50행 아래까지 남는 문제: 마감 직후 clear는 최소 500행(또는 ROTATE 전용 env). */
  const legacyClear = Math.max(1, Number.parseInt(process.env.SCHEDULE_LIVE_SHEET_CLEAR_MAX_ROWS ?? "50", 10) || 50);
  const rotateExplicit = Number.parseInt(String(process.env.SCHEDULE_LIVE_SHEET_ROTATE_CLEAR_MAX_ROWS ?? "").trim(), 10);
  const clearRows = Math.min(
    2000,
    Number.isFinite(rotateExplicit) && rotateExplicit > 0
      ? rotateExplicit
      : Math.max(legacyClear, 500)
  );
  try {
    const metaAfter = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    });
    const newSh = findSheetByTitleLoose(metaAfter.data.sheets || [], finalTitle);
    const newSid = newSh?.properties?.sheetId;
    if (newSid === undefined || newSid === null) {
      console.warn("[시트탭로테이트] 복제 탭 sheetId 조회 실패:", finalTitle);
    } else {
      const spanForClear = getA1SpanFromLiveRange(dupSourceRange);
      const endColLetter = a1IndexToColumnLetters(getScheduleGridColumnCount());
      const clearBottom1 = Math.min(2000, getClearValuesBottomRow1FromA1Span(spanForClear, clearRows));
      const br = getLiveSyncTemplateBlockRowCount();
      const tr = TIME_SLOTS.length;
      const firstDataRow1 = getLiveSyncDataStartRow1FromLiveRange(getEffectiveLiveRange() || dupSourceRange);
      try {
        if (isLiveSyncFixedSheetHeadersEnabled()) {
          const ranges = [];
          for (let u = 0; ; u += 1) {
            const dataTop1 = firstDataRow1 + u * br;
            if (dataTop1 > clearBottom1) {
              break;
            }
            const dataBot1 = Math.min(dataTop1 + tr - 1, clearBottom1);
            ranges.push(makeQuotedSheetRange(finalTitle, `A${dataTop1}:${endColLetter}${dataBot1}`));
          }
          if (ranges.length === 0) {
            console.warn("[시트탭로테이트] 고정헤더: 비울 데이터 구간 없음");
          } else {
            await sheets.spreadsheets.values.batchClear({
              spreadsheetId,
              requestBody: { ranges },
            });
            console.log("[시트탭로테이트] 복제 탭 데이터칸만 batchClear(헤더 유지):", ranges.length, "구간");
          }
        } else {
          const clearRangeQuoted = makeQuotedSheetRange(finalTitle, `A1:${endColLetter}${clearBottom1}`);
          await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: clearRangeQuoted,
          });
          console.log("[시트탭로테이트] 복제 탭 조율칸만 클리어(A~K, N~U 유지):", clearRangeQuoted);
        }
      } catch (clearValErr) {
        console.warn(
          "[시트탭로테이트] values.clear/batchClear 실패, grid로 비움:",
          clearValErr?.message || clearValErr
        );
        const colCount = getScheduleGridColumnCount();
        if (isLiveSyncFixedSheetHeadersEnabled()) {
          for (let u = 0; ; u += 1) {
            const dataTop1 = firstDataRow1 + u * br;
            if (dataTop1 > clearBottom1) {
              break;
            }
            const n = Math.min(tr, clearBottom1 - dataTop1 + 1);
            const blank = Array.from({ length: n }, () => Array(colCount).fill(""));
            await sheetsOverwriteUserEnteredGridFromA1(sheets, spreadsheetId, newSid, blank, dataTop1 - 1, 0);
          }
        } else {
          const blank = Array.from({ length: clearRows }, () => Array(colCount).fill(""));
          await sheetsOverwriteUserEnteredGridFromA1(sheets, spreadsheetId, newSid, blank);
        }
      }
    }
  } catch (clearErr) {
    console.warn("[시트탭로테이트] 복제 탭 값 비우기(grid) 실패(다음 동기화에서 덮어씀):", clearErr?.message || clearErr);
  }

  writeLiveSheetRangeOverride(newRangeQuoted);
  console.log(
    `[시트탭로테이트] 복제 원본 "${sourceTitle}" → 새 탭 "${finalTitle}" 초기화 후 실시간 범위: ${newRangeQuoted} (상태: ${getLiveSheetStatePath()})`
  );
}

/**
 * 마감 집계가 붙을 시트 범위(기본 규칙).
 * - `GOOGLE_SHEET_APPEND_RANGE` 가 있으면 그대로(고정 아카이브 탭 등).
 * - 아니면 **실시간 조율이 쓰는 탭**(`getEffectiveLiveRange`의 탭 이름 + `!A:Z`) — `GOOGLE_SHEET_RANGE`와 다를 때 마스터 맨 아래에 쌓이던 문제를 막음.
 * - 실시간 범위가 없을 때만 `GOOGLE_SHEET_RANGE`.
 *
 * 마감 시에는 로테이트 전에 이 값을 한 번 구해 두었다가(`appendRangeFrozen`) 탭 전환 후에도 **같은 문자열**로 append 해야, 집계가 방금 마감한 주의 실시간 탭(예: `20260520`) 하단에 붙음.
 */
function resolveDefaultAppendSpreadsheetRange() {
  const custom = process.env.GOOGLE_SHEET_APPEND_RANGE && String(process.env.GOOGLE_SHEET_APPEND_RANGE).trim();
  if (custom) {
    return custom;
  }
  const live = getEffectiveLiveRange();
  if (live && live.includes("!")) {
    const title = getSheetTitleFromRange(live, "Sheet1");
    const esc = String(title).replace(/'/g, "''");
    return `'${esc}'!A:Z`;
  }
  return process.env.GOOGLE_SHEET_RANGE || "Sheet1!A:Z";
}

/** @param {string | undefined} appendRangeFrozen 마감 처리 중 로테이트 전에 `resolveDefaultAppendSpreadsheetRange()` 로 고정한 범위 */
async function appendSessionSummaryToSheet(session, closedAtMs, appendRangeFrozen) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return;
  }

  const sheets = await getSheetsClient();
  if (!sheets) {
    return;
  }

  const range =
    appendRangeFrozen !== undefined && appendRangeFrozen !== null && String(appendRangeFrozen).trim()
      ? String(appendRangeFrozen).trim()
      : resolveDefaultAppendSpreadsheetRange();
  console.log("[시트 마감 집계] append 범위:", range);
  const sheetTitle = getSheetTitleFromRange(range, "Sheet1");
  const rows = buildSheetRowsForSession(session);

  const appendResult = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: rows,
    },
  });
  const updatedRange = appendResult.data?.updates?.updatedRange || "";
  const startRowMatch = updatedRange.match(/![A-Z]+(\d+):/);
  const startRow1 = startRowMatch ? Number.parseInt(startRowMatch[1], 10) : NaN;
  if (!Number.isFinite(startRow1)) {
    console.warn("Google Sheets 병합 스킵: append 시작 행을 파싱하지 못했습니다.", updatedRange);
    return;
  }

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title),conditionalFormats)",
  });
  const targetSheet = findSheetByTitleLoose(meta.data.sheets || [], sheetTitle);
  const sheetId = targetSheet?.properties?.sheetId;
  if (sheetId === undefined) {
    return;
  }

  const requests = [];
  const conditionalRules = targetSheet.conditionalFormats || [];
  for (let i = conditionalRules.length - 1; i >= 0; i--) {
    requests.push({
      deleteConditionalFormatRule: {
        sheetId,
        index: i,
      },
    });
  }
  const appendStartRow0 = startRow1 - 1;
  const totalCols = 4 + DAYS.length;
  const totalRows = rows.length;

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: appendStartRow0,
        endRowIndex: appendStartRow0 + 1,
        startColumnIndex: 0,
        endColumnIndex: totalCols,
      },
      cell: {
        userEnteredFormat: {
          textFormat: {
            bold: true,
            foregroundColor: { red: 0.16, green: 0.42, blue: 0.98 },
          },
          horizontalAlignment: "CENTER",
        },
      },
      fields:
        "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.horizontalAlignment",
    },
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: appendStartRow0 + 1,
        endRowIndex: appendStartRow0 + totalRows,
        startColumnIndex: 0,
        endColumnIndex: totalCols,
      },
      cell: {
        userEnteredFormat: {
          textFormat: {
            bold: false,
            foregroundColor: { red: 0, green: 0, blue: 0 },
            foregroundColorStyle: {
              rgbColor: { red: 0, green: 0, blue: 0 },
            },
          },
          horizontalAlignment: "CENTER",
        },
      },
      fields: "userEnteredFormat",
    },
  });

  requests.push({
    updateBorders: {
      range: {
        sheetId,
        startRowIndex: appendStartRow0,
        endRowIndex: appendStartRow0 + totalRows,
        startColumnIndex: 0,
        endColumnIndex: totalCols,
      },
      top: { style: "SOLID", width: 1 },
      bottom: { style: "SOLID", width: 1 },
      left: { style: "SOLID", width: 1 },
      right: { style: "SOLID", width: 1 },
      innerHorizontal: { style: "SOLID", width: 1 },
      innerVertical: { style: "SOLID", width: 1 },
    },
  });

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

async function syncSessionSummaryToLiveSheet(session) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const liveRange = getEffectiveLiveRange();
  if (!spreadsheetId || !liveRange) {
    return;
  }

  const sheets = await getSheetsClient();
  if (!sheets) {
    return;
  }

  const sheetTitle = getSheetTitleFromRange(liveRange, "Sheet1");
  const sheetId = await sheetsGetSheetIdByTitle(sheets, spreadsheetId, sheetTitle);
  if (sheetId === null || sheetId === undefined) {
    console.error("[실시간시트] 탭을 찾지 못함:", sheetTitle);
    return;
  }
  if (isLiveSyncFixedSheetHeadersEnabled()) {
    const groups = buildLiveSyncParticipantGroups(session);
    const firstData1 = getLiveSyncDataStartRow1FromLiveRange(liveRange);
    const br = getLiveSyncTemplateBlockRowCount();
    console.log(
      "[실시간시트] grid.update(고정헤더):",
      sheetTitle,
      `sheetId=${sheetId}`,
      `참가자블록=${groups.length}`,
      `첫데이터행(1-based)=${firstData1}`,
      `블록행수=${br}`,
      "startCol=A(고정)"
    );
    try {
      await sheetsWriteLiveSyncFixedParticipantBlocks(sheets, spreadsheetId, sheetId, groups, liveRange);
    } catch (e) {
      console.error("[실시간시트] 고정헤더 batchUpdate 실패:", e?.message || e, e?.response?.data || "");
      throw e;
    }
    console.log("[실시간시트] 동기화 완료 (고정헤더·블록):", sheetTitle, groups.length);
    return;
  }

  const rows = buildSheetRowsForSession(session);
  const startRowIndex0 = getLiveSyncDataStartRow1FromLiveRange(liveRange) - 1;
  const startColumnIndex0 = 0;
  console.log(
    "[실시간시트] grid.update:",
    sheetTitle,
    `sheetId=${sheetId}`,
    `rows=${rows.length}`,
    `startRowIndex0=${startRowIndex0}(행${startRowIndex0 + 1})`,
    "startCol=A(고정)"
  );
  try {
    await sheetsOverwriteUserEnteredGridFromA1(sheets, spreadsheetId, sheetId, rows, startRowIndex0, startColumnIndex0);
  } catch (e) {
    console.error("[실시간시트] grid updateCells 실패:", e?.message || e, e?.response?.data || "");
    throw e;
  }
  console.log("[실시간시트] 동기화 완료 (grid):", sheetTitle, rows.length);
}

function scheduleLiveSheetSync(session) {
  const sessionId = session.id;
  const prev = liveSyncTimers.get(sessionId);
  if (prev) {
    clearTimeout(prev);
  }
  const timer = setTimeout(() => {
    liveSyncTimers.delete(sessionId);
    syncSessionSummaryToLiveSheet(session).catch((error) => {
      console.error("[실시간시트] 동기화 실패:", error?.message || error);
    });
  }, 800);
  liveSyncTimers.set(sessionId, timer);
}

function getScheduleSheetUserMapFromEnv() {
  const raw = process.env.SCHEDULE_SHEET_USER_MAP;
  if (!raw || !String(raw).trim()) {
    return {};
  }
  try {
    const j = JSON.parse(raw);
    if (typeof j !== "object" || j === null || Array.isArray(j)) {
      return {};
    }
    return j;
  } catch {
    return {};
  }
}

function rowStrings(row) {
  return (row || []).map((c) =>
    String(c ?? "")
      .replace(/^\uFEFF/, "")
      .trim()
  );
}

function isScheduleSheetHeaderRowCells(cells) {
  return cells[0] === "참여자" && cells[1] === "시작일" && cells[2] === "마감일";
}

/** 시트·세션 라벨 비교용(공백·호환 문자 정리) */
function normalizeVoteDateLabel(s) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/\s+/g, " ")
    .normalize("NFKC");
}

function pad2(n) {
  return String(Math.trunc(n)).padStart(2, "0");
}

/**
 * 시트 시작일·마감일 셀(한국어 표시, ISO 문자열, 스프레드시트 날짜 숫자 등)을
 * `getVoteWindowIsoForSession` 과 같은 **Asia/Seoul 달력 `YYYY-MM-DD`** 로 맞춤.
 */
function coerceSheetDateCellToIsoYmd(cell) {
  if (cell === undefined || cell === null || cell === "") {
    return null;
  }
  if (typeof cell === "number" && Number.isFinite(cell)) {
    const whole = Math.trunc(cell);
    if (whole < 20000 || whole > 100000) {
      return null;
    }
    const epochMs = Date.UTC(1899, 11, 30);
    const ms = epochMs + whole * 86400000;
    return formatCalendarDateInTz(ms, SCHEDULE_TZ);
  }

  let s = String(cell)
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\u00a0|\u202f/g, " ")
    .normalize("NFKC");
  if (!s) {
    return null;
  }

  const isoTight = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoTight) {
    return `${isoTight[1]}-${isoTight[2]}-${isoTight[3]}`;
  }

  const western = s.match(/^(\d{4})[.\s/~-]+(\d{1,2})[.\s/~-]+(\d{1,2})\b/);
  if (western) {
    const y = Number(western[1]);
    const mo = Number(western[2]);
    const d = Number(western[3]);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }
  }

  const kr = s.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (kr) {
    const y = Number(kr[1]);
    const mo = Number(kr[2]);
    const d = Number(kr[3]);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }
  }

  const onlyNum = s.replace(/,/g, ".").match(/^(\d+)(?:\.(\d+))?$/);
  if (onlyNum && !s.includes("-") && !s.includes("년")) {
    const serial = Number.parseFloat(onlyNum[0]);
    if (Number.isFinite(serial)) {
      const whole = Math.trunc(serial);
      if (whole >= 20000 && whole <= 100000) {
        const epochMs = Date.UTC(1899, 11, 30);
        const ms = epochMs + whole * 86400000;
        return formatCalendarDateInTz(ms, SCHEDULE_TZ);
      }
    }
  }

  return null;
}

function isSheetMarkO(cell) {
  const raw = String(cell ?? "").trim();
  if (!raw) {
    return false;
  }
  if (raw === true || raw === 1) {
    return true;
  }
  const u = raw.normalize("NFKC").toUpperCase();
  if (u === "O" || u === "Y" || u === "TRUE" || u === "1" || u === "V" || u === "ON" || u === "OK") {
    return true;
  }
  if (u === "✓" || u === "✔" || u === "☑" || u === "✅") {
    return true;
  }
  const n = u.replace(/\s/g, "");
  if (n === "O" || n === "Y" || n === "TRUE" || n === "1") {
    return true;
  }
  const circle = raw.normalize("NFKC");
  return circle === "○" || circle === "⭕" || circle === "●" || circle === "◯";
}

/**
 * 실시간 시트 값 → 참가자 블록. `buildSheetRowsForSession` 출력과 동일한 표 형식을 가정합니다.
 * @returns {{ startLabel: string; endLabel: string; blocks: Array<{ displayName: string; selectedDayTimes: Map<string, Set<string>> }>; explicitEmpty: boolean } | null}
 */
function parseLiveSheetValuesToParticipants(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const blocks = [];
  let explicitEmpty = false;
  let sheetStart = null;
  let sheetEnd = null;

  let curName = null;
  let curStart = null;
  let curEnd = null;
  /** @type {Map<string, Set<string>>} */
  const curMap = new Map();
  const timeSet = new Set(TIME_SLOTS);

  function flush() {
    if (curName === "참여자 없음") {
      explicitEmpty = true;
      sheetStart = curStart;
      sheetEnd = curEnd;
      curName = null;
      curStart = null;
      curEnd = null;
      curMap.clear();
      return;
    }
    if (!curName) {
      curMap.clear();
      curStart = null;
      curEnd = null;
      return;
    }
    const dayTimes = new Map();
    for (const [k, s] of curMap) {
      dayTimes.set(k, new Set(s));
    }
    blocks.push({
      displayName: curName,
      startLabel: curStart,
      endLabel: curEnd,
      selectedDayTimes: dayTimes,
    });
    if (!sheetStart && curStart && curEnd) {
      sheetStart = curStart;
      sheetEnd = curEnd;
    }
    curName = null;
    curStart = null;
    curEnd = null;
    curMap.clear();
  }

  let i = 0;
  if (values[0] && isScheduleSheetHeaderRowCells(rowStrings(values[0]))) {
    i = 1;
  }

  for (; i < values.length; i++) {
    const cells = rowStrings(values[i]);
    if (cells.every((x) => !x)) {
      continue;
    }
    if (isScheduleSheetHeaderRowCells(cells)) {
      flush();
      continue;
    }

    const c0 = cells[0];
    const c1 = cells[1];
    const c2 = cells[2];
    const time = cells[3];

    if (c0 === "참여자 없음") {
      flush();
      curName = "참여자 없음";
      curStart = c1;
      curEnd = c2;
      flush();
      continue;
    }

    if (!timeSet.has(time)) {
      continue;
    }

    if (c0) {
      flush();
      curName = c0;
      curStart = c1;
      curEnd = c2;
    } else if (!curName) {
      continue;
    }

    for (let d = 0; d < DAYS.length; d++) {
      if (isSheetMarkO(cells[4 + d])) {
        const dk = DAYS[d].key;
        if (!curMap.has(dk)) {
          curMap.set(dk, new Set());
        }
        curMap.get(dk).add(time);
      }
    }
  }
  flush();

  const startLabel = blocks[0]?.startLabel ?? sheetStart;
  const endLabel = blocks[0]?.endLabel ?? sheetEnd;
  if (!startLabel || !endLabel) {
    return null;
  }

  return {
    startLabel,
    endLabel,
    blocks: explicitEmpty && blocks.length === 0 ? [] : blocks,
    explicitEmpty,
  };
}

function sessionVoteWindowLabelsMatchSheet(session, startLabel, endLabel) {
  const sourceSession = session.createdAt ? session : { ...session, createdAt: Date.now() };
  const { voteStartIso, voteEndIso } = getVoteWindowIsoForSession(sourceSession);
  const sheetStartIso = coerceSheetDateCellToIsoYmd(startLabel);
  const sheetEndIso = coerceSheetDateCellToIsoYmd(endLabel);
  if (sheetStartIso && sheetEndIso) {
    return sheetStartIso === voteStartIso && sheetEndIso === voteEndIso;
  }
  const a = normalizeVoteDateLabel(formatIsoYmdForBoard(voteStartIso));
  const b = normalizeVoteDateLabel(formatIsoYmdForBoard(voteEndIso));
  return a === normalizeVoteDateLabel(startLabel) && b === normalizeVoteDateLabel(endLabel);
}

function normalizePersonLabelForMatch(s) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .normalize("NFKC")
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/\s+/g, " ");
}

/** 괄호 앞·# 앞·슬래시 구간·첫 단어 등으로 시트↔디스코드 표시명 비교 */
function personLabelVariants(label) {
  const n = normalizePersonLabelForMatch(label);
  const set = new Set();
  if (!n) {
    return set;
  }
  set.add(n);
  const noParen = n.replace(/\s*[\(\[\{].*$/u, "").trim();
  if (noParen) {
    set.add(noParen);
  }
  const noHash = n.split("#")[0].trim();
  if (noHash) {
    set.add(noHash);
  }
  if (n.includes("/")) {
    for (const part of n.split("/")) {
      const p = part.trim();
      if (!p) {
        continue;
      }
      set.add(p);
      const pp = p.replace(/\s*[\(\[\{].*$/u, "").trim();
      if (pp) {
        set.add(pp);
      }
      const firstTok = p.split(/\s+/)[0];
      if (firstTok && firstTok.length >= 2) {
        set.add(firstTok);
      }
    }
  }
  return set;
}

/** 길드 멤버 인덱스 매칭: 더 구체적인(긴) 라벨을 먼저 시도 */
function personLabelVariantListOrdered(label) {
  const arr = [...personLabelVariants(label)];
  arr.sort((a, b) => {
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    return a.localeCompare(b);
  });
  return arr;
}

function extractSnowflakeIdFromText(s) {
  const str = String(s ?? "");
  const matches = str.match(/(?<![0-9])(\d{17,20})(?![0-9])/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1];
}

function labelsMatchLoosely(sheetLabel, sessionLabel) {
  const sheetVars = personLabelVariants(sheetLabel);
  const sessVars = personLabelVariants(sessionLabel);
  for (const a of sheetVars) {
    if (sessVars.has(a)) {
      return true;
    }
  }
  return false;
}

function isGuildMemberSheetResolveEnabled() {
  const raw = process.env.SCHEDULE_SHEET_RESOLVE_GUILD_MEMBERS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "false" || s === "off" || s === "no") {
    return false;
  }
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

/**
 * @param {import("discord.js").Guild} guild
 * @returns {Map<string, Set<string>>}
 */
function buildGuildMemberLabelToUserIdsMap(guild) {
  /** @type {Map<string, Set<string>>} */
  const labelToIds = new Map();
  function addLabelVariants(displayStr, userId) {
    const base = String(displayStr ?? "").trim();
    if (!base || base.length < 2) {
      return;
    }
    for (const v of personLabelVariants(base)) {
      if (v.length < 2) {
        continue;
      }
      if (!labelToIds.has(v)) {
        labelToIds.set(v, new Set());
      }
      labelToIds.get(v).add(userId);
    }
  }

  for (const m of guild.members.cache.values()) {
    if (m.user.bot) {
      continue;
    }
    const uid = m.id;
    addLabelVariants(m.displayName, uid);
    if (m.nickname) {
      addLabelVariants(m.nickname, uid);
    }
    addLabelVariants(m.user.username, uid);
    if (m.user.globalName) {
      addLabelVariants(m.user.globalName, uid);
    }
  }
  return labelToIds;
}

/** @returns {Promise<Map<string, Set<string>> | null>} */
async function fetchGuildMemberLabelIndex(client) {
  const guildId = process.env.GUILD_ID ? String(process.env.GUILD_ID).trim() : "";
  if (!guildId) {
    return null;
  }
  const guild =
    client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    return null;
  }
  try {
    await guild.members.fetch();
  } catch (e) {
    console.warn(
      "[시트→멤버] members.fetch 실패 — Discord 개발자 포털에서 **Privileged Gateway: Server Members Intent** 를 켜 주세요:",
      e?.message || e
    );
    return null;
  }
  const map = buildGuildMemberLabelToUserIdsMap(guild);
  console.log(`[시트→멤버] 길드 "${guild.name}" 멤버 ${guild.members.cache.size}명 기준 표시명 인덱스 생성`);
  return map;
}

async function getGuildMemberLabelIndexForSheetImport(client) {
  if (!isGuildMemberSheetResolveEnabled()) {
    return null;
  }
  const now = Date.now();
  if (
    guildMemberLabelIndexCache.map &&
    now - guildMemberLabelIndexCache.atMs < GUILD_MEMBER_LABEL_INDEX_TTL_MS
  ) {
    return guildMemberLabelIndexCache.map;
  }
  const map = await fetchGuildMemberLabelIndex(client);
  if (map) {
    guildMemberLabelIndexCache = { map, atMs: now };
  }
  return map;
}

function tryResolveSheetNameViaGuildMemberIndex(raw, memberLabelIndex) {
  if (!memberLabelIndex) {
    return null;
  }
  for (const v of personLabelVariantListOrdered(raw)) {
    const ids = memberLabelIndex.get(v);
    if (ids && ids.size === 1) {
      return [...ids][0];
    }
  }
  return null;
}

function resolveSheetParticipantToUserId(displayNameRaw, session, memberLabelIndex) {
  const raw = String(displayNameRaw ?? "").trim();
  if (!raw || raw === "참여자 없음") {
    return null;
  }
  if (/^\d{17,20}$/.test(raw)) {
    return raw;
  }
  const pipe = raw.indexOf("|");
  if (pipe >= 0) {
    const right = raw.slice(pipe + 1).trim();
    if (/^\d{17,20}$/.test(right)) {
      return right;
    }
  }
  const slashIdx = raw.indexOf("/");
  if (slashIdx >= 0) {
    const right = raw.slice(slashIdx + 1).trim();
    if (/^\d{17,20}$/.test(right)) {
      return right;
    }
    const idInRight = extractSnowflakeIdFromText(right);
    if (idInRight) {
      return idInRight;
    }
  }
  const embedded = extractSnowflakeIdFromText(raw);
  if (embedded) {
    return embedded;
  }
  const envMap = getScheduleSheetUserMapFromEnv();
  const fromMap = envMap[raw];
  if (fromMap != null && /^\d{17,20}$/.test(String(fromMap).trim())) {
    return String(fromMap).trim();
  }
  const rawVars = personLabelVariants(raw);
  for (const [key, val] of Object.entries(envMap)) {
    if (key === raw) {
      continue;
    }
    if (
      labelsMatchLoosely(raw, key) &&
      val != null &&
      /^\d{17,20}$/.test(String(val).trim())
    ) {
      return String(val).trim();
    }
    const keyVars = personLabelVariants(key);
    for (const rv of rawVars) {
      if (keyVars.has(rv) && val != null && /^\d{17,20}$/.test(String(val).trim())) {
        return String(val).trim();
      }
    }
  }
  for (const [uid, ud] of session.users) {
    const uname = ud.username || "";
    if (!uname) {
      continue;
    }
    if (uname.trim() === raw) {
      return uid;
    }
    if (labelsMatchLoosely(raw, uname)) {
      return uid;
    }
  }
  const guildHit = tryResolveSheetNameViaGuildMemberIndex(raw, memberLabelIndex);
  if (guildHit) {
    return guildHit;
  }
  return null;
}

function displayNameForSheetParticipant(displayNameRaw, userId, session) {
  const raw = String(displayNameRaw ?? "").trim();
  const pipe = raw.indexOf("|");
  if (pipe >= 0) {
    const left = raw.slice(0, pipe).trim();
    if (left) {
      return left;
    }
  }
  const slash = raw.indexOf("/");
  if (slash >= 0) {
    const left = raw.slice(0, slash).trim();
    if (left) {
      return left;
    }
  }
  const sid = extractSnowflakeIdFromText(raw);
  if (sid && userId === sid) {
    const strip = raw
      .replace(new RegExp(`(?<![0-9])${sid}(?![0-9])`), "")
      .replace(/[/|]\s*$/g, "")
      .trim();
    if (strip) {
      return strip;
    }
  }
  return session.users.get(userId)?.username || raw;
}

function dayTimeMapsEqual(a, b) {
  const mapA = a instanceof Map ? a : new Map();
  const mapB = b instanceof Map ? b : new Map();
  const keysA = [...mapA.keys()].sort().join("\0");
  const keysB = [...mapB.keys()].sort().join("\0");
  if (keysA !== keysB) {
    return false;
  }
  for (const k of mapB.keys()) {
    const sa = [...(mapA.get(k) || [])].sort().join(",");
    const sb = [...(mapB.get(k) || [])].sort().join(",");
    if (sa !== sb) {
      return false;
    }
  }
  return true;
}

/** 시트 내용을 세션에 반영.
 * @returns {{ changed: boolean; blockCount: number; resolvedBlockCount: number; unresolvedNames: string[]; explicitEmpty: boolean }}
 */
function applyParsedLiveSheetToSession(session, parsed, memberLabelIndex) {
  if (parsed.explicitEmpty && parsed.blocks.length === 0) {
    let changed = false;
    for (const [, ud] of session.users) {
      const m = ud.selectedDayTimes;
      if (m instanceof Map && m.size > 0) {
        ud.selectedDayTimes = new Map();
        changed = true;
      }
    }
    return {
      changed,
      blockCount: 0,
      resolvedBlockCount: 0,
      unresolvedNames: [],
      explicitEmpty: true,
    };
  }

  let changed = false;
  const unresolved = new Set();
  let resolvedBlockCount = 0;
  const blockCount = parsed.blocks.length;

  for (const block of parsed.blocks) {
    const uid = resolveSheetParticipantToUserId(block.displayName, session, memberLabelIndex);
    if (!uid) {
      unresolved.add(block.displayName);
      continue;
    }
    resolvedBlockCount += 1;
    const displayName = displayNameForSheetParticipant(block.displayName, uid, session);
    getOrCreateUserData(session, uid, displayName);
    const ud = session.users.get(uid);
    const newMap = new Map();
    for (const [dk, set] of block.selectedDayTimes) {
      if (VALID_DAY_KEYS.has(dk)) {
        newMap.set(dk, new Set(set));
      }
    }
    if (!dayTimeMapsEqual(ud.selectedDayTimes, newMap)) {
      ud.selectedDayTimes = newMap;
      changed = true;
    }
    if (ud.username !== displayName) {
      ud.username = displayName;
      changed = true;
    }
  }

  if (unresolved.size > 0) {
    console.warn(
      "[실시간시트→디스코드] 참가자 ID를 알 수 없어 건너뜀(세션 닉·SCHEDULE_SHEET_USER_MAP·|ID·길드멤버표시명). A열:",
      [...unresolved].join(", ")
    );
  }

  return {
    changed,
    blockCount,
    resolvedBlockCount,
    unresolvedNames: [...unresolved],
    explicitEmpty: false,
  };
}

/**
 * 실시간 시트 범위(`getEffectiveLiveRange`)를 읽어, 투표 주간이 일치하는 활성 세션의 임베드·버튼을 갱신합니다.
 * @returns {{ matched: number; edited: number; parseError?: string; noEditDetail?: { changed: boolean; blockCount: number; resolvedBlockCount: number; unresolvedNames: string[]; explicitEmpty: boolean } }}
 */
async function importLiveSheetToDiscordSessions(client) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const liveRange = getEffectiveLiveRange();
  const out = { matched: 0, edited: 0, parseError: undefined, noEditDetail: null };

  if (!spreadsheetId || !liveRange) {
    out.parseError = "no_sheet_config";
    return out;
  }

  const sheets = await getSheetsClient();
  if (!sheets) {
    out.parseError = "no_sheets_client";
    return out;
  }

  const maxRows = Math.min(
    Math.max(20, Number.parseInt(process.env.SCHEDULE_SHEET_IMPORT_MAX_ROWS ?? "300", 10) || 300),
    2000
  );
  const readRangeQuoted = getLiveSyncValuesOnlyRange(liveRange, maxRows, "full", { forImport: true });
  const sheetTitleForRead = getSheetTitleFromRange(liveRange, "Sheet1");
  const endColRead = a1IndexToColumnLetters(getScheduleGridColumnCount());
  const topRow1Read = getLiveSyncReadTopRow1(liveRange);
  const readRangeUnquoted = `${sheetTitleForRead}!A${topRow1Read}:${endColRead}${topRow1Read + maxRows - 1}`;

  let values;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: readRangeQuoted,
      valueRenderOption: "FORMATTED_VALUE",
    });
    values = res.data.values;
  } catch (error) {
    try {
      const res2 = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: readRangeUnquoted,
        valueRenderOption: "FORMATTED_VALUE",
      });
      values = res2.data.values;
    } catch (e2) {
      console.warn("[실시간시트→디스코드] 시트 읽기 실패:", error?.message || error, "| 재시도:", e2?.message || e2);
      out.parseError = "fetch_failed";
      return out;
    }
  }

  const parsed = parseLiveSheetValuesToParticipants(values);
  if (!parsed) {
    out.parseError = "parse_failed";
    return out;
  }

  const memberLabelIndex = await getGuildMemberLabelIndexForSheetImport(client);

  const sessionsWithBoard = [...sessions.values()].filter((s) => s.messageId && s.channelId);
  if (sessionsWithBoard.length > 0 && parsed.startLabel && parsed.endLabel) {
    let anyLabelMatch = false;
    for (const session of sessionsWithBoard) {
      if (sessionVoteWindowLabelsMatchSheet(session, parsed.startLabel, parsed.endLabel)) {
        anyLabelMatch = true;
        break;
      }
    }
    if (!anyLabelMatch) {
      const sample = sessionsWithBoard[0];
      const src = sample.createdAt ? sample : { ...sample, createdAt: Date.now() };
      const { voteStartIso, voteEndIso } = getVoteWindowIsoForSession(src);
      const coS = coerceSheetDateCellToIsoYmd(parsed.startLabel);
      const coE = coerceSheetDateCellToIsoYmd(parsed.endLabel);
      console.warn(
        "[실시간시트→디스코드] 시트 시작/마감일과 조율판 세션이 안 맞음. 시트:",
        parsed.startLabel,
        "|",
        parsed.endLabel,
        coS && coE ? `(ISO ${coS} ~ ${coE})` : "(ISO로 해석 불가 — 셀 서식·표기 확인)",
        "→ 세션(첫 예시):",
        formatIsoYmdForBoard(voteStartIso),
        "|",
        formatIsoYmdForBoard(voteEndIso),
        `(${voteStartIso} ~ ${voteEndIso})`,
        "첫 참가자 행의 시작일·마감일을 조율판 투표 주와 같게 맞추세요."
      );
    }
  }

  for (const [sessionId, session] of sessions) {
    if (!session.messageId || !session.channelId) {
      continue;
    }
    if (!sessionVoteWindowLabelsMatchSheet(session, parsed.startLabel, parsed.endLabel)) {
      continue;
    }
    out.matched += 1;
    const applyResult = applyParsedLiveSheetToSession(session, parsed, memberLabelIndex);
    if (!applyResult.changed) {
      out.noEditDetail = applyResult;
      continue;
    }
    try {
      const channel = await client.channels.fetch(session.channelId);
      if (!channel || !channel.isTextBased()) {
        continue;
      }
      const msg = await channel.messages.fetch(session.messageId);
      await msg.edit({
        embeds: [buildSummaryEmbed(session)],
        components: buildComponents(sessionId, session),
      });
      out.edited += 1;
      scheduleLiveSheetSync(session);
    } catch (error) {
      console.warn("[실시간시트→디스코드] 메시지 수정 실패:", sessionId, error?.message || error);
    }
  }

  return out;
}

function findLatestSessionInChannel(channelId) {
  let latestSession = null;
  for (const session of sessions.values()) {
    if (session.channelId !== channelId || !session.messageId) {
      continue;
    }
    if (!latestSession || session.createdAt > latestSession.createdAt) {
      latestSession = session;
    }
  }
  return latestSession;
}

async function refreshScheduleBoardMessage(client, session) {
  if (!session?.messageId || !session?.channelId) {
    return;
  }
  try {
    const channel = await client.channels.fetch(session.channelId);
    if (!channel || !channel.isTextBased()) {
      return;
    }
    const msg = await channel.messages.fetch(session.messageId);
    await msg.edit({
      embeds: [buildSummaryEmbed(session)],
      components: buildComponents(session.id, session),
    });
    scheduleLiveSheetSync(session);
  } catch (error) {
    console.warn("[조율판 갱신] 메시지 수정 실패:", session.id, error?.message || error);
  }
}

async function closeSessionAndPublishSummary(client, session, logPrefix = "[마감]") {
  const { id: sessionId, channelId: chId, messageId } = session;
  const embed = buildClosedSummaryEmbed(session);

  try {
    const channel = await client.channels.fetch(chId);
    if (!channel || !channel.isTextBased()) {
      throw new Error("채널 없음");
    }
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ embeds: [embed], components: [] });
  } catch (error) {
    console.error(`${logPrefix} 마감 메시지 수정 실패, 채널에 집계만 전송 시도:`, error);
    try {
      const channel = await client.channels.fetch(chId);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
      }
    } catch (e2) {
      console.error(`${logPrefix} 집계 전송 실패:`, e2);
    }
  } finally {
    const pendingTimer = liveSyncTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      liveSyncTimers.delete(sessionId);
    }
    /** 로테이트로 `getEffectiveLiveRange()`가 바뀌기 전에, 집계를 붙일 탭을 고정 */
    const appendRangeFrozen = resolveDefaultAppendSpreadsheetRange();
    try {
      await rotateLiveWorksheetAfterClose(session);
    } catch (rotErr) {
      console.error(`${logPrefix} 실시간 시트 탭 전환 실패:`, rotErr);
    }
    try {
      await appendSessionSummaryToSheet(session, Date.now(), appendRangeFrozen);
    } catch (sheetError) {
      console.error(`${logPrefix} Google Sheets 기록 실패:`, sheetError);
    }
    sessions.delete(sessionId);
    if (weeklyAutoSession?.sessionId === sessionId) {
      weeklyAutoSession = null;
    }
  }
}

function formatBoardDate(ms) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(ms));
}

function formatIsoYmdForBoard(isoYmd) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  return formatBoardDate(utcNoon);
}

/** 기준일(수) 달력과 맞춘 연·월 라벨, 임베드 제목 등에 사용 */
function formatYearMonthLabelFromIsoYmd(isoYmd) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: SCHEDULE_TZ,
    year: "numeric",
    month: "long",
  }).format(new Date(utcNoon));
}

function getVoteWindowIsoForSession(session) {
  const postDayIso = formatCalendarDateInTz(session.createdAt, SCHEDULE_TZ);
  const thisBlockWednesdayIso = getWednesdayIsoContaining(postDayIso);
  /** 기본(/일정생성): 게시 블록 시작 수요일 +7일. 일정생성특수: +0일(게시 주의 수요일이 투표 주 시작). */
  const wednesdayOffsetDays = session.priorWeekVoteWindow === true ? 0 : 7;
  const weekWednesdayIso = addCalendarDaysToIsoYmd(thisBlockWednesdayIso, wednesdayOffsetDays);
  const voteStartIso = weekWednesdayIso;
  const voteEndIso = addCalendarDaysToIsoYmd(weekWednesdayIso, 6);
  const referenceWednesdayIso = weekWednesdayIso;
  return { voteStartIso, voteEndIso, referenceWednesdayIso, weekWednesdayIso };
}

function getBoardWeekWednesdayIsoFromSession(session) {
  const sourceSession = session.createdAt ? session : { ...session, createdAt: Date.now() };
  return getVoteWindowIsoForSession(sourceSession).weekWednesdayIso;
}

/** 임베드·집계 줄용: "12일 월요일" — 연·월 없이 일자와 요일만 */
function formatDayAggregateHeadline(day, weekWednesdayIso) {
  const off = DAY_OFFSET_FROM_WEDNESDAY[day.key] ?? 0;
  const iso = addCalendarDaysToIsoYmd(weekWednesdayIso, off);
  const dom = Number.parseInt(iso.split("-")[2], 10);
  return `${dom}일 ${day.label}요일`;
}

function buildComponents(sessionId, session) {
  const blockedStyleKeys = getMergedBlockedDayKeysForSession(session);
  const sheetUrl = getSpreadsheetUrl();
  const viewButton = sheetUrl
    ? new ButtonBuilder().setLabel("조회").setStyle(ButtonStyle.Link).setURL(sheetUrl)
    : new ButtonBuilder().setCustomId(`view:${sessionId}`).setLabel("조회").setStyle(ButtonStyle.Success);

  const timeAllButton = new ButtonBuilder()
    .setCustomId(`timeall:${sessionId}`)
    .setLabel("시간모두선택")
    .setStyle(ButtonStyle.Success);

  const dayRow1 = new ActionRowBuilder().addComponents(
    DAYS.slice(0, 5).map((day) =>
      new ButtonBuilder()
        .setCustomId(`day:${sessionId}:${day.key}`)
        .setLabel(day.label)
        .setStyle(blockedStyleKeys.has(day.key) ? ButtonStyle.Danger : ButtonStyle.Primary)
    )
  );

  const dayRow2 = new ActionRowBuilder().addComponents(
    ...DAYS.slice(5).map((day) =>
      new ButtonBuilder()
        .setCustomId(`day:${sessionId}:${day.key}`)
        .setLabel(day.label)
        .setStyle(blockedStyleKeys.has(day.key) ? ButtonStyle.Danger : ButtonStyle.Primary)
    ),
    timeAllButton,
    viewButton
  );

  const timeRow = new ActionRowBuilder().addComponents(
    TIME_SLOTS.map((time) =>
      new ButtonBuilder()
        .setCustomId(`time:${sessionId}:${time}`)
        .setLabel(time)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return [dayRow1, dayRow2, timeRow];
}

function getDisplayName(interaction) {
  if (interaction.member && typeof interaction.member.displayName === "string") {
    return interaction.member.displayName;
  }
  return interaction.user.globalName || interaction.user.username;
}

function getOrCreateUserData(session, userId, username) {
  if (!session.users.has(userId)) {
    session.users.set(userId, {
      username,
      selectedDayTimes: new Map(),
      activeDayKey: null,
    });
  }
  const userData = session.users.get(userId);
  userData.username = username;
  return userData;
}

/** `SCHEDULE_SESSION_SEED_USER_ID` — 조율판 생성 직후 시트에 `참여자 없음` 대신 넣을 총관리자(또는 대표) 유저 ID */
function getScheduleSessionSeedUserId() {
  const raw = process.env.SCHEDULE_SESSION_SEED_USER_ID;
  if (raw === undefined || raw === null) {
    return null;
  }
  const t = String(raw).trim();
  if (!/^\d{17,20}$/.test(t)) {
    return null;
  }
  return t;
}

async function resolveDiscordUserDisplayLabel(fetchClient, userId) {
  const gid = process.env.GUILD_ID ? String(process.env.GUILD_ID).trim() : "";
  if (gid && fetchClient.isReady()) {
    const g = fetchClient.guilds.cache.get(gid);
    if (g) {
      let m = g.members.cache.get(userId);
      if (!m) {
        try {
          m = await g.members.fetch(userId);
        } catch {
          /* ignore */
        }
      }
      if (m) {
        const nick = typeof m.nickname === "string" ? m.nickname.trim() : "";
        if (nick) {
          return nick;
        }
        if (typeof m.displayName === "string" && m.displayName.trim()) {
          return m.displayName.trim();
        }
        return m.user?.globalName || m.user?.username || userId;
      }
    }
  }
  try {
    const u = await fetchClient.users.fetch(userId);
    return u.globalName || u.username || userId;
  } catch {
    return userId;
  }
}

/**
 * 새 세션에 시트용 첫 줄을 채우기 위해, 지정된 유저를 투표 0인 상태로 한 명 넣습니다.
 */
async function ensureSessionSeedParticipant(fetchClient, session) {
  const seedId = getScheduleSessionSeedUserId();
  if (!seedId || session.users.has(seedId)) {
    return;
  }
  const label = await resolveDiscordUserDisplayLabel(fetchClient, seedId);
  getOrCreateUserData(session, seedId, label);
}

function getMentionsForDay(session, dayKey) {
  const mentions = [];
  for (const [userId, userData] of session.users.entries()) {
    const times = userData.selectedDayTimes?.get(dayKey);
    if (times && times.size > 0) {
      mentions.push(`<@${userId}>`);
    }
  }
  return mentions;
}

function getMentionsForTime(session, time) {
  const mentions = [];
  for (const [userId, userData] of session.users.entries()) {
    const dayTimes = userData.selectedDayTimes;
    if (!(dayTimes instanceof Map)) {
      continue;
    }
    for (const times of dayTimes.values()) {
      if (times.has(time)) {
        mentions.push(`<@${userId}>`);
        break;
      }
    }
  }
  return mentions;
}

function buildDetailText(session) {
  const weekWednesdayIso = getBoardWeekWednesdayIsoFromSession(session);
  const orderedDays = getDaysInBoardWeekOrder();
  const lines = ["**마감 현황**", ""];

  for (const day of orderedDays) {
    const head = formatDayAggregateHeadline(day, weekWednesdayIso);
    const n = getMentionsForDay(session, day.key).length;
    const slots = formatDayTimeSlotVotesHoriz(session, day.key);
    lines.push(`· ${head}(${n}명): ${slots}`);
  }

  lines.push("");
  lines.push("자세한 내용은 시트 참고 부탁드립니다.");

  return lines.join("\n");
}

/** 해당 요일 각 시간대를 누른 인원 수 — 한 줄로 나열 */
function formatDayTimeSlotVotesHoriz(session, dayKey) {
  return TIME_SLOTS.map((time) => {
    let count = 0;
    for (const [, userData] of session.users.entries()) {
      const times = userData.selectedDayTimes?.get(dayKey);
      if (times && times.has(time)) {
        count += 1;
      }
    }
    return `${time} ${count}명`;
  }).join(" · ");
}

function buildViewCountText(session) {
  const weekWednesdayIso = getBoardWeekWednesdayIsoFromSession(session);
  const lines = ["집계 현황표", "", "[요일별 투표 인원 · 수~화 순]"];
  for (const day of getDaysInBoardWeekOrder()) {
    const dayCount = getMentionsForDay(session, day.key).length;
    lines.push(
      `- ${formatDayAggregateHeadline(day, weekWednesdayIso)}: ${dayCount}명\n${formatDayTimeSlotVotesHoriz(session, day.key)}`
    );
  }
  return lines.join("\n");
}

function getSpreadsheetUrl() {
  const rawUrl = process.env.GOOGLE_SPREADSHEET_URL;
  if (rawUrl && typeof rawUrl === "string" && rawUrl.trim().length > 0) {
    return rawUrl.trim();
  }
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return "";
  }
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function buildSummaryEmbed(session) {
  const weekWednesdayIso = getBoardWeekWednesdayIsoFromSession(session);
  const lines = [];

  for (const day of DAYS) {
    const mentions = getMentionsForDay(session, day.key);
    lines.push(
      `- ${formatDayAggregateHeadline(day, weekWednesdayIso)}: ${mentions.length}명\n${formatDayTimeSlotVotesHoriz(session, day.key)}`
    );
  }

  loadUserWorkScheduleMap();
  const g = userWorkScheduleCache.global;
  let guideText = DEFAULT_BOARD_GUIDE;
  if (g && typeof g === "object" && typeof g.boardGuideText === "string") {
    const t = g.boardGuideText.trim();
    if (t.length > 0) {
      guideText = t.slice(0, BOARD_GUIDE_MAX_LEN);
    }
  }

  const head = [];
  const sourceSession = session.createdAt ? session : { ...session, createdAt: Date.now() };
  const { voteStartIso, voteEndIso, referenceWednesdayIso } = getVoteWindowIsoForSession(sourceSession);
  head.push(
    `**기준일**\n기준 날짜 이후로 진행될 침식 요일/시간을 선택하는 투표입니다.\n${formatIsoYmdForBoard(referenceWednesdayIso)}`
  );
  head.push("");
  head.push(
    `**투표시작/마감일**\n` +
      `시작 ${formatIsoYmdForBoard(voteStartIso)}\n` +
      `마감 ${formatIsoYmdForBoard(voteEndIso)}`
  );
  head.push("");
  const manualLocked = getSessionManualLockedDayKeysSet(session);
  if (manualLocked.size > 0) {
    const lockLabels = [...manualLocked]
      .sort()
      .map((k) => {
        const meta = DAYS.find((d) => d.key === k);
        return meta ? `${meta.label}요일` : k;
      })
      .join(", ");
    head.push(`**관리자 잠금 요일** (빨간 버튼)\n${lockLabels}`);
    head.push("");
  }
  head.push(`**안내**\n${guideText}`);
  head.push("");
  const description = [...head, ...lines].join("\n");

  const titleMonth = formatYearMonthLabelFromIsoYmd(referenceWednesdayIso);
  return new EmbedBuilder()
    .setTitle(`요일/시간 조율 · ${titleMonth}`)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: "요일 버튼으로 대상 요일 선택 -> 시간 버튼으로 해당 요일 시간 선택/해제" });
}

function buildClosedSummaryEmbed(session, closedAtMs = Date.now()) {
  const header = `**마감일**\n${formatBoardDate(closedAtMs)}\n\n`;
  const body = buildDetailText(session);
  let full = `${header}${body}`;
  if (full.length > 4090) {
    const maxBody = Math.max(0, 4090 - header.length - 3);
    full = `${header}${body.slice(0, maxBody)}...`;
  }
  return new EmbedBuilder()
    .setTitle("주간 조율 마감")
    .setDescription(full)
    .setColor(0x57f287)
    .setFooter({ text: "마감되었습니다." });
}

async function runWeeklyOpenJob(client, logPrefix = "[크론]") {
  const channelId = process.env.SCHEDULE_CHANNEL_ID;
  if (!channelId) {
    console.error(`${logPrefix} SCHEDULE_CHANNEL_ID가 없습니다.`);
    return;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`${logPrefix} SCHEDULE_CHANNEL_ID: 텍스트 채널을 찾을 수 없습니다.`);
      return;
    }
    const { sessionId, session } = registerSession(client.user.id, channel.id);
    const message = await channel.send({
      embeds: [buildSummaryEmbed(session)],
      components: buildComponents(sessionId, session),
    });
    session.messageId = message.id;
    weeklyAutoSession = {
      sessionId,
      channelId: channel.id,
      messageId: message.id,
    };
    console.log(`${logPrefix} 주간 조율판 게시: ${message.url}`);
  } catch (error) {
    console.error(`${logPrefix} 조율판 게시 실패:`, error);
  }
}

async function runWeeklyCloseJob(client, logPrefix = "[크론]") {
  if (!weeklyAutoSession) {
    console.log(`${logPrefix} 자동 주간 세션 없음 — 마감 건너뜀`);
    return;
  }
  const { sessionId, channelId: chId, messageId } = weeklyAutoSession;
  const session = sessions.get(sessionId);
  weeklyAutoSession = null;
  if (!session) {
    console.log(`${logPrefix} 세션 데이터 없음 — 마감 건너뜀`);
    return;
  }
  await closeSessionAndPublishSummary(client, { ...session, channelId: chId, messageId }, logPrefix);
}

function startWeeklyCron(client) {
  if (process.env.SCHEDULE_SMOKE_TEST === "1") {
    console.warn(
      "[스모크] SCHEDULE_SMOKE_TEST=1 — 실제 수·일 크론은 등록하지 않습니다. 약 3초 후 게시, 25초 후 마감을 한 번 실행합니다. 끝나면 .env에서 제거하세요."
    );
    setTimeout(() => runWeeklyOpenJob(client, "[스모크]"), 3000);
    setTimeout(() => runWeeklyCloseJob(client, "[스모크]"), 25000);
    return;
  }
  console.log(
    "수요일 자동 조율판 게시·일요일 마감 크론은 사용하지 않습니다. (수동 /일정생성 또는 대시보드 원격 제어를 사용하세요.)"
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`${readyClient.user.tag} 로그인 완료`);
  console.log("[봇이 읽은 index.js]", path.resolve(__dirname, "index.js"));
  const sheetId = process.env.GOOGLE_SPREADSHEET_ID && String(process.env.GOOGLE_SPREADSHEET_ID).trim();
  const liveEff = getEffectiveLiveRange();
  if (sheetId && liveEff) {
    const sampleTight = getLiveSyncValuesOnlyRange(liveEff, 6, "tight");
    const dataRow1 = getLiveSyncDataStartRow1FromLiveRange(liveEff);
    const readRow1 = getLiveSyncReadTopRow1(liveEff);
    const fixedHdr = isLiveSyncFixedSheetHeadersEnabled()
      ? `고정헤더=1(헤더행=${getLiveSyncTemplateHeaderRow1()}, 블록=${getLiveSyncTemplateBlockRowCount()}행, import시작행=${readRow1})`
      : "고정헤더=0(첫 행부터 헤더+데이터 한 번에 씀)";
    console.log(
      "[실시간시트] 부팅 점검: 스프레드시트 연동됨 — LIVE(탭·범위)=",
      liveEff,
      "| 버튼 누르면 clear/update 예:",
      sampleTight,
      "| 첫 데이터 행(1-based, A열~)=",
      dataRow1,
      "|",
      fixedHdr,
      "| DATA_START_ROW(env)=",
      String(process.env.SCHEDULE_LIVE_SYNC_DATA_START_ROW ?? "").trim() || "(없음)",
      "| 상태파일:",
      getLiveSheetStatePath()
    );
  } else {
    console.warn(
      "[실시간시트] 부팅 점검: 시트 동기화 비활성 — GOOGLE_SPREADSHEET_ID 또는 LIVE 범위(.env / .schedule-live-sheet.json)를 확인하세요.",
      { hasSpreadsheetId: Boolean(sheetId), liveRange: liveEff || null }
    );
  }
  loadUserWorkScheduleMap();
  const globalDates = getEnvGlobalWorkDateSet();
  if (globalDates) {
    console.log(`전역 근무일(.env): 달력상 ${globalDates.size}일 지정됨`);
  }
  const mergedCfg = getMergedWorkDatesConfigForComputation();
  if (mergedCfg?.workDates?.length) {
    console.log(
      `근무일 목록(workDates + SCHEDULE_GLOBAL_WORK_DATES): ${mergedCfg.workDates.length}개 — 요일 버튼 빨강에는 쓰지 않음(대시보드 global.blockedDayKeys 만 반영)`
    );
  }
  const envBlockedDays = parseEnvBlockedDayKeysSet();
  if (envBlockedDays.size > 0) {
    console.log(
      `요일 버튼 차단(.env SCHEDULE_BLOCKED_DAY_KEYS): ${[...envBlockedDays].join(", ")} — 대시보드 JSON만 반영하므로 적용되지 않습니다.`
    );
  }
  const gb = userWorkScheduleCache.global?.blockedDayKeys;
  if (Array.isArray(gb) && gb.length > 0) {
    console.log(`요일 버튼 차단(대시보드 JSON global.blockedDayKeys): ${gb.filter((x) => typeof x === "string").join(", ")}`);
  }
  const schedulePath = getUserWorkSchedulePath();
  const examplePath = path.join(__dirname, "user-work-schedule.example.json");
  try {
    if (!fs.existsSync(schedulePath) && fs.existsSync(examplePath)) {
      console.warn(
        "대시보드에서 막을 요일을 쓰려면 user-work-schedule.json 을 두거나 대시보드에서 저장해 global.blockedDayKeys 를 채우세요."
      );
    }
  } catch (_) {
    /* ignore */
  }
  const allowIds = getOptionalUserIdSetFromEnv("SCHEDULE_BUTTON_ALLOW_USER_IDS");
  const denyIds = getOptionalUserIdSetFromEnv("SCHEDULE_BUTTON_DENY_USER_IDS");
  if (allowIds) {
    console.log(`조율판 버튼: 허용 목록 사용 (${allowIds.size}명)`);
  } else if (denyIds) {
    console.log(`조율판 버튼: 차단 목록 사용 (${denyIds.size}명)`);
  }
  try {
    await registerCommands(readyClient);
  } catch (error) {
    console.error("명령어 등록 실패:", error);
  }
  startWeeklyCron(readyClient);

  const sheetImportSec = Number.parseInt(process.env.SCHEDULE_SHEET_IMPORT_INTERVAL_SEC ?? "0", 10);
  if (Number.isFinite(sheetImportSec) && sheetImportSec > 0) {
    if (process.env.GOOGLE_SPREADSHEET_ID && getEffectiveLiveRange()) {
      setInterval(() => {
        importLiveSheetToDiscordSessions(readyClient).catch((e) => {
          console.warn("[실시간시트→디스코드] 폴링 오류:", e?.message || e);
        });
      }, sheetImportSec * 1000);
      console.log(`실시간 시트 → 디스코드 폴링: ${sheetImportSec}초마다`);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (
      interaction.commandName === "일정생성" ||
      interaction.commandName === "일정생성특수" ||
      interaction.commandName === "schedule_special"
    ) {
      try {
        await interaction.deferReply();
      } catch (deferErr) {
        const code = deferErr && (deferErr.code ?? deferErr.rawError?.code);
        if (code === 10062) {
          console.warn(
            "[조율판] Unknown interaction(10062) — 디스코드 3초 안에 응답 못 했거나, 같은 봇 토큰이 두 곳에서 동시에 돌고 있을 수 있어요. PC·서버에서 node 중복 실행 여부를 확인하세요."
          );
          return;
        }
        throw deferErr;
      }
      try {
        const priorWeekVoteWindow =
          interaction.commandName === "일정생성특수" ||
          (interaction.commandName === "일정생성" &&
            interaction.options.getString("모드") === "special");
        const { sessionId, session } = registerSession(interaction.user.id, interaction.channelId, {
          priorWeekVoteWindow,
        });

        await ensureSessionSeedParticipant(interaction.client, session);

        const embed = buildSummaryEmbed(session);
        const message = await interaction.editReply({
          embeds: [embed],
          components: buildComponents(sessionId, session),
        });

        session.messageId = message.id;
        scheduleLiveSheetSync(session);
      } catch (err) {
        console.error(`[${interaction.commandName}] 조율판 생성 실패:`, err);
        try {
          if (interaction.deferred) {
            await interaction.editReply({
              content: "조율판을 만들지 못했어요. 봇에게 이 채널에서 스레드·임베드·버튼 권한이 있는지 확인해 주세요.",
            });
          } else {
            await interaction.reply({
              content: "조율판을 만들지 못했어요.",
              ephemeral: true,
            });
          }
        } catch (_) {
          /* interaction may already be invalid */
        }
      }
      return;
    }

    if (interaction.commandName === "일정마감") {
      if (!interactionMemberIsAdministrator(interaction)) {
        await interaction.reply({
          content: "이 명령어는 서버 관리자만 사용할 수 있어요.",
          ephemeral: true,
        });
        return;
      }

      const latestSession = findLatestSessionInChannel(interaction.channelId);
      if (!latestSession) {
        await interaction.reply({
          content: "현재 채널에 마감할 활성 조율판이 없어요.",
          ephemeral: true,
        });
        return;
      }

      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (deferErr) {
        if ((deferErr.code ?? deferErr.rawError?.code) === 10062) {
          console.warn("[일정마감] Unknown interaction(10062) — interaction 만료 또는 봇 중복 실행 가능.");
          return;
        }
        throw deferErr;
      }
      try {
        await closeSessionAndPublishSummary(client, latestSession, "[수동마감]");
        await interaction.editReply({
          content: "최신 조율판을 마감하고 집계를 확정했어요.",
        });
      } catch (err) {
        console.error("[일정마감] 처리 실패:", err);
        try {
          await interaction.editReply({
            content: "마감 처리 중 오류가 났어요. 로그를 확인해 주세요.",
          });
        } catch (_) {
          /* interaction may already be invalid */
        }
      }
      return;
    }

    if (interaction.commandName === "시트불러오기" || interaction.commandName === "sheet_sync") {
      if (!interactionMemberIsAdministrator(interaction)) {
        await interaction.reply({
          content: "이 명령어는 서버 관리자만 사용할 수 있어요. (채널에서 다시 시도해 주세요.)",
          ephemeral: true,
        });
        return;
      }
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (deferErr) {
        if ((deferErr.code ?? deferErr.rawError?.code) === 10062) {
          console.warn("[시트불러오기] Unknown interaction(10062) — interaction 만료 또는 봇 중복 실행 가능.");
          return;
        }
        throw deferErr;
      }
      try {
        const r = await importLiveSheetToDiscordSessions(client);
        let text;
        if (r.parseError === "no_sheet_config") {
          text =
            "GOOGLE_SPREADSHEET_ID가 없거나, 실시간 시트 범위가 없어요. `.env`의 `GOOGLE_SHEET_LIVE_RANGE`를 넣거나, 마감 로테이트 후 생성된 `.schedule-live-sheet.json`이 있는지 확인해 주세요.";
        } else if (r.parseError === "no_sheets_client") {
          text = "Google 서비스 계정(GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)이 없어요.";
        } else if (r.parseError === "fetch_failed") {
          text = "시트를 읽지 못했어요. 스프레드시트 공유·범위를 확인해 주세요.";
        } else if (r.parseError === "parse_failed") {
          text = "시트 형식을 해석하지 못했어요. 봇이 쓰는 표(참여자/시작일/마감일/시간/요일 열)와 같은지 확인해 주세요.";
        } else if (r.matched === 0) {
          text =
            "시트의 시작일·마감일과 같은 투표 주간을 가진 활성 조율판이 없어요. 첫 참가자 블록의 시작일·마감일이 조율판 임베드의 투표 시작/마감 **같은 날(주)** 인지 확인해 보세요. (셀 서식이 달라도 날짜만 맞으면 인식합니다.)";
        } else if (r.edited === 0) {
          const d = r.noEditDetail;
          const rawNames = d?.unresolvedNames?.length ? d.unresolvedNames.join(", ") : "";
          const showNames = rawNames.length > 400 ? `${rawNames.slice(0, 400)}…` : rawNames;
          if (d && d.blockCount > 0 && d.resolvedBlockCount === 0) {
            text =
              `주간이 맞는 조율판은 ${r.matched}개인데, 시트 **참가자 이름(A열)** 을 디스코드 유저와 연결하지 못했어요.\n` +
              `• **기본**: GUILD_ID 서버에서 멤버 **표시명·닉네임·유저명** 과 맞춰 자동 연결합니다. (Discord 개발자 포털 → 봇 → **Server Members Intent** 필요. 끄려면 \`SCHEDULE_SHEET_RESOLVE_GUILD_MEMBERS=0\`)\n` +
              `• 같은 별칭이 2명 이상이면 자동 연결하지 않습니다.\n` +
              `• A열 \`이름|유저ID\` 또는 셀 안 **17~19자리 ID**, 또는 SCHEDULE_SHEET_USER_MAP JSON.\n` +
              (showNames ? `매칭 실패한 A열: ${showNames}` : "");
          } else if (d && d.resolvedBlockCount > 0) {
            text =
              `주간이 맞는 조율판 ${r.matched}개: **이미 매칭된 참가자** 기준으로는 시트 O/X 와 같아서 수정할 게 없었어요.\n` +
              `아래 A열은 **유저를 한 명으로 특정하지 못해** 시트 값을 적용하지 않았습니다. (길드 자동 매칭 실패·동명이·표시명 형식 차이 등)\n` +
              `• Server Members Intent·GUILD_ID·\`SCHEDULE_SHEET_RESOLVE_GUILD_MEMBERS\` 를 확인하거나, A열 \`|유저ID\` / USER_MAP 을 쓰세요.\n` +
              (d.unresolvedNames?.length ? `무시된 A열: ${showNames}` : "");
          } else if (d?.explicitEmpty) {
            text = `주간이 맞는 조율판 ${r.matched}개: 시트가 "참여자 없음" 이고, 세션에도 이미 선택이 비어 있어 바꿀 게 없었어요.`;
          } else {
            text = `주간이 맞는 조율판은 ${r.matched}개인데 디스코드에 반영된 변경이 없어요. 시트에 참가자 블록이 있는지 확인해 주세요.`;
          }
        } else {
          text = `시트 내용을 ${r.edited}개 조율판 메시지에 반영했어요.`;
        }
        await interaction.editReply({ content: text });
      } catch (err) {
        console.error("[시트불러오기] 실패:", err);
        try {
          await interaction.editReply({
            content: "처리 중 오류가 났어요. 로그를 확인해 주세요.",
          });
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    console.warn("[슬래시] 처리 없는 명령:", interaction.commandName);
    return;
  }

  if (interaction.isButton()) {
    if (isScheduleButtonInteractionLogEnabled()) {
      const uid = interaction.user?.id ?? "?";
      const tag = interaction.user?.tag ?? String(uid);
      console.log(
        "[조율버튼]",
        new Date().toLocaleString("ko-KR", { timeZone: SCHEDULE_TZ }),
        `user=${tag}(${uid})`,
        `guild=${interaction.guildId ?? "-"}`,
        `ch=${interaction.channelId ?? "-"}`,
        `customId=${interaction.customId}`
      );
    }
    const [type, sessionId, ...payloadParts] = interaction.customId.split(":");
    const payload = payloadParts.join(":");
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: "이 조율 세션은 만료되었거나 찾을 수 없어요.",
        ephemeral: true,
      });
      return;
    }

    if (!isUserAllowedScheduleButtons(interaction.user.id)) {
      await interaction.reply({
        content: "이 조율판 버튼을 사용할 수 없어요.",
        ephemeral: true,
      });
      return;
    }

    if (type === "day") {
      const blockedKeys = mergeBlockedDayKeysForSessionAndUser(session, interaction.user.id);
      const dayKey = typeof payload === "string" ? payload.toUpperCase() : payload;
      if (VALID_DAY_KEYS.has(dayKey) && blockedKeys.has(dayKey)) {
        const meta = DAYS.find((d) => d.key === dayKey);
        await interaction.reply({
          content: `${meta ? `${meta.label}요일` : dayKey}은(는) 선택할 수 없습니다.`,
          ephemeral: true,
        });
        return;
      }

      const userData = getOrCreateUserData(session, interaction.user.id, getDisplayName(interaction));
      userData.activeDayKey = dayKey;
      const dayLabel = DAYS.find((d) => d.key === dayKey)?.label ?? dayKey;
      await interaction.reply({
        content: `${dayLabel}요일 선택됨. 이제 시간 버튼을 누르면 ${dayLabel}요일에 저장됩니다.`,
        ephemeral: true,
      });
      scheduleLiveSheetSync(session);
      return;
    }

    const userData = getOrCreateUserData(session, interaction.user.id, getDisplayName(interaction));

    if (type === "time") {
      const activeDayKey = userData.activeDayKey;
      if (!activeDayKey || !VALID_DAY_KEYS.has(activeDayKey)) {
        await interaction.reply({
          content: "먼저 요일 버튼을 눌러 대상 요일을 선택해 주세요.",
          ephemeral: true,
        });
        return;
      }

      if (!userData.selectedDayTimes.has(activeDayKey)) {
        userData.selectedDayTimes.set(activeDayKey, new Set());
      }
      const times = userData.selectedDayTimes.get(activeDayKey);
      if (times.has(payload)) {
        times.delete(payload);
      } else {
        times.add(payload);
      }
      if (times.size === 0) {
        userData.selectedDayTimes.delete(activeDayKey);
      }
      await interaction.update({
        embeds: [buildSummaryEmbed(session)],
        components: buildComponents(sessionId, session),
      });
      scheduleLiveSheetSync(session);
      return;
    }

    if (type === "timeall") {
      const activeDayKey = userData.activeDayKey;
      if (!activeDayKey || !VALID_DAY_KEYS.has(activeDayKey)) {
        await interaction.reply({
          content: "먼저 요일 버튼을 눌러 대상 요일을 선택해 주세요.",
          ephemeral: true,
        });
        return;
      }

      const blockedKeys = mergeBlockedDayKeysForSessionAndUser(session, interaction.user.id);
      if (blockedKeys.has(activeDayKey)) {
        const meta = DAYS.find((d) => d.key === activeDayKey);
        await interaction.reply({
          content: `${meta ? `${meta.label}요일` : activeDayKey}은(는) 선택할 수 없습니다.`,
          ephemeral: true,
        });
        return;
      }

      if (!userData.selectedDayTimes.has(activeDayKey)) {
        userData.selectedDayTimes.set(activeDayKey, new Set());
      }
      const times = userData.selectedDayTimes.get(activeDayKey);
      const allSelected = TIME_SLOTS.every((t) => times.has(t));
      if (allSelected) {
        userData.selectedDayTimes.delete(activeDayKey);
      } else {
        for (const t of TIME_SLOTS) {
          times.add(t);
        }
      }
      await interaction.update({
        embeds: [buildSummaryEmbed(session)],
        components: buildComponents(sessionId, session),
      });
      scheduleLiveSheetSync(session);
      return;
    }

    if (type === "view") {
      const sheetUrl = getSpreadsheetUrl();
      const lines = [];
      if (sheetUrl) {
        lines.push(`시트 바로가기: ${sheetUrl}`);
        lines.push("");
      }
      lines.push(buildViewCountText(session));
      await interaction.reply({
        content: lines.join("\n"),
        ephemeral: true,
      });
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN이 없습니다. .env 파일을 확인하세요.");
  process.exit(1);
}

function parseIsoDateListInput(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  const parts = raw
    .split(/[\s,\n\r，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p)) {
      continue;
    }
    if (seen.has(p)) {
      continue;
    }
    seen.add(p);
    out.push(p);
    if (out.length > 220) {
      break;
    }
  }
  return out;
}

function getDashboardScheduleFileForSnapshot() {
  loadUserWorkScheduleMap();
  const pathResolved = userWorkScheduleCache.resolvedPath || getUserWorkSchedulePath();
  const g = userWorkScheduleCache.global;
  const empty = {
    path: pathResolved,
    workDates: [],
    holidayDates: [],
    blockedDayKeys: [],
    boardGuideText: "",
    usesDefaultGuide: true,
  };
  if (!g || typeof g !== "object") {
    return empty;
  }
  const workDates = Array.isArray(g.workDates)
    ? [...new Set(g.workDates.map((x) => String(x).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
    : [];
  const holidayDates = Array.isArray(g.holidayDates)
    ? [...new Set(g.holidayDates.map((x) => String(x).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
    : [];
  const blockedDayKeys = Array.isArray(g.blockedDayKeys)
    ? [...new Set(g.blockedDayKeys.map((k) => String(k).toUpperCase()).filter((k) => VALID_DAY_KEYS.has(k)))].sort()
    : [];
  const guideRaw = typeof g.boardGuideText === "string" ? g.boardGuideText : "";
  const usesDefaultGuide = !guideRaw.trim();
  return {
    path: pathResolved,
    workDates,
    holidayDates,
    blockedDayKeys,
    boardGuideText: guideRaw,
    usesDefaultGuide,
  };
}

function saveDashboardScheduleFile(body) {
  try {
    const workDates = parseIsoDateListInput(body?.workDates);
    const holidayDates = parseIsoDateListInput(body?.holidayDates);
    const blockedRaw = body?.blockedDayKeys;
    const blockedSet = new Set();
    if (Array.isArray(blockedRaw)) {
      for (const k of blockedRaw) {
        const u = String(k).toUpperCase();
        if (VALID_DAY_KEYS.has(u)) {
          blockedSet.add(u);
        }
      }
    }
    const blockedDayKeys = [...blockedSet].sort();

    const boardGuideText = typeof body?.boardGuideText === "string" ? body.boardGuideText : "";
    if (boardGuideText.length > BOARD_GUIDE_MAX_LEN) {
      return { ok: false, error: "guide_too_long", max: BOARD_GUIDE_MAX_LEN };
    }

    const resolvedPath = getUserWorkSchedulePath();
    let base = { users: {}, global: {} };
    if (fs.existsSync(resolvedPath)) {
      try {
        base = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
      } catch (parseErr) {
        return { ok: false, error: "invalid_json", message: String(parseErr.message || parseErr) };
      }
    }
    if (!base || typeof base !== "object") {
      base = { users: {}, global: {} };
    }
    if (!base.users || typeof base.users !== "object") {
      base.users = {};
    }
    const prevGlobal = base.global && typeof base.global === "object" ? { ...base.global } : {};
    const nextGlobal = { ...prevGlobal };
    nextGlobal.workDates = workDates;
    nextGlobal.holidayDates = holidayDates;
    if (blockedDayKeys.length > 0) {
      nextGlobal.blockedDayKeys = blockedDayKeys;
    } else {
      delete nextGlobal.blockedDayKeys;
    }
    const trimmedGuide = boardGuideText.trim();
    if (trimmedGuide) {
      nextGlobal.boardGuideText = trimmedGuide;
    } else {
      delete nextGlobal.boardGuideText;
    }
    delete nextGlobal.cycle;
    const out = { ...base, users: base.users, global: nextGlobal };
    if (typeof base.__doc__ === "string") {
      out.__doc__ = base.__doc__;
    }
    fs.writeFileSync(resolvedPath, JSON.stringify(out, null, 2), "utf8");
    userWorkScheduleCache.mtimeMs = -1;
    loadUserWorkScheduleMap();
    console.log(`[dashboard] user-work-schedule 저장: ${resolvedPath}`);
    return { ok: true, scheduleFile: getDashboardScheduleFileForSnapshot() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function getDashboardSnapshot() {
  const boards = [];
  for (const session of sessions.values()) {
    if (!session.messageId) {
      continue;
    }
    const src = session.createdAt ? session : { ...session, createdAt: Date.now() };
    const { voteStartIso, voteEndIso } = getVoteWindowIsoForSession(src);
    boards.push({
      sessionId: session.id,
      messageId: session.messageId,
      channelId: session.channelId,
      createdAt: session.createdAt,
      voteStartIso,
      voteEndIso,
      priorWeek: session.priorWeekVoteWindow === true,
      manualLockedKeys: [...getSessionManualLockedDayKeysSet(session)].sort(),
    });
  }
  boards.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return {
    activeSessionCount: sessions.size,
    boards,
    features: {
      scheduleCron: false,
      scheduleChannelId: process.env.SCHEDULE_CHANNEL_ID ? String(process.env.SCHEDULE_CHANNEL_ID).trim() : "",
      sheetsLive: Boolean(process.env.GOOGLE_SPREADSHEET_ID && getEffectiveLiveRange()),
      guildSlash: Boolean(process.env.GUILD_ID),
    },
    scheduleFile: getDashboardScheduleFileForSnapshot(),
  };
}

function dashboardSnowflakeOk(id) {
  return /^\d{17,22}$/.test(String(id || "").trim());
}

async function dashboardAssertGuildChannel(channelId) {
  const cid = String(channelId || "").trim();
  if (!dashboardSnowflakeOk(cid)) {
    return { ok: false, error: "channel_id_invalid", channel: null };
  }
  const guildEnv = process.env.GUILD_ID ? String(process.env.GUILD_ID).trim() : "";
  if (!guildEnv) {
    return { ok: false, error: "guild_id_missing", channel: null };
  }
  const ch = await client.channels.fetch(cid).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    return { ok: false, error: "channel_not_found", channel: null };
  }
  if (String(ch.guildId) !== guildEnv) {
    return { ok: false, error: "channel_not_in_guild", channel: null };
  }
  return { ok: true, channel: ch };
}

async function dashboardControlCloseLatestInChannel(channelId) {
  const v = await dashboardAssertGuildChannel(channelId);
  if (!v.ok) {
    return v;
  }
  const latest = findLatestSessionInChannel(v.channel.id);
  if (!latest || !latest.messageId) {
    return { ok: false, error: "no_active_board" };
  }
  await closeSessionAndPublishSummary(client, latest, "[대시보드]");
  return { ok: true };
}

async function dashboardControlImportSheet() {
  const r = await importLiveSheetToDiscordSessions(client);
  return { ok: true, result: r };
}

async function dashboardControlPostBoard(channelId, mode, referenceWednesdayIso) {
  const v = await dashboardAssertGuildChannel(channelId);
  if (!v.ok) {
    return v;
  }
  const priorWeek = mode === "special";
  const refRaw =
    referenceWednesdayIso !== undefined && referenceWednesdayIso !== null
      ? String(referenceWednesdayIso).trim()
      : "";
  const opts = { priorWeekVoteWindow: priorWeek };
  if (refRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refRaw)) {
      return { ok: false, error: "invalid_reference_wednesday", detail: "YYYY-MM-DD 형식이어야 합니다." };
    }
    if (weekdayKeyFromIsoYmd(refRaw, SCHEDULE_TZ) !== "WED") {
      return {
        ok: false,
        error: "invalid_reference_wednesday",
        detail: "Asia/Seoul 기준 수요일만 선택할 수 있습니다.",
      };
    }
    const createdAtMs = createdAtMsForVoteStartWednesday(refRaw, priorWeek);
    if (!Number.isFinite(createdAtMs)) {
      return { ok: false, error: "invalid_reference_wednesday", detail: "날짜를 해석하지 못했습니다." };
    }
    opts.createdAtMs = createdAtMs;
  }
  const { sessionId, session } = registerSession(client.user.id, v.channel.id, opts);
  await ensureSessionSeedParticipant(client, session);
  const message = await v.channel.send({
    embeds: [buildSummaryEmbed(session)],
    components: buildComponents(sessionId, session),
  });
  session.messageId = message.id;
  scheduleLiveSheetSync(session);
  return { ok: true, messageUrl: message.url, sessionId };
}

client.login(process.env.DISCORD_TOKEN);

try {
  const { startDashboardIfEnabled } = require("./dashboard/server");
  startDashboardIfEnabled(client, {
    getActiveSessionCount: () => sessions.size,
    getDashboardSnapshot,
    dashboardCloseLatestInChannel: (cid) => dashboardControlCloseLatestInChannel(cid),
    dashboardImportSheet: () => dashboardControlImportSheet(),
    dashboardPostBoard: (cid, mode, refIso) => dashboardControlPostBoard(cid, mode, refIso),
    saveDashboardScheduleConfig: (body) => saveDashboardScheduleFile(body),
  });
} catch (err) {
  console.warn(
    "[dashboard] ./dashboard/server 로드 실패 — 대시보드 없이 봇만 실행합니다. (서버에서 `npm ci` 하면 해결되는 경우가 많습니다.)",
    err && err.message ? err.message : err
  );
}
