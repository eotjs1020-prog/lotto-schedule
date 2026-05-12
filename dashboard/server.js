"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");

const DISCORD_API = "https://discord.com/api/v10";
const ADMINISTRATOR = 1n << 3n;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Discord 클라이언트·임베드에 가까운 다크 테마 (대시보드·로그인 오류 페이지 공통) */
function dashboardSharedStyles() {
  return `
:root {
  --bg-app: #313338;
  --bg-embed: #2b2d31;
  --bg-input: #1e1f22;
  --bg-code: #111214;
  --border-faint: rgba(0,0,0,0.35);
  --text-normal: #dbdee1;
  --text-heading: #f2f3f5;
  --text-muted: #949ba4;
  --link: #00a8fc;
  --blurple: #5865f2;
  --green: #248046;
  --red: #da373c;
  --gray: #4f545c;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: "Noto Sans KR", "Segoe UI", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.45;
  background: var(--bg-app);
  color: var(--text-normal);
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 0.88em;
  background: var(--bg-code);
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--text-heading);
}
.muted { color: var(--text-muted); font-size: 0.92rem; }
.warn { color: var(--red); }
.embed {
  background: var(--bg-embed);
  border-radius: 4px;
  border-left: 4px solid var(--embed-accent, var(--blurple));
  padding: 12px 16px 14px 12px;
  margin-bottom: 16px;
  max-width: 100%;
}
.embed--brand { --embed-accent: var(--blurple); }
.embed--green { --embed-accent: var(--green); }
.embed--gray { --embed-accent: var(--gray); }
.embed--danger { --embed-accent: var(--red); }
.embed__kicker {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 0 0 6px;
}
.embed__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0 0 8px;
  line-height: 1.25;
}
.embed__desc {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0 0 12px;
  line-height: 1.45;
}
.kv { display: flex; flex-direction: column; margin-top: 2px; }
.kv__row {
  display: grid;
  grid-template-columns: 8.75rem 1fr;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border-faint);
  font-size: 14px;
  align-items: start;
}
.kv__row:first-of-type { border-top: none; padding-top: 0; }
.kv__k { color: var(--text-muted); font-weight: 500; }
.kv__v { color: var(--text-normal); word-break: break-word; }
.board-list { list-style: none; margin: 0; padding: 0; }
.board-item {
  border-top: 1px solid var(--border-faint);
  padding: 12px 0;
  margin: 0;
}
.board-item:first-child { border-top: none; padding-top: 4px; }
.board-item__head { font-weight: 600; color: var(--text-heading); margin-bottom: 4px; font-size: 14px; }
.board-item__meta { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; line-height: 1.4; }
.board-item__foot { font-size: 13px; }
.d-btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.d-btn {
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  min-height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.d-btn:active { filter: brightness(0.93); }
.d-btn--primary { background: var(--blurple); }
.d-btn--green { background: var(--green); }
.d-btn--danger { background: var(--red); }
.d-btn--gray { background: var(--gray); }
.inp, .ta {
  width: 100%;
  max-width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  background: var(--bg-input);
  border: none;
  border-radius: 4px;
  color: var(--text-heading);
  font: inherit;
}
.ta { font-family: ui-monospace, monospace; font-size: 13px; line-height: 1.5; resize: vertical; min-height: 80px; }
.form-label { display: block; font-weight: 600; font-size: 13px; color: var(--text-heading); margin-top: 14px; }
.form-label .muted { display: block; margin-top: 4px; font-weight: 400; }
.sched-pill-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.sched-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  padding: 8px 12px;
  border-radius: 3px;
  background: var(--blurple);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
.sched-pill input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  margin: 0;
}
.sched-pill:has(input:checked) { background: var(--red); }
.sched-pill:has(input:focus-visible) { outline: 2px solid var(--link); outline-offset: 2px; }
.dashOut {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-code);
  border-radius: 4px;
  max-height: 16rem;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
}
.dash-header {
  background: #1e1f22;
  border-bottom: 1px solid var(--border-faint);
}
.dash-header__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
}
.dash-header-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 0 12px 0 16px;
  border-top: 1px solid var(--border-faint);
  background: #18191c;
}
.dash-tab {
  display: inline-block;
  padding: 10px 14px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.dash-tab:hover { color: var(--text-heading); text-decoration: none; }
.dash-tab--active {
  color: var(--text-heading);
  border-bottom-color: var(--blurple);
}
.dash-title { font-size: 17px; font-weight: 700; color: var(--text-heading); margin: 0; letter-spacing: -0.02em; }
.dash-title__sub { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.dash-nav a { margin-left: 14px; font-size: 14px; font-weight: 500; }
.dash-main { max-width: 560px; margin: 0 auto; padding: 20px 16px 48px; }
.footer-note { font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.55; max-width: 560px; margin-left: auto; margin-right: auto; padding: 0 16px 32px; }
.simple-wrap { max-width: 480px; margin: 48px auto; padding: 0 16px; }
.simple-wrap .embed ul { margin: 8px 0 0; padding-left: 1.2rem; color: var(--text-normal); }
.simple-wrap .embed p { margin: 0 0 10px; }
`;
}

/**
 * @param {string} title
 * @param {"brand" | "danger" | "gray"} embedVariant
 * @param {string} innerBodyHtml
 */
function renderSimpleDashPage(title, embedVariant, innerBodyHtml) {
  const cls =
    embedVariant === "danger" ? "embed--danger" : embedVariant === "gray" ? "embed--gray" : "embed--brand";
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${dashboardSharedStyles()}</style>
</head>
<body>
  <div class="simple-wrap">
    <article class="embed ${cls}">${innerBodyHtml}</article>
  </div>
</body>
</html>`;
}

function isDashboardEnabled() {
  const raw = process.env.DASHBOARD_ENABLE;
  if (raw === undefined || raw === null) {
    return false;
  }
  const s = String(raw).trim();
  return s === "1" || s.toLowerCase() === "true";
}

/** 봇 .env(index.js와 같은 디렉터리)에 DASHBOARD_ENABLE 이 있는지 안내 */
function dashboardEnvFileHint() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) {
      return `[dashboard] .env 없음 → ${envPath} 생성 후 DASHBOARD_ENABLE=1 추가, sudo systemctl restart discord-bot`;
    }
    const text = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\n/);
    const hit = lines.find((line) => {
      const t = line.trim();
      return /^DASHBOARD_ENABLE\s*=/i.test(t) && !t.trimStart().startsWith("#");
    });
    if (!hit) {
      return `[dashboard] ${envPath} 에 DASHBOARD_ENABLE= 줄 없음(또는 # 주석). 추가: DASHBOARD_ENABLE=1`;
    }
    const m = hit.match(/^\s*DASHBOARD_ENABLE\s*=\s*(.*)$/i);
    const val = m ? String(m[1]).trim().replace(/^["']|["']$/g, "") : "";
    if (val === "") {
      return `[dashboard] ${envPath} 에 DASHBOARD_ENABLE= 만 있고 값이 비어 있음 → DASHBOARD_ENABLE=1`;
    }
    if (val !== "1" && val.toLowerCase() !== "true") {
      return `[dashboard] ${envPath} 값이 "${val}" → 1 또는 true 만 인정됩니다.`;
    }
    return `[dashboard] ${envPath} 에는 DASHBOARD_ENABLE=${val} 로 보이는데 process.env 에 없음 → 같은 경로의 index.js로 봇이 실행되는지(systemctl WorkingDirectory·ExecStart) 확인`;
  } catch (e) {
    return `[dashboard] .env 점검 실패: ${e.message || e}`;
  }
}

function startLegacyHealthServer(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) {
    return;
  }
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bot is running");
    })
    .listen(p, () => {
      console.log(`Health server listening on port ${p}`);
    });
}

async function discordOAuthTokenExchange({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || res.statusText;
    throw new Error(`token ${res.status}: ${String(msg)}`);
  }
  return data;
}

async function fetchDiscordUserGuilds(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || res.statusText);
  }
  return Array.isArray(data) ? data : [];
}

async function fetchDiscordUserMe(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || res.statusText);
  }
  return data;
}

function userIsGuildAdministratorIn(guilds, guildId) {
  const g = guilds.find((x) => x && String(x.id) === String(guildId));
  if (!g || g.permissions == null) {
    return false;
  }
  try {
    const bits = BigInt(String(g.permissions));
    return (bits & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

function parseEnvSnowflakeSet(envKey) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return new Set();
  }
  const out = new Set();
  for (const part of String(raw).split(/[\s,]+/)) {
    const id = part.trim();
    if (/^\d{17,22}$/.test(id)) {
      out.add(id);
    }
  }
  return out;
}

function userInOAuthGuildList(guilds, guildId) {
  return Boolean(guilds.find((x) => x && String(x.id) === String(guildId)));
}

/** Administrator 이거나 .env 로 지정한 부관리자(유저 ID / 역할) */
async function userHasDashboardAccess(discordClient, guilds, guildId, userId) {
  if (userIsGuildAdministratorIn(guilds, guildId)) {
    return true;
  }
  if (!userInOAuthGuildList(guilds, guildId)) {
    return false;
  }
  const uid = String(userId);
  if (parseEnvSnowflakeSet("DASHBOARD_ACCESS_USER_IDS").has(uid)) {
    return true;
  }
  const allowRoles = parseEnvSnowflakeSet("DASHBOARD_ACCESS_ROLE_IDS");
  if (allowRoles.size === 0) {
    return false;
  }
  if (!discordClient.isReady()) {
    console.warn("[dashboard] 부관리자(역할) 검사: 봇이 아직 준비 전이라 건너뜀");
    return false;
  }
  try {
    const guild = await discordClient.guilds.fetch(String(guildId));
    const member = await guild.members.fetch(uid).catch(() => null);
    if (!member) {
      return false;
    }
    for (const rid of allowRoles) {
      if (member.roles.cache.has(rid)) {
        return true;
      }
    }
  } catch (e) {
    console.warn("[dashboard] 부관리자(역할) 검사 실패:", e?.message || e);
    return false;
  }
  return false;
}

function dayKeyToKoreanLabel(key) {
  const map = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };
  return map[key] || key;
}

function renderBoardsSection(snapshot, guildIdForLinks) {
  if (snapshot && snapshot.error) {
    return `<article class="embed embed--danger"><p class="embed__title" style="margin-top:0">스냅샷 오류</p><p class="warn" style="margin:0">${escapeHtml(String(snapshot.error))}</p></article>`;
  }
  if (!snapshot || !Array.isArray(snapshot.boards)) {
    return `<article class="embed embed--gray"><p class="embed__kicker">조율판</p><p class="embed__desc" style="margin:0"><em>조율판 스냅샷을 불러오지 못했어요.</em></p></article>`;
  }
  if (snapshot.boards.length === 0) {
    return `<article class="embed embed--gray"><p class="embed__kicker">조율판</p><h2 class="embed__title">활성 조율판</h2><p class="embed__desc" style="margin:0"><em>메시지가 있는 활성 조율판이 없어요.</em> 세션만 있고 아직 게시 전일 수 있어요.</p></article>`;
  }
  const gid = guildIdForLinks ? escapeHtml(String(guildIdForLinks)) : "";
  const rows = snapshot.boards
    .map((b) => {
      const mode = b.priorWeek ? "특수(+0)" : "기본(+7)";
      const locks =
        b.manualLockedKeys && b.manualLockedKeys.length > 0
          ? b.manualLockedKeys.map(dayKeyToKoreanLabel).join(", ")
          : "—";
      const msgId = b.messageId != null ? escapeHtml(String(b.messageId)) : "";
      const chId = escapeHtml(String(b.channelId));
      const jump =
        gid && msgId
          ? `<a href="https://discord.com/channels/${gid}/${chId}/${msgId}" target="_blank" rel="noopener">디스코드에서 열기</a>`
          : "—";
      return `<li class="board-item">
  <div class="board-item__head">채널 <code>${chId}</code></div>
  <div class="board-item__meta">투표 기간 · ${escapeHtml(b.voteStartIso)} ~ ${escapeHtml(b.voteEndIso)}<br/>
  모드 · ${escapeHtml(mode)} · 관리자 잠금 · ${escapeHtml(locks)}</div>
  <div class="board-item__foot">${jump}</div>
</li>`;
    })
    .join("\n");
  return `<article class="embed embed--brand">
<p class="embed__kicker">조율판</p>
<h2 class="embed__title">활성 조율판</h2>
<p class="embed__desc">디스코드에 올라간 조율 메시지와 동일한 구간·모드를 요약해 보여 줍니다. 링크로 해당 메시지로 이동할 수 있어요.</p>
<ul class="board-list">${rows}</ul>
</article>`;
}

function renderFeaturesRow(snapshot) {
  if (!snapshot || !snapshot.features) {
    return "";
  }
  const f = snapshot.features;
  const cron = f.scheduleCron ? "켜짐" : "꺼짐";
  const live = f.sheetsLive ? "켜짐" : "꺼짐";
  const slash = f.guildSlash ? "길드 등록" : "전역(느림)";
  return `<div class="kv__row"><span class="kv__k">주간 크론</span><span class="kv__v">${escapeHtml(cron)}</span></div>
    <div class="kv__row"><span class="kv__k">실시간 시트</span><span class="kv__v">${escapeHtml(live)}</span></div>
    <div class="kv__row"><span class="kv__k">슬래시 등록</span><span class="kv__v">${escapeHtml(slash)}</span></div>`;
}

function renderRemoteControlPanel(hasControl, defaultChannelId) {
  const def = escapeHtml(defaultChannelId || "");
  const disabledNote = hasControl
    ? ""
    : `<p class="warn">원격 제어 API가 연결되지 않았습니다. 봇 <code>index.js</code>를 최신으로 배포했는지 확인하세요.</p>`;
  const buttons = hasControl
    ? `<div class="d-btn-row">
<button type="button" class="d-btn d-btn--primary" id="dashPostDef">조율판 게시 (기본)</button>
<button type="button" class="d-btn d-btn--gray" id="dashPostSp">조율판 게시 (특수)</button>
<button type="button" class="d-btn d-btn--danger" id="dashClose">최신 조율판 마감</button>
<button type="button" class="d-btn d-btn--green" id="dashSheet">시트 동기화</button>
</div>`
    : "";
  const hc = hasControl ? "true" : "false";
  return `<article class="embed embed--gray">
<p class="embed__kicker">관리</p>
<h2 class="embed__title">원격 제어</h2>
<p class="embed__desc">채널은 <code>GUILD_ID</code> 길드의 텍스트 채널만 가능합니다. 슬래시 <code>/일정생성</code>·<code>/일정마감</code>·<code>/시트불러오기</code>와 같은 동작입니다.</p>
${disabledNote}
<label class="form-label" for="dashCh">채널 ID</label>
<input id="dashCh" class="inp" type="text" value="${def}" autocomplete="off" spellcheck="false" />
${buttons}
<pre id="dashCtlOut" class="dashOut"></pre>
</article>
<script>
(function(){
  var pre = document.getElementById("dashCtlOut");
  function show(obj){ pre.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2); }
  async function post(path, body){
    var r = await fetch(path, { method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body||{}) });
    var t = await r.text();
    var j; try{ j = JSON.parse(t); }catch(e){ j = { _raw: t }; }
    show({ http: r.status, body: j });
  }
  function ch(){ return (document.getElementById("dashCh")||{}).value.trim(); }
  if(${hc}){
    document.getElementById("dashPostDef").onclick = function(){ post("/dashboard/api/control/post-board", { channelId: ch(), mode: "default" }); };
    document.getElementById("dashPostSp").onclick = function(){ post("/dashboard/api/control/post-board", { channelId: ch(), mode: "special" }); };
    document.getElementById("dashClose").onclick = function(){ post("/dashboard/api/control/close-latest", { channelId: ch() }); };
    document.getElementById("dashSheet").onclick = function(){ post("/dashboard/api/control/sheet-sync", {}); };
  }
})();
</script>`;
}

const SCHED_DAY_KEYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SCHED_DAY_LABEL = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };

/**
 * @param {{
 *   path: string;
 *   workDates: string[];
 *   holidayDates: string[];
 *   blockedDayKeys: string[];
 *   boardGuideText: string;
 *   usesDefaultGuide: boolean;
 * }} sf
 * @param {boolean} hasSave
 */
function renderScheduleConfigPanel(sf, hasSave) {
  const workLines = escapeHtml((sf.workDates || []).join("\n"));
  const holLines = escapeHtml((sf.holidayDates || []).join("\n"));
  const guideEsc = escapeHtml(sf.boardGuideText || "");
  const chk = SCHED_DAY_KEYS.map((key) => {
    const on = (sf.blockedDayKeys || []).includes(key);
    const lab = SCHED_DAY_LABEL[key] || key;
    return `<label class="sched-pill"><input type="checkbox" class="dashSchedChk" data-dk="${key}" ${
      on ? "checked" : ""
    }/> ${escapeHtml(lab)}</label>`;
  }).join("");
  const warn = hasSave
    ? ""
    : `<p class="warn">저장 API가 연결되지 않았습니다. <code>index.js</code>의 <code>startDashboardIfEnabled</code>에 <code>saveDashboardScheduleConfig</code>가 있는지 확인하세요.</p>`;
  const btn = hasSave
    ? `<div class="d-btn-row"><button type="button" class="d-btn d-btn--green" id="dashSchedSave">파일에 저장</button></div>`
    : "";
  const hc = hasSave ? "true" : "false";
  return `<article class="embed embed--green">
${warn}
<textarea id="dashHol" hidden readonly tabindex="-1" aria-hidden="true">${holLines}</textarea>
<textarea id="dashWork" hidden readonly tabindex="-1" aria-hidden="true">${workLines}</textarea>
<label class="form-label">매주 막을 요일</label>
<div class="sched-pill-row">${chk}</div>
<label class="form-label" for="dashGuide">조율판 안내글</label>
<textarea id="dashGuide" class="inp ta" rows="10" spellcheck="false" placeholder="(기본 안내 사용 중)">${guideEsc}</textarea>
${btn}
<pre id="dashSchedOut" class="dashOut"></pre>
<script>
(function(){
  var pre = document.getElementById("dashSchedOut");
  function show(obj){ pre.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2); }
  async function save(){
    var nl = String.fromCharCode(10);
    var hol = document.getElementById("dashHol").value;
    var work = document.getElementById("dashWork").value;
    var guide = document.getElementById("dashGuide").value;
    var blocked = [];
    document.querySelectorAll(".dashSchedChk").forEach(function(el){
      if(el.checked) blocked.push(el.getAttribute("data-dk"));
    });
    var r = await fetch("/dashboard/api/schedule-config", { method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ holidayDates: hol, workDates: work, blockedDayKeys: blocked, boardGuideText: guide }) });
    var t = await r.text();
    var j; try{ j = JSON.parse(t); }catch(e){ j = { _raw: t }; }
    show({ http: r.status, body: j });
    if(r.ok && j && j.scheduleFile){
      document.getElementById("dashHol").value = (j.scheduleFile.holidayDates||[]).join(nl);
      document.getElementById("dashWork").value = (j.scheduleFile.workDates||[]).join(nl);
      document.getElementById("dashGuide").value = j.scheduleFile.boardGuideText || "";
      var setB = new Set(j.scheduleFile.blockedDayKeys||[]);
      document.querySelectorAll(".dashSchedChk").forEach(function(el){
        el.checked = setB.has(el.getAttribute("data-dk"));
      });
    }
  }
  if(${hc}){ document.getElementById("dashSchedSave").onclick = save; }
})();
</script>
</article>`;
}

/**
 * @param {"status" | "schedule"} activeTab
 * @param {string} docTitle
 * @param {{ displayName: string; guildName: string }} ctx
 * @param {string} mainInnerHtml
 */
function renderDashboardLayout(activeTab, docTitle, ctx, mainInnerHtml) {
  const c1 = activeTab === "status" ? " dash-tab--active" : "";
  const c2 = activeTab === "schedule" ? " dash-tab--active" : "";
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(docTitle)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${dashboardSharedStyles()}</style>
</head>
<body>
  <header class="dash-header">
    <div class="dash-header__top">
      <div>
        <h1 class="dash-title">조율 봇</h1>
        <span class="dash-title__sub">대시보드 · ${escapeHtml(ctx.guildName)}</span>
      </div>
      <nav class="dash-nav">
        <span class="muted">${escapeHtml(ctx.displayName)}</span>
        <a href="/dashboard/api/snapshot.json" target="_blank" rel="noopener">JSON</a>
        <a href="/dashboard/logout">로그아웃</a>
      </nav>
    </div>
    <nav class="dash-header-tabs" aria-label="대시보드 구역">
      <a href="/dashboard" class="dash-tab${c1}">상태</a>
      <a href="/dashboard/schedule" class="dash-tab${c2}">스케줄 작성</a>
    </nav>
  </header>
  <main class="dash-main">
    ${mainInnerHtml}
  </main>
  <p class="footer-note">접속: <code>GUILD_ID</code> 길드의 <strong>Administrator</strong> 이거나, <code>DASHBOARD_ACCESS_USER_IDS</code> / <code>DASHBOARD_ACCESS_ROLE_IDS</code>(.env)에 해당하는 경우입니다. 빨강 요일은 대시보드 JSON만 반영합니다. 봇 재시작 시 메모리 조율판은 초기화됩니다.</p>
</body>
</html>`;
}

/**
 * DASHBOARD_ENABLE=1 일 때 OAuth + 길드 관리자 전용 상태 페이지.
 * @param {import("discord.js").Client} discordClient
 * @param {{
 *   getActiveSessionCount?: () => number;
 *   getDashboardSnapshot?: () => Record<string, unknown>;
 *   dashboardCloseLatestInChannel?: (channelId: string) => Promise<Record<string, unknown>>;
 *   dashboardImportSheet?: () => Promise<Record<string, unknown>>;
 *   dashboardPostBoard?: (channelId: string, mode: string) => Promise<Record<string, unknown>>;
 *   saveDashboardScheduleConfig?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
 * }} [options]
 */
function startDashboardIfEnabled(discordClient, options = {}) {
  const dashRaw = process.env.DASHBOARD_ENABLE;
  console.log(
    `[dashboard] 시작 점검 (DASHBOARD_ENABLE=${dashRaw === undefined ? "(env에 없음)" : JSON.stringify(String(dashRaw).trim())})`
  );

  if (!isDashboardEnabled()) {
    console.log(
      "[dashboard] 비활성(DASHBOARD_ENABLE 이 1 또는 true 가 아님) — 3847 등 HTTP 대시보드는 뜨지 않습니다."
    );
    console.log(dashboardEnvFileHint());
    const port = process.env.PORT;
    if (port) {
      startLegacyHealthServer(port);
    }
    return;
  }

  const getActiveSessionCount =
    typeof options.getActiveSessionCount === "function" ? options.getActiveSessionCount : null;
  const getDashboardSnapshot =
    typeof options.getDashboardSnapshot === "function" ? options.getDashboardSnapshot : null;
  const dashboardCloseLatestInChannel =
    typeof options.dashboardCloseLatestInChannel === "function"
      ? options.dashboardCloseLatestInChannel
      : null;
  const dashboardImportSheet =
    typeof options.dashboardImportSheet === "function" ? options.dashboardImportSheet : null;
  const dashboardPostBoard =
    typeof options.dashboardPostBoard === "function" ? options.dashboardPostBoard : null;
  const saveDashboardScheduleConfig =
    typeof options.saveDashboardScheduleConfig === "function"
      ? options.saveDashboardScheduleConfig
      : null;

  const clientSecret = process.env.DISCORD_CLIENT_SECRET
    ? String(process.env.DISCORD_CLIENT_SECRET).trim()
    : "";
  const redirectUriRaw = process.env.DASHBOARD_OAUTH_REDIRECT_URI;
  const redirectUri = redirectUriRaw ? String(redirectUriRaw).trim() : "";
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET
    ? String(process.env.DASHBOARD_SESSION_SECRET).trim()
    : "";
  const clientId = process.env.CLIENT_ID ? String(process.env.CLIENT_ID).trim() : "";
  const guildId = process.env.GUILD_ID ? String(process.env.GUILD_ID).trim() : "";

  const missing = [];
  if (!clientSecret) {
    missing.push("DISCORD_CLIENT_SECRET");
  }
  if (!redirectUri) {
    missing.push("DASHBOARD_OAUTH_REDIRECT_URI");
  }
  if (!sessionSecret) {
    missing.push("DASHBOARD_SESSION_SECRET");
  }
  if (!clientId) {
    missing.push("CLIENT_ID");
  }
  if (!guildId) {
    missing.push("GUILD_ID");
  }
  if (missing.length > 0) {
    console.warn(
      `[dashboard] DASHBOARD_ENABLE=1 이지만 아래 변수가 비어 있어 대시보드를 건너뜁니다: ${missing.join(", ")}`
    );
    if (process.env.PORT) {
      startLegacyHealthServer(process.env.PORT);
    }
    return;
  }

  const listenPort = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3847);
  if (!Number.isFinite(listenPort) || listenPort <= 0) {
    console.warn("[dashboard] 유효한 DASHBOARD_PORT 또는 PORT 가 없습니다.");
    return;
  }

  console.log(
    "[dashboard] OAuth 설정: redirect_uri는 디스코드 포털 Redirects와 완전히 동일해야 합니다 →",
    redirectUri
  );

  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.DASHBOARD_COOKIE_SECURE === "1",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.get("/", (_req, res) => {
    res.type("text/plain; charset=utf-8").send("Bot is running");
  });

  app.get("/dashboard/login", (req, res) => {
    const err = req.query.error;
    if (err === "forbidden") {
      res
        .status(403)
        .type("text/html; charset=utf-8")
        .send(
          renderSimpleDashPage(
            "접근 불가",
            "danger",
            `<p class="embed__title" style="margin-top:0">권한 없음</p>
<p>이 길드(<code>${escapeHtml(guildId)}</code>) 대시보드에 들어올 권한이 없어요. 아래 중 하나여야 합니다.</p>
<ul>
  <li><strong>Administrator</strong> 권한, 또는</li>
  <li><code>.env</code>의 <code>DASHBOARD_ACCESS_USER_IDS</code>에 본인 유저 ID, 또는</li>
  <li><code>DASHBOARD_ACCESS_ROLE_IDS</code>의 역할을 본인이 보유 (봇이 길드에 있고 멤버를 읽을 수 있어야 함)</li>
</ul>
<p><a href="/dashboard/login">다시 로그인</a></p>`
          )
        );
      return;
    }
    if (err === "oauth") {
      res
        .status(502)
        .type("text/html; charset=utf-8")
        .send(
          renderSimpleDashPage(
            "로그인 실패",
            "gray",
            `<p class="embed__title" style="margin-top:0">OAuth 오류</p>
<p>디스코드 로그인 처리 중 문제가 났어요.</p>
<ul>
  <li>개발자 포털 OAuth2 <strong>Redirects</strong>와 <code>.env</code>의 <code>DASHBOARD_OAUTH_REDIRECT_URI</code>가 <strong>완전히 동일</strong>한지 확인 (<code>http</code>/<code>https</code>, 포트, 경로 <code>/auth/discord/callback</code>).</li>
  <li><code>DISCORD_CLIENT_SECRET</code>은 봇 토큰이 아니라 앱의 <strong>OAuth2 Client Secret</strong>입니다.</li>
  <li>서버: <code>sudo journalctl -u discord-bot -n 30 --no-pager | grep dashboard</code></li>
</ul>
<p><a href="/dashboard/login">다시 시도</a></p>`
          )
        );
      return;
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify guilds",
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
  });

  app.get("/auth/discord/callback", async (req, res) => {
    const qErr = typeof req.query.error === "string" ? req.query.error : "";
    const qDesc =
      typeof req.query.error_description === "string" ? req.query.error_description : "";
    if (qErr) {
      console.error("[dashboard] Discord 콜백 query 오류:", qErr, qDesc || "");
      res.redirect("/dashboard/login?error=oauth");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      console.error("[dashboard] 콜백에 code 없음 — Redirect URI 불일치·취소·만료 가능");
      res.redirect("/dashboard/login?error=oauth");
      return;
    }
    try {
      const tokenJson = await discordOAuthTokenExchange({
        code,
        clientId,
        clientSecret,
        redirectUri,
      });
      const accessToken = tokenJson.access_token;
      if (!accessToken) {
        throw new Error("no access_token");
      }
      const [guilds, me] = await Promise.all([
        fetchDiscordUserGuilds(accessToken),
        fetchDiscordUserMe(accessToken),
      ]);
      const userIdStr = String(me.id);
      const allowed = await userHasDashboardAccess(discordClient, guilds, guildId, userIdStr);
      if (!allowed) {
        res.redirect("/dashboard/login?error=forbidden");
        return;
      }
      req.session.dashboardUser = {
        id: String(me.id),
        username: me.username != null ? String(me.username) : "",
        global_name: me.global_name != null ? String(me.global_name) : "",
      };
      res.redirect("/dashboard");
    } catch (e) {
      console.error("[dashboard] OAuth callback:", e.message || e);
      res.redirect("/dashboard/login?error=oauth");
    }
  });

  app.get("/dashboard/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/dashboard/login");
    });
  });

  app.get("/dashboard/api/snapshot.json", (req, res) => {
    const du = req.session.dashboardUser;
    if (!du || !du.id) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let snapshot = null;
    try {
      snapshot = getDashboardSnapshot ? getDashboardSnapshot() : null;
    } catch (e) {
      res.status(500).json({ error: String(e && e.message) });
      return;
    }
    const ready = discordClient.isReady();
    res.json({
      loggedInAs: { id: du.id, username: du.username, global_name: du.global_name },
      bot: {
        ready,
        tag: ready && discordClient.user ? discordClient.user.tag : null,
        uptimeMs: ready ? discordClient.uptime : null,
        pingMs: ready ? discordClient.ws.ping : null,
      },
      guildId,
      snapshot,
    });
  });

  const jsonBody = express.json({ limit: "48kb" });

  function requireDashboardSessionJson(req, res, next) {
    if (!req.session.dashboardUser?.id) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    next();
  }

  app.post(
    "/dashboard/api/control/close-latest",
    jsonBody,
    requireDashboardSessionJson,
    async (req, res) => {
      if (!dashboardCloseLatestInChannel) {
        res.status(501).json({ ok: false, error: "not_configured" });
        return;
      }
      try {
        const uid = req.session.dashboardUser.id;
        const out = await dashboardCloseLatestInChannel(String(req.body?.channelId || ""));
        if (out.ok) {
          console.log(`[dashboard] control close-latest ok channel=${req.body?.channelId} by=${uid}`);
        }
        res.status(out.ok ? 200 : 400).json(out);
      } catch (e) {
        console.error("[dashboard] control close-latest:", e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    "/dashboard/api/control/sheet-sync",
    jsonBody,
    requireDashboardSessionJson,
    async (req, res) => {
      if (!dashboardImportSheet) {
        res.status(501).json({ ok: false, error: "not_configured" });
        return;
      }
      try {
        const uid = req.session.dashboardUser.id;
        const out = await dashboardImportSheet();
        console.log(`[dashboard] control sheet-sync by=${uid}`, out?.result || out);
        res.json(out);
      } catch (e) {
        console.error("[dashboard] control sheet-sync:", e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    "/dashboard/api/control/post-board",
    jsonBody,
    requireDashboardSessionJson,
    async (req, res) => {
      if (!dashboardPostBoard) {
        res.status(501).json({ ok: false, error: "not_configured" });
        return;
      }
      try {
        const uid = req.session.dashboardUser.id;
        const modeRaw = String(req.body?.mode || "default").toLowerCase();
        const mode = modeRaw === "special" ? "special" : "default";
        const out = await dashboardPostBoard(String(req.body?.channelId || ""), mode);
        if (out.ok) {
          console.log(
            `[dashboard] control post-board ok mode=${mode} channel=${req.body?.channelId} by=${uid}`
          );
        }
        res.status(out.ok ? 200 : 400).json(out);
      } catch (e) {
        console.error("[dashboard] control post-board:", e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    "/dashboard/api/schedule-config",
    jsonBody,
    requireDashboardSessionJson,
    async (req, res) => {
      if (!saveDashboardScheduleConfig) {
        res.status(501).json({ ok: false, error: "not_configured" });
        return;
      }
      try {
        const uid = req.session.dashboardUser.id;
        const out = await saveDashboardScheduleConfig(req.body || {});
        if (out.ok) {
          console.log(`[dashboard] schedule-config saved by=${uid}`);
        }
        res.status(out.ok ? 200 : 400).json(out);
      } catch (e) {
        console.error("[dashboard] schedule-config:", e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.get("/dashboard", (req, res) => {
    const du = req.session.dashboardUser;
    if (!du || !du.id) {
      res.redirect("/dashboard/login");
      return;
    }

    const ready = discordClient.isReady();
    const tag = ready && discordClient.user ? discordClient.user.tag : "(연결 중)";
    const guild = ready ? discordClient.guilds.cache.get(guildId) : null;
    const guildName = guild ? guild.name : "(캐시 없음 — 봇이 길드에 없을 수 있음)";
    const uptimeSec = ready && discordClient.uptime != null ? Math.floor(discordClient.uptime / 1000) : 0;
    const pingMs = ready ? discordClient.ws.ping : null;
    let sessionCount;
    try {
      sessionCount = getActiveSessionCount ? getActiveSessionCount() : undefined;
    } catch {
      sessionCount = undefined;
    }

    let snapshot = null;
    try {
      snapshot = getDashboardSnapshot ? getDashboardSnapshot() : null;
    } catch (e) {
      snapshot = { error: String(e && e.message), boards: [], features: {} };
    }

    const displayName = du.global_name || du.username || du.id;
    const extraSessions =
      typeof sessionCount === "number"
        ? `<div class="kv__row"><span class="kv__k">활성 세션 수</span><span class="kv__v"><code>${escapeHtml(String(sessionCount))}</code> <span class="muted">(맵 전체)</span></span></div>`
        : "";
    const featuresHtml = renderFeaturesRow(snapshot);
    const boardsHtml = renderBoardsSection(snapshot, guildId);

    const mainInner = `<article class="embed embed--brand">
      <p class="embed__kicker">상태</p>
      <h2 class="embed__title">봇 · 길드</h2>
      <p class="embed__desc">연결·핑·기능 플래그를 한눈에 봅니다. (디스코드 임베드와 비슷한 레이아웃)</p>
      <div class="kv">
        <div class="kv__row"><span class="kv__k">봇</span><span class="kv__v">${escapeHtml(tag)}</span></div>
        <div class="kv__row"><span class="kv__k">준비</span><span class="kv__v">${ready ? "준비됨" : "연결 중"}</span></div>
        <div class="kv__row"><span class="kv__k">가동 시간</span><span class="kv__v">${escapeHtml(String(uptimeSec))} 초</span></div>
        <div class="kv__row"><span class="kv__k">WebSocket 핑</span><span class="kv__v">${pingMs != null ? escapeHtml(String(pingMs)) + " ms" : "—"}</span></div>
        <div class="kv__row"><span class="kv__k">길드 ID</span><span class="kv__v"><code>${escapeHtml(guildId)}</code></span></div>
        <div class="kv__row"><span class="kv__k">길드 이름</span><span class="kv__v">${escapeHtml(guildName)}</span></div>
        ${extraSessions}
        ${featuresHtml}
      </div>
    </article>

    ${boardsHtml}`;

    res
      .type("text/html; charset=utf-8")
      .send(
        renderDashboardLayout(
          "status",
          "조율 봇 · 상태",
          { displayName, guildName },
          mainInner
        )
      );
  });

  app.get("/dashboard/schedule", (req, res) => {
    const du = req.session.dashboardUser;
    if (!du || !du.id) {
      res.redirect("/dashboard/login");
      return;
    }

    const ready = discordClient.isReady();
    const guild = ready ? discordClient.guilds.cache.get(guildId) : null;
    const guildName = guild ? guild.name : "(캐시 없음 — 봇이 길드에 없을 수 있음)";
    const displayName = du.global_name || du.username || du.id;

    let snapshot = null;
    try {
      snapshot = getDashboardSnapshot ? getDashboardSnapshot() : null;
    } catch (e) {
      snapshot = { error: String(e && e.message), boards: [], features: {} };
    }

    const sf =
      snapshot && snapshot.scheduleFile && typeof snapshot.scheduleFile === "object"
        ? snapshot.scheduleFile
        : {
            path: "",
            workDates: [],
            holidayDates: [],
            blockedDayKeys: [],
            boardGuideText: "",
            usesDefaultGuide: true,
          };
    const schedHtml = renderScheduleConfigPanel(sf, Boolean(saveDashboardScheduleConfig));
    const hasRemote =
      Boolean(dashboardCloseLatestInChannel) &&
      Boolean(dashboardImportSheet) &&
      Boolean(dashboardPostBoard);
    const defaultCh =
      snapshot && snapshot.features && typeof snapshot.features.scheduleChannelId === "string"
        ? snapshot.features.scheduleChannelId
        : "";
    const controlHtml = renderRemoteControlPanel(hasRemote, defaultCh);
    const scheduleMain = `${schedHtml}\n${controlHtml}`;

    res
      .type("text/html; charset=utf-8")
      .send(
        renderDashboardLayout(
          "schedule",
          "조율 봇 · 스케줄 작성",
          { displayName, guildName },
          scheduleMain
        )
      );
  });

  const bindHost = (process.env.DASHBOARD_BIND || "0.0.0.0").trim() || "0.0.0.0";
  let server;
  try {
    server = app.listen(listenPort, bindHost, () => {
      console.log(
        `[dashboard] HTTP ${bindHost}:${listenPort} — /dashboard/login → OAuth · /dashboard · /dashboard/schedule · /dashboard/api/snapshot.json`
      );
      console.log(
        "[dashboard] 클라우드에 떠 있으면: 다른 PC에서는 localhost 대신 이 인스턴스 공인 IP/도메인으로 접속하거나 SSH -L 터널을 쓰세요."
      );
    });
  } catch (e) {
    console.error("[dashboard] app.listen 호출 실패:", e && e.message ? e.message : e);
    return;
  }
  server.on("error", (err) => {
    console.error("[dashboard] listen 오류 (포트 충돌·권한 등):", err && err.code ? err.code : "", err.message || err);
  });
}

module.exports = { startDashboardIfEnabled, isDashboardEnabled };
