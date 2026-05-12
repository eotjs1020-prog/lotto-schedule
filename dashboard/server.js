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

function dayKeyToKoreanLabel(key) {
  const map = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };
  return map[key] || key;
}

function renderBoardsSection(snapshot, guildIdForLinks) {
  if (snapshot && snapshot.error) {
    return `<p class="warn"><strong>스냅샷 오류:</strong> ${escapeHtml(String(snapshot.error))}</p>`;
  }
  if (!snapshot || !Array.isArray(snapshot.boards)) {
    return "<p><em>조율판 스냅샷을 불러오지 못했어요.</em></p>";
  }
  if (snapshot.boards.length === 0) {
    return "<p><em>메시지가 있는 활성 조율판이 없어요. (세션은 있어도 아직 게시 전일 수 있음)</em></p>";
  }
  const gid = guildIdForLinks ? escapeHtml(String(guildIdForLinks)) : "";
  const rows = snapshot.boards
    .map((b) => {
      const mode = b.priorWeek ? "특수(+7)" : "기본(+14)";
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
      return `<tr>
  <td><code>${chId}</code></td>
  <td>${jump}</td>
  <td>${escapeHtml(b.voteStartIso)} ~ ${escapeHtml(b.voteEndIso)}</td>
  <td>${escapeHtml(mode)}</td>
  <td>${escapeHtml(locks)}</td>
</tr>`;
    })
    .join("\n");
  return `<h2>활성 조율판</h2>
<table class="boards">
  <thead><tr><th>채널 ID</th><th>메시지</th><th>투표 기간(ISO)</th><th>모드</th><th>관리자 잠금</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderFeaturesRow(snapshot) {
  if (!snapshot || !snapshot.features) {
    return "";
  }
  const f = snapshot.features;
  const cron = f.scheduleCron ? "켜짐" : "꺼짐";
  const live = f.sheetsLive ? "켜짐" : "꺼짐";
  const slash = f.guildSlash ? "길드 등록" : "전역(느림)";
  return `<tr><th>주간 크론</th><td>${escapeHtml(cron)}</td></tr>
    <tr><th>실시간 시트</th><td>${escapeHtml(live)}</td></tr>
    <tr><th>슬래시 등록</th><td>${escapeHtml(slash)}</td></tr>`;
}

function renderRemoteControlPanel(hasControl, defaultChannelId) {
  const def = escapeHtml(defaultChannelId || "");
  const disabledNote = hasControl
    ? ""
    : `<p class="warn">원격 제어 API가 연결되지 않았습니다. 봇 <code>index.js</code>를 최신으로 배포했는지 확인하세요.</p>`;
  const buttons = hasControl
    ? `<p class="btnRow">
<button type="button" id="dashPostDef">조율판 게시 (기본)</button>
<button type="button" id="dashPostSp">조율판 게시 (특수)</button>
<button type="button" id="dashClose">최신 조율판 마감</button>
<button type="button" id="dashSheet">시트→디스코드 동기화</button>
</p>`
    : "";
  const hc = hasControl ? "true" : "false";
  return `<div class="card">
<h2>원격 제어</h2>
<p class="muted">채널은 <code>GUILD_ID</code>와 같은 길드의 텍스트 채널만 가능합니다. (슬래시 <code>/일정생성</code>과 동일한 게시·<code>/일정마감</code>과 동일한 마감·<code>/시트불러오기</code>와 동일한 동기화)</p>
${disabledNote}
<p><label for="dashCh">채널 ID</label><br><input id="dashCh" class="inp" type="text" value="${def}" autocomplete="off" spellcheck="false" /></p>
${buttons}
<pre id="dashCtlOut" class="dashOut"></pre>
</div>
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
  const pathEsc = escapeHtml(sf.path || "");
  const workLines = escapeHtml((sf.workDates || []).join("\n"));
  const holLines = escapeHtml((sf.holidayDates || []).join("\n"));
  const guideEsc = escapeHtml(sf.boardGuideText || "");
  const chk = SCHED_DAY_KEYS.map((key) => {
    const on = (sf.blockedDayKeys || []).includes(key);
    const lab = SCHED_DAY_LABEL[key] || key;
    return `<label class="schedLab"><input type="checkbox" class="dashSchedChk" data-dk="${key}" ${
      on ? "checked" : ""
    }/> ${escapeHtml(lab)}</label>`;
  }).join("");
  const warn = hasSave
    ? ""
    : `<p class="warn">저장 API가 연결되지 않았습니다. <code>index.js</code>의 <code>startDashboardIfEnabled</code>에 <code>saveDashboardScheduleConfig</code>가 있는지 확인하세요.</p>`;
  const btn = hasSave
    ? `<p class="btnRow"><button type="button" id="dashSchedSave">파일에 저장</button></p>`
    : "";
  const hc = hasSave ? "true" : "false";
  return `<div class="card">
<h2>일정 규칙 · 안내글</h2>
<p class="muted">설정은 <code>USER_WORK_SCHEDULE_PATH</code>가 있으면 그 파일, 없으면 프로젝트 루트의 <code>user-work-schedule.json</code>에 저장됩니다. (봇 프로세스가 쓸 수 있는 경로여야 합니다.)</p>
<p class="muted">저장한 <strong>요일 막기·휴일·추가 근무일</strong>은 곧바로 버튼 색에 반영됩니다. <strong>안내글</strong>은 <strong>새로 게시하는 조율판</strong> embed에만 적용됩니다.</p>
${warn}
<p><strong>파일</strong><br><code>${pathEsc || "—"}</code></p>
<p><label for="dashHol">공휴일·휴무일 (YYYY-MM-DD)</label><br><span class="muted">조율 주 7일 안에 들어오는 이 날짜는, 근무일 목록에 있어도 요일 버튼을 <strong>막지 않습니다</strong>.</span><br><textarea id="dashHol" class="inp ta" rows="4" spellcheck="false" placeholder="2026-05-05&#10;2026-10-03">${holLines}</textarea></p>
<p><label for="dashWork">추가 근무일 (YYYY-MM-DD)</label><br><span class="muted">조율 주에 포함되면 해당 날의 요일 버튼이 <strong>빨강(선택 불가)</strong>으로 잡힙니다. (.env의 SCHEDULE_GLOBAL_WORK_DATES와 합쳐집니다.)</span><br><textarea id="dashWork" class="inp ta" rows="4" spellcheck="false" placeholder="2026-05-08">${workLines}</textarea></p>
<p><strong>매주 막을 요일</strong> <span class="muted">(전역 — 달력 근무일 막기와 무관하게 항상 빨강)</span></p>
<p class="schedChkRow">${chk}</p>
<p><label for="dashGuide">조율판 안내글 (<code>**안내**</code> 아래 전체)</label><br><span class="muted">비우고 저장하면 기본 문구로 돌아갑니다. Discord embed 한도로 약 ${2000}자까지.</span><br><textarea id="dashGuide" class="inp ta" rows="10" spellcheck="false" placeholder="(기본 안내 사용 중)">${guideEsc}</textarea></p>
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
</div>`;
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
      res.status(403).type("text/html; charset=utf-8")
        .send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>접근 불가</title></head><body>
<p>이 길드(<code>${escapeHtml(guildId)}</code>)에서 <strong>관리자(Administrator)</strong> 권한이 있는 계정만 들어올 수 있어요.</p>
<p><a href="/dashboard/login">다시 로그인</a></p>
</body></html>`);
      return;
    }
    if (err === "oauth") {
      res.status(502).type("text/html; charset=utf-8")
        .send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>로그인 실패</title></head><body>
<p>디스코드 로그인 처리 중 오류가 났어요.</p>
<ul>
  <li>개발자 포털 OAuth2 <strong>Redirects</strong>와 <code>.env</code>의 <code>DASHBOARD_OAUTH_REDIRECT_URI</code>가 <strong>한 글자도 다르지 않게</strong> 같은지 확인 (http/https, 포트, 경로 <code>/auth/discord/callback</code>).</li>
  <li><code>DISCORD_CLIENT_SECRET</code>은 봇 토큰이 아니라 앱의 <strong>OAuth2 Client Secret</strong>입니다.</li>
  <li>서버에서: <code>sudo journalctl -u discord-bot -n 30 --no-pager | grep dashboard</code> 로 상세 오류를 확인하세요.</li>
</ul>
<p><a href="/dashboard/login">다시 시도</a></p>
</body></html>`);
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
      if (!userIsGuildAdministratorIn(guilds, guildId)) {
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
        ? `<tr><th>활성 세션 수</th><td><code>${escapeHtml(String(sessionCount))}</code> <span class="muted">(맵 전체)</span></td></tr>`
        : "";
    const featuresHtml = renderFeaturesRow(snapshot);
    const boardsHtml = renderBoardsSection(snapshot, guildId);
    const hasRemote =
      Boolean(dashboardCloseLatestInChannel) &&
      Boolean(dashboardImportSheet) &&
      Boolean(dashboardPostBoard);
    const defaultCh =
      snapshot && snapshot.features && typeof snapshot.features.scheduleChannelId === "string"
        ? snapshot.features.scheduleChannelId
        : "";
    const controlHtml = renderRemoteControlPanel(hasRemote, defaultCh);
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

    res.type("text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>조율 봇 · 대시보드</title>
  <style>
    :root { --bg: #313338; --card: #2b2d31; --text: #f2f3f5; --muted: #949ba4; --link: #00a8fc; --border: #1e1f22; }
    body { font-family: "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; min-height: 100vh; }
    .wrap { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
    header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0; }
    nav a { color: var(--link); margin-left: 1rem; white-space: nowrap; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .card h2 { font-size: 0.8rem; margin: 0 0 0.75rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    table.meta { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
    table.meta th, table.meta td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    table.meta th { width: 11rem; color: var(--muted); font-weight: 500; }
    table.boards { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    table.boards th, table.boards td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--border); }
    table.boards thead th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; }
    code { font-size: 0.85em; background: #111214; padding: 0.12em 0.4em; border-radius: 4px; }
    a { color: var(--link); }
    .muted { color: var(--muted); font-size: 0.88rem; }
    .warn { color: #f23f43; }
    .inp { width: 100%; max-width: 28rem; padding: 0.45rem 0.6rem; background: #111214; border: 1px solid var(--border); color: var(--text); border-radius: 6px; box-sizing: border-box; }
    .dashOut { margin-top: 0.75rem; padding: 0.75rem; background: #111214; border-radius: 6px; max-height: 16rem; overflow: auto; font-size: 0.8rem; white-space: pre-wrap; }
    .btnRow { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
    .btnRow button { padding: 0.4rem 0.75rem; cursor: pointer; border-radius: 6px; border: 1px solid var(--border); background: #404249; color: var(--text); }
    .ta { font-family: ui-monospace, monospace; font-size: 0.85rem; line-height: 1.45; }
    .schedChkRow { display: flex; flex-wrap: wrap; gap: 0.65rem 1rem; align-items: center; margin: 0.35rem 0 0.75rem; }
    .schedLab { font-size: 0.9rem; cursor: pointer; user-select: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>조율 봇 · 대시보드</h1>
      <nav>
        <span class="muted">${escapeHtml(displayName)}</span>
        <a href="/dashboard/api/snapshot.json" target="_blank" rel="noopener">JSON</a>
        <a href="/dashboard/logout">로그아웃</a>
      </nav>
    </header>

    <div class="card">
      <h2>봇 / 길드</h2>
      <table class="meta">
        <tr><th>봇</th><td>${escapeHtml(tag)}</td></tr>
        <tr><th>준비</th><td>${ready ? "준비됨" : "연결 중"}</td></tr>
        <tr><th>가동(초)</th><td>${escapeHtml(String(uptimeSec))}</td></tr>
        <tr><th>WebSocket 핑</th><td>${pingMs != null ? escapeHtml(String(pingMs)) + " ms" : "—"}</td></tr>
        <tr><th>길드 ID</th><td><code>${escapeHtml(guildId)}</code></td></tr>
        <tr><th>길드 이름</th><td>${escapeHtml(guildName)}</td></tr>
        ${extraSessions}
        ${featuresHtml}
      </table>
    </div>

    <div class="card">
      ${boardsHtml}
    </div>

    ${schedHtml}

    ${controlHtml}

    <p class="muted">OAuth 로그인한 계정은 <code>GUILD_ID</code> 길드에서 Administrator 여야 합니다. 봇 재시작 시 메모리 조율판·관리자 잠금은 초기화됩니다.</p>
  </div>
</body>
</html>`);
  });

  const bindHost = (process.env.DASHBOARD_BIND || "0.0.0.0").trim() || "0.0.0.0";
  let server;
  try {
    server = app.listen(listenPort, bindHost, () => {
      console.log(
        `[dashboard] HTTP ${bindHost}:${listenPort} — /dashboard/login → OAuth · /dashboard · /dashboard/api/snapshot.json`
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
