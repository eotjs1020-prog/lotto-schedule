require("dotenv").config();
const fs = require("fs");
const http = require("http");
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

const commands = [
  new SlashCommandBuilder()
    .setName("일정생성")
    .setDescription("주간(월~일) 요일/시간 참여 여부를 조율판으로 생성합니다."),
  new SlashCommandBuilder()
    .setName("일정마감")
    .setDescription("현재 채널의 최신 조율판을 즉시 마감하고 집계를 확정합니다.")
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

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("길드 전용 슬래시 명령어 등록 완료");
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("전역 슬래시 명령어 등록 완료 (반영까지 시간 소요 가능)");
}

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function registerSession(createdBy, channelId = null) {
  const sessionId = makeSessionId();
  const session = {
    id: sessionId,
    users: new Map(),
    createdBy,
    channelId,
    messageId: null,
    createdAt: Date.now(),
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

function getVoteWindowIsoForSession(session) {
  const voteStartIso = formatCalendarDateInTz(session.createdAt, SCHEDULE_TZ);
  const weekMondayIso = getMondayIsoContaining(voteStartIso);
  const voteEndIso = addCalendarDaysToIsoYmd(weekMondayIso, 6);
  return { voteStartIso, voteEndIso };
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
  const lines = ["집계 현황표", "", "[요일별 시간표]"];
  for (const day of DAYS) {
    const mentions = getMentionsForDay(session, day.key);
    lines.push(`- ${day.label}요일 (${mentions.length}명)`);
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
  const lines = ["집계 현황표", "", "[요일별 투표 인원]"];
  for (const day of DAYS) {
    const dayCount = getMentionsForDay(session, day.key).length;
    lines.push(
      `- ${day.label}요일: ${dayCount}명\n${formatDayTimeSlotVotesHoriz(session, day.key)}`
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
  const lines = [];

  for (const day of DAYS) {
    const mentions = getMentionsForDay(session, day.key);
    lines.push(
      `- ${day.label}요일: ${mentions.length}명\n${formatDayTimeSlotVotesHoriz(session, day.key)}`
    );
  }

  const guideText = [
    "요일 버튼으로 먼저 대상 요일을 선택한 뒤, 시간 버튼으로 해당 요일 시간을 선택해 주세요. (복수 선택 가능)",
    "",
    "🔴 **빨간색으로 표시된 요일은 선택할 수 없습니다.**",
    "집계 기간: 매주 수요일 ~ 일요일 23:59까지",
    "진행 기준: 가장 많은 인원이 선택한 시간대를 선정합니다.",
    "진행 시점: 차주 아이온2 정기점검 종료 후, 확정된 시간에 진행됩니다.",
  ].join("\n");

  const head = [];
  const sourceSession = session.createdAt ? session : { ...session, createdAt: Date.now() };
  const { voteStartIso, voteEndIso } = getVoteWindowIsoForSession(sourceSession);
  head.push(`**시작일**\n${formatIsoYmdForBoard(voteStartIso)}`);
  head.push("");
  head.push(`**마감일**\n${formatIsoYmdForBoard(voteEndIso)}`);
  head.push("");
  head.push(`**안내**\n${guideText}`);
  head.push("");
  const description = [...head, ...lines].join("\n");

  return new EmbedBuilder()
    .setTitle("요일/시간 조율")
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
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "일정마감") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "이 명령어는 관리자만 사용할 수 있어요.",
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

      await closeSessionAndPublishSummary(client, latestSession, "[수동마감]");
      await interaction.reply({
        content: "최신 조율판을 마감하고 집계를 확정했어요.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName !== "일정생성") {
      return;
    }

    const { sessionId, session } = registerSession(interaction.user.id, interaction.channelId);

    const embed = buildSummaryEmbed(session);
    const message = await interaction.reply({
      embeds: [embed],
      components: buildComponents(sessionId, session),
      fetchReply: true,
    });

    session.messageId = message.id;
    scheduleLiveSheetSync(session);
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

// Render Web Service free tier needs an open port.
const port = process.env.PORT;
if (port) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bot is running");
    })
    .listen(port, () => {
      console.log(`Health server listening on port ${port}`);
    });
}
