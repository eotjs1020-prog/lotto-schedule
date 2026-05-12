require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
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

const SCHEDULE_TZ = "Asia/Seoul";
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

function diffCalendarDays(fromIsoYmd, toIsoYmd) {
  const [yf, mf, df] = fromIsoYmd.split("-").map(Number);
  const [yt, mt, dt] = toIsoYmd.split("-").map(Number);
  const fromUtc = Date.UTC(yf, mf - 1, df);
  const toUtc = Date.UTC(yt, mt - 1, dt);
  return Math.round((toUtc - fromUtc) / 86400000);
}

function addCalendarDaysToIsoYmd(isoYmd, deltaDays) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return formatCalendarDateInTz(ms, SCHEDULE_TZ);
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
      `근무일 버튼 차단 설정 로드: 사용자 ${Object.keys(users).length}명, 전역 규칙 ${globalCfg ? "있음" : "없음"} (${resolvedPath})`
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

function isCalendarDateWorkDay(isoYmd, cfg) {
  if (!cfg || typeof cfg !== "object") {
    return false;
  }

  if (Array.isArray(cfg.workDates)) {
    const hit = cfg.workDates.some((d) => typeof d === "string" && d === isoYmd);
    if (hit) {
      return true;
    }
  }

  const cycle = cfg.cycle;
  if (!cycle || typeof cycle !== "object") {
    return false;
  }

  const anchorDate = typeof cycle.anchorDate === "string" ? cycle.anchorDate : "";
  const workDays = Number.isFinite(cycle.workDays) ? cycle.workDays : NaN;
  const restDays = Number.isFinite(cycle.restDays) ? cycle.restDays : NaN;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || workDays <= 0 || restDays <= 0) {
    return false;
  }

  const anchorStartsWork = cycle.anchorStartsWork !== false;
  const cycleLen = workDays + restDays;
  const diffDays = diffCalendarDays(anchorDate, isoYmd);
  const pos = ((diffDays % cycleLen) + cycleLen) % cycleLen;

  if (anchorStartsWork) {
    return pos < workDays;
  }
  return pos >= restDays;
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

const CYCLE_ANCHOR_FILE = path.join(__dirname, ".schedule-global-cycle-anchor");

function readOrInitPersistedCycleAnchorDate() {
  try {
    const text = fs.readFileSync(CYCLE_ANCHOR_FILE, "utf8").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return text;
    }
    console.warn(`근무 패턴 기준일 파일 형식이 잘못되어 다시 만듭니다: ${CYCLE_ANCHOR_FILE}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("근무 패턴 기준일 파일 읽기 실패:", error.message || error);
    }
  }
  const todayStr = formatCalendarDateInTz(Date.now(), SCHEDULE_TZ);
  const tomorrowStr = addCalendarDaysToIsoYmd(todayStr, 1);
  try {
    fs.writeFileSync(CYCLE_ANCHOR_FILE, `${tomorrowStr}\n`, "utf8");
    console.log(
      `전역 근무 패턴: 기준일을 한국 시간 내일(${tomorrowStr})로 자동 저장했습니다. (${CYCLE_ANCHOR_FILE})`
    );
  } catch (error) {
    console.error(
      "근무 패턴 기준일 파일 저장 실패 — 이번 실행만 내일을 기준으로 계산합니다:",
      error.message || error
    );
  }
  return tomorrowStr;
}

/**
 * 전역 반복 패턴.
 * SCHEDULE_GLOBAL_CYCLE_WORK_DAYS / REST_DAYS 만 넣으면 기준일은 생략 가능 → 최초에 한국 시간 내일을 파일에 저장해 유지.
 * SCHEDULE_GLOBAL_CYCLE_ANCHOR_DATE 로 수동 지정 시 그 값이 우선.
 */
function getEnvGlobalCycleScheduleConfig() {
  const wd = process.env.SCHEDULE_GLOBAL_CYCLE_WORK_DAYS;
  const rd = process.env.SCHEDULE_GLOBAL_CYCLE_REST_DAYS;
  const workDays = Number.parseInt(String(wd), 10);
  const restDays = Number.parseInt(String(rd), 10);
  if (!Number.isFinite(workDays) || !Number.isFinite(restDays) || workDays <= 0 || restDays <= 0) {
    return null;
  }

  const rawAnchor = process.env.SCHEDULE_GLOBAL_CYCLE_ANCHOR_DATE;
  let anchorDate = null;
  if (rawAnchor && /^\d{4}-\d{2}-\d{2}$/.test(String(rawAnchor).trim())) {
    anchorDate = String(rawAnchor).trim();
  } else {
    anchorDate = readOrInitPersistedCycleAnchorDate();
  }

  if (!anchorDate) {
    return null;
  }

  const raw = process.env.SCHEDULE_GLOBAL_CYCLE_ANCHOR_STARTS_WORK;
  let anchorStartsWork = false;
  if (raw !== undefined && String(raw).trim() !== "") {
    anchorStartsWork = raw === "1" || raw.toLowerCase() === "true";
  }
  return {
    timezone: SCHEDULE_TZ,
    cycle: {
      anchorDate,
      workDays,
      restDays,
      anchorStartsWork,
    },
  };
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

/** 해당 날짜가 속한 주의 월요일 (한국 달력 기준) */
function getMondayIsoContaining(isoYmd) {
  for (let back = 0; back < 7; back++) {
    const cand = addCalendarDaysToIsoYmd(isoYmd, -back);
    if (weekdayKeyFromIsoYmd(cand, SCHEDULE_TZ) === "MON") {
      return cand;
    }
  }
  return isoYmd;
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

/**
 * 조율판이 가리키는 '투표 대상 주'의 월요일.
 * 기본 1 = 게시글이 올라온 주의 다음 주(월~일). SCHEDULE_VOTE_WEEK_OFFSET_WEEKS=0 이면 같은 주.
 */
function getVoteTargetWeekMondayIso(session) {
  const createdIso = formatCalendarDateInTz(session.createdAt, SCHEDULE_TZ);
  const postWeekMonday = getMondayIsoContaining(createdIso);
  const offsetWeeks = Number.parseInt(process.env.SCHEDULE_VOTE_WEEK_OFFSET_WEEKS ?? "1", 10);
  const ow = Number.isFinite(offsetWeeks) ? offsetWeeks : 1;
  return addCalendarDaysToIsoYmd(postWeekMonday, ow * 7);
}

/** .env 주기 + JSON global 의 cycle/workDates 를 합친 설정 (투표 주 단위 요일 계산용) */
function getMergedRepeatCycleConfigForComputation() {
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

  const envCycleCfg = getEnvGlobalCycleScheduleConfig();

  let cycleObj = null;
  let tz = SCHEDULE_TZ;

  if (envCycleCfg?.cycle) {
    cycleObj = { ...envCycleCfg.cycle };
    tz = envCycleCfg.timezone || SCHEDULE_TZ;
  } else if (g && typeof g === "object" && g.cycle && typeof g.cycle === "object") {
    const c = g.cycle;
    const anchorDate = typeof c.anchorDate === "string" ? c.anchorDate.trim() : "";
    const workDays = Number.parseInt(String(c.workDays), 10);
    const restDays = Number.parseInt(String(c.restDays), 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) && workDays > 0 && restDays > 0) {
      cycleObj = {
        anchorDate,
        workDays,
        restDays,
        anchorStartsWork: c.anchorStartsWork !== false,
      };
      if (typeof g.timezone === "string" && g.timezone.trim()) {
        tz = g.timezone.trim();
      }
    }
  }

  if (!cycleObj && workDatesArr.length === 0) {
    return null;
  }

  const cfg = { timezone: tz };
  if (workDatesArr.length > 0) {
    cfg.workDates = workDatesArr;
  }
  if (cycleObj) {
    cfg.cycle = cycleObj;
  }
  return cfg;
}

/** 투표 대상 주에서 달력상 근무인 날의 요일 버튼만 막기 */
function computeCycleBlockedWeekdayKeysForSession(session) {
  const cfg = getMergedRepeatCycleConfigForComputation();
  if (!cfg) {
    return new Set();
  }

  const voteMonday = getVoteTargetWeekMondayIso(session);
  const blocked = new Set();
  const tz = cfg.timezone || SCHEDULE_TZ;

  for (let i = 0; i < 7; i++) {
    const iso = addCalendarDaysToIsoYmd(voteMonday, i);
    if (isCalendarDateWorkDay(iso, cfg)) {
      const key = weekdayKeyFromIsoYmd(iso, tz);
      if (key) {
        blocked.add(key);
      }
    }
  }
  return blocked;
}

/** 요일 버튼 막기: MON,TUE,... (.env SCHEDULE_BLOCKED_DAY_KEYS + JSON global.blockedDayKeys만, 주기 계산 제외) */
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

function getStaticBlockedDayKeysFromEnvAndJson() {
  const merged = new Set(parseEnvBlockedDayKeysSet());

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

function getMergedBlockedDayKeysForSession(session) {
  const merged = new Set(getStaticBlockedDayKeysFromEnvAndJson());
  for (const k of computeCycleBlockedWeekdayKeysForSession(session)) {
    merged.add(k);
  }
  return merged;
}

function mergeBlockedDayKeysForSessionAndUser(session, userId) {
  const merged = new Set(getMergedBlockedDayKeysForSession(session));

  loadUserWorkScheduleMap();
  const ucfg = userWorkScheduleCache.users[userId];
  if (ucfg && typeof ucfg === "object" && Array.isArray(ucfg.blockedDayKeys)) {
    for (const k of ucfg.blockedDayKeys) {
      if (typeof k === "string" && VALID_DAY_KEYS.has(k.toUpperCase())) {
        merged.add(k.toUpperCase());
      }
    }
  }

  return merged;
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
    .setDescription("주간(수~화, 한국 달력) 요일/시간 참여 여부를 조율판으로 생성합니다.")
    .addStringOption((option) =>
      option
        .setName("모드")
        .setDescription("비우면 기본. 특수도 규칙은 기본과 완전히 동일합니다(구분용).")
        .setRequired(false)
        .addChoices(
          { name: "기본", value: "default" },
          { name: "특수", value: "special" }
        )
    ),
  new SlashCommandBuilder()
    .setName("일정생성특수")
    .setDescription(
      "일정생성과 같으나 투표·조율 주간을 '다음 주 수'가 아니라 게시일이 속한 수~화 블록(저번 주기준)의 시작 수요일로 잡습니다."
    ),
  new SlashCommandBuilder()
    .setName("schedule_special")
    .setDescription("Same as /일정생성 — use if Korean slash UI is unreliable on your client."),
  new SlashCommandBuilder()
    .setName("일정마감")
    .setDescription("현재 채널의 최신 조율판을 즉시 마감하고 집계를 확정합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("시트불러오기")
    .setDescription(
      "실시간 Google 시트(GOOGLE_SHEET_LIVE_RANGE)를 읽어 같은 투표 주간의 조율판 임베드를 갱신합니다."
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
 *   priorWeekVoteWindow — true면 투표 주간을 "다음 주 수"가 아니라 게시일이 속한 수~화 블록의 시작 수요일(저번 주기준)으로 잡음.
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
    rows.push(["참여자 없음", startLabel, endLabel, "", ...DAYS.map(() => "X")]);
  }
  return rows;
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

/** 넓게 잡힌 LIVE_RANGE라도 조율판 열만 덮어써서 오른쪽 집계 영역은 clear 하지 않음 */
function getLiveSyncValuesOnlyRange(liveRange, dataRowCount) {
  const bang = liveRange.indexOf("!");
  const sheetPrefix = bang >= 0 ? liveRange.slice(0, bang + 1) : "Sheet1!";
  const a1Part = (bang >= 0 ? liveRange.slice(bang + 1) : liveRange).trim();
  const span = a1Part.includes(":") ? a1Part : `${a1Part}:${a1Part}`;
  const parts = span.split(":");
  const leftRaw = (parts[0] || "A1").trim();
  const rightRaw = (parts[1] || parts[0] || "A1").trim();
  const start = parseA1Cell(leftRaw) || { col: "A", colIndex: 1, row: 1 };
  const endParsed = parseA1Cell(rightRaw) || start;
  const rows = Math.max(start.row, endParsed.row, dataRowCount, 1);
  const endColIdx = start.colIndex + getScheduleGridColumnCount() - 1;
  const endCol = a1IndexToColumnLetters(endColIdx);
  return `${sheetPrefix}${start.col}${start.row}:${endCol}${rows}`;
}

async function appendSessionSummaryToSheet(session, closedAtMs) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return;
  }

  const sheets = await getSheetsClient();
  if (!sheets) {
    return;
  }

  const range = process.env.GOOGLE_SHEET_RANGE || "Sheet1!A:Z";
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
  const targetSheet = (meta.data.sheets || []).find((s) => s.properties?.title === sheetTitle);
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
  const liveRange = process.env.GOOGLE_SHEET_LIVE_RANGE;
  if (!spreadsheetId || !liveRange) {
    return;
  }

  const sheets = await getSheetsClient();
  if (!sheets) {
    return;
  }

  const rows = buildSheetRowsForSession(session);
  const valuesRange = getLiveSyncValuesOnlyRange(liveRange, rows.length);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: valuesRange,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: valuesRange,
    valueInputOption: "RAW",
    requestBody: {
      values: rows,
    },
  });
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
    .replace(/\s+/g, " ")
    .normalize("NFKC");
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
  const a = normalizeVoteDateLabel(formatIsoYmdForBoard(voteStartIso));
  const b = normalizeVoteDateLabel(formatIsoYmdForBoard(voteEndIso));
  return a === normalizeVoteDateLabel(startLabel) && b === normalizeVoteDateLabel(endLabel);
}

function resolveSheetParticipantToUserId(displayNameRaw, session) {
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
  const envMap = getScheduleSheetUserMapFromEnv();
  const fromMap = envMap[raw];
  if (fromMap != null && /^\d{17,20}$/.test(String(fromMap).trim())) {
    return String(fromMap).trim();
  }
  for (const [uid, ud] of session.users) {
    if ((ud.username || "").trim() === raw) {
      return uid;
    }
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

/** 시트 내용을 세션에 반영. 변경이 있으면 true */
function applyParsedLiveSheetToSession(session, parsed) {
  if (parsed.explicitEmpty && parsed.blocks.length === 0) {
    let changed = false;
    for (const [, ud] of session.users) {
      const m = ud.selectedDayTimes;
      if (m instanceof Map && m.size > 0) {
        ud.selectedDayTimes = new Map();
        changed = true;
      }
    }
    return changed;
  }

  let changed = false;
  const unresolved = new Set();

  for (const block of parsed.blocks) {
    const uid = resolveSheetParticipantToUserId(block.displayName, session);
    if (!uid) {
      unresolved.add(block.displayName);
      continue;
    }
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
      "[실시간시트→디스코드] 참가자 ID를 알 수 없어 건너뜀(닉네임·SCHEDULE_SHEET_USER_MAP·표시|유저ID 형식):",
      [...unresolved].join(", ")
    );
  }

  return changed;
}

/**
 * GOOGLE_SHEET_LIVE_RANGE 시트를 읽어, 투표 주간이 일치하는 활성 세션의 임베드·버튼을 갱신합니다.
 * @returns {{ matched: number; edited: number; parseError?: string }}
 */
async function importLiveSheetToDiscordSessions(client) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const liveRange = process.env.GOOGLE_SHEET_LIVE_RANGE;
  const out = { matched: 0, edited: 0, parseError: undefined };

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
  const readRange = getLiveSyncValuesOnlyRange(liveRange, maxRows);

  let values;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: readRange,
      valueRenderOption: "FORMATTED_VALUE",
    });
    values = res.data.values;
  } catch (error) {
    console.warn("[실시간시트→디스코드] 시트 읽기 실패:", error?.message || error);
    out.parseError = "fetch_failed";
    return out;
  }

  const parsed = parseLiveSheetValuesToParticipants(values);
  if (!parsed) {
    out.parseError = "parse_failed";
    return out;
  }

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
      console.warn(
        "[실시간시트→디스코드] 시트 시작/마감일과 조율판 세션이 안 맞음. 시트:",
        parsed.startLabel,
        "|",
        parsed.endLabel,
        "→ 세션(첫 예시):",
        formatIsoYmdForBoard(voteStartIso),
        "|",
        formatIsoYmdForBoard(voteEndIso),
        "(첫 참가자 행의 시작일·마감일 셀을 조율판과 동일하게 맞추세요.)"
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
    const changed = applyParsedLiveSheetToSession(session, parsed);
    if (!changed) {
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
    try {
      await appendSessionSummaryToSheet(session, Date.now());
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
  /** 기본: 게시일 블록의 **다음** 수요일 시작 주. 일정생성특수: 같은 블록의 시작 수요일(저번 주간 기준). */
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
  const lines = ["집계 현황표", "", "[요일별 시간표]"];
  for (const day of DAYS) {
    const mentions = getMentionsForDay(session, day.key);
    lines.push(`- ${formatDayAggregateHeadline(day, weekWednesdayIso)} (${mentions.length}명)`);
    lines.push(`  참가자: ${mentions.length > 0 ? mentions.join(", ") : "없음"}`);
    for (const time of TIME_SLOTS) {
      const dayTimeMentions = [];
      for (const [userId, userData] of session.users.entries()) {
        const times = userData.selectedDayTimes?.get(day.key);
        if (times && times.has(time)) {
          dayTimeMentions.push(`<@${userId}>`);
        }
      }
      lines.push(
        `  - ${time}: ${dayTimeMentions.length > 0 ? "O" : "X"} (${dayTimeMentions.length}명)`
      );
    }
    lines.push("");
  }

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
  const lines = ["집계 현황표", "", "[요일별 투표 인원]"];
  for (const day of DAYS) {
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

  const guideText = [
    "요일 버튼으로 먼저 대상 요일을 선택한 뒤, 시간 버튼으로 해당 요일 시간을 선택해 주세요. (복수 선택 가능)",
    "",
    "🔴 **빨간색으로 표시된 요일은 선택할 수 없습니다.**",
    "조율 주간(일자): 수요일 ~ 다음 주 화요일까지 한 주로 표시됩니다. (자동 마감 시각은 봇 설정·크론과 같습니다.)",
    "진행 기준: 가장 많은 인원이 선택한 시간대를 선정합니다.",
    "진행 시점: 차주 아이온2 정기점검 종료 후, 확정된 시간에 진행됩니다.",
  ].join("\n");

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
    .setTitle("주간 조율 마감 — 집계")
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
  const channelId = process.env.SCHEDULE_CHANNEL_ID;
  if (!channelId) {
    console.log("SCHEDULE_CHANNEL_ID 없음 — 주간 자동 일정/마감 크론을 등록하지 않습니다.");
    return;
  }

  if (process.env.SCHEDULE_SMOKE_TEST === "1") {
    console.warn(
      "[스모크] SCHEDULE_SMOKE_TEST=1 — 실제 수·일 크론은 등록하지 않습니다. 약 3초 후 게시, 25초 후 마감을 한 번 실행합니다. 끝나면 .env에서 제거하세요."
    );
    setTimeout(() => runWeeklyOpenJob(client, "[스모크]"), 3000);
    setTimeout(() => runWeeklyCloseJob(client, "[스모크]"), 25000);
    return;
  }

  cron.schedule(
    "0 0 * * 3",
    () => runWeeklyOpenJob(client),
    { timezone: SCHEDULE_TZ }
  );

  cron.schedule(
    "59 23 * * 0",
    () => runWeeklyCloseJob(client),
    { timezone: SCHEDULE_TZ }
  );

  console.log(
    `주간 크론 등록됨 (${SCHEDULE_TZ}): 수요일 00:00 게시, 일요일 23:59 마감·집계 → 채널 ${channelId}`
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`${readyClient.user.tag} 로그인 완료`);
  console.log("[봇이 읽은 index.js]", path.resolve(__dirname, "index.js"));
  loadUserWorkScheduleMap();
  const globalDates = getEnvGlobalWorkDateSet();
  if (globalDates) {
    console.log(`전역 근무일(.env): 달력상 ${globalDates.size}일 지정됨`);
  }
  const mergedCfg = getMergedRepeatCycleConfigForComputation();
  if (mergedCfg?.cycle || (mergedCfg?.workDates && mergedCfg.workDates.length > 0)) {
    const c = mergedCfg.cycle;
    const ow = Number.parseInt(process.env.SCHEDULE_VOTE_WEEK_OFFSET_WEEKS ?? "1", 10);
    if (c) {
      console.log(
        `근무 패턴 → 투표 대상 주(월 시작 + ${Number.isFinite(ow) ? ow : 1}주): 그 주 달력상 근무인 날의 요일 버튼만 빨갛게 막음 (오늘 달력과 무관하게 투표 가능)`
      );
      console.log(
        `  주기: 휴무 ${c.restDays}일 → 근무 ${c.workDays}일, 기준일 ${c.anchorDate} (${c.anchorStartsWork ? "기준일=근무 시작" : "기준일=휴무 시작"})`
      );
    } else if (mergedCfg.workDates?.length) {
      console.log(`근무일 목록(workDates): 투표 대상 주에 걸리는 날의 요일 버튼만 막음`);
    }
  }
  const envBlockedDays = parseEnvBlockedDayKeysSet();
  if (envBlockedDays.size > 0) {
    console.log(`요일 버튼 차단(.env): ${[...envBlockedDays].join(", ")}`);
  }
  const gb = userWorkScheduleCache.global?.blockedDayKeys;
  if (Array.isArray(gb) && gb.length > 0) {
    console.log(`요일 버튼 차단(JSON global): ${gb.filter((x) => typeof x === "string").join(", ")}`);
  }
  const schedulePath = getUserWorkSchedulePath();
  const examplePath = path.join(__dirname, "user-work-schedule.example.json");
  try {
    if (
      envBlockedDays.size === 0 &&
      fs.existsSync(examplePath) &&
      !fs.existsSync(schedulePath)
    ) {
      console.warn(
        "요일 버튼 차단이 안 되면: 예시 파일 이름을 user-work-schedule.json 으로 복사하거나, .env에 SCHEDULE_BLOCKED_DAY_KEYS=TUE,WED,THU 를 넣은 뒤 봇을 재시작하세요."
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
    if (process.env.GOOGLE_SPREADSHEET_ID && process.env.GOOGLE_SHEET_LIVE_RANGE) {
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
          text = "GOOGLE_SPREADSHEET_ID 또는 GOOGLE_SHEET_LIVE_RANGE 가 없어 시트를 읽을 수 없어요.";
        } else if (r.parseError === "no_sheets_client") {
          text = "Google 서비스 계정(GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)이 없어요.";
        } else if (r.parseError === "fetch_failed") {
          text = "시트를 읽지 못했어요. 스프레드시트 공유·범위를 확인해 주세요.";
        } else if (r.parseError === "parse_failed") {
          text = "시트 형식을 해석하지 못했어요. 봇이 쓰는 표(참여자/시작일/마감일/시간/요일 열)와 같은지 확인해 주세요.";
        } else if (r.matched === 0) {
          text =
            "시트의 시작일·마감일과 같은 투표 주간을 가진 활성 조율판이 없어요. (다른 주간 시트이거나 조율판이 없을 수 있어요.)";
        } else if (r.edited === 0) {
          text = `주간이 맞는 조율판은 ${r.matched}개인데, 변경할 내용이 없거나 시트 표시명을 디스코드 유저와 연결하지 못했어요. SCHEDULE_SHEET_USER_MAP JSON 또는 A열 \`표시명|유저ID\` 형식을 쓰면 됩니다.`;
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

client.login(process.env.DISCORD_TOKEN);

try {
  const { startDashboardIfEnabled } = require("./dashboard/server");
  startDashboardIfEnabled(client, {
    getActiveSessionCount: () => sessions.size,
  });
} catch (err) {
  console.warn(
    "[dashboard] ./dashboard/server 로드 실패 — 대시보드 없이 봇만 실행합니다. (서버에서 `npm ci` 하면 해결되는 경우가 많습니다.)",
    err && err.message ? err.message : err
  );
}
