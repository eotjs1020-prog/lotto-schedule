"use strict";

const http = require("http");
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
  return raw === "1" || String(raw).toLowerCase() === "true";
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
    throw new Error(String(msg));
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

function renderBoardsSection(snapshot) {
  if (snapshot && snapshot.error) {
    return `<p class="warn"><strong>스냅샷 오류:</strong> ${escapeHtml(String(snapshot.error))}</p>`;
  }
  if (!snapshot || !Array.isArray(snapshot.boards)) {
    return "<p><em>조율판 스냅샷을 불러오지 못했어요.</em></p>";
  }
  if (snapshot.boards.length === 0) {
    return "<p><em>메시지가 있는 활성 조율판이 없어요. (세션은 있어도 아직 게시 전일 수 있음)</em></p>";
  }
  const rows = snapshot.boards
    .map((b) => {
      const mode = b.priorWeek ? "특수(+7)" : "기본(+14)";
      const locks =
        b.manualLockedKeys && b.manualLockedKeys.length > 0
          ? b.manualLockedKeys.map(dayKeyToKoreanLabel).join(", ")
          : "—";
      return `<tr>
  <td><code>${escapeHtml(String(b.channelId))}</code></td>
  <td>${escapeHtml(b.voteStartIso)} ~ ${escapeHtml(b.voteEndIso)}</td>
  <td>${escapeHtml(mode)}</td>
  <td>${escapeHtml(locks)}</td>
</tr>`;
    })
    .join("\n");
  return `<h2>활성 조율판</h2>
<table class="boards">
  <thead><tr><th>채널 ID</th><th>투표 기간(ISO)</th><th>모드</th><th>관리자 잠금</th></tr></thead>
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

/**
 * DASHBOARD_ENABLE=1 일 때 OAuth + 길드 관리자 전용 상태 페이지.
 * @param {import("discord.js").Client} discordClient
 * @param {{
 *   getActiveSessionCount?: () => number;
 *   getDashboardSnapshot?: () => Record<string, unknown>;
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

  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DASHBOARD_OAUTH_REDIRECT_URI;
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

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
<p>디스코드 로그인 처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요.</p>
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
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
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
    const boardsHtml = renderBoardsSection(snapshot);

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
