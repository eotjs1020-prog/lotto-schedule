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

/**
 * DASHBOARD_ENABLE=1 일 때 OAuth + 길드 관리자 전용 상태 페이지.
 * @param {import("discord.js").Client} discordClient
 * @param {{ getActiveSessionCount?: () => number }} [options]
 */
function startDashboardIfEnabled(discordClient, options = {}) {
  if (!isDashboardEnabled()) {
    const port = process.env.PORT;
    if (port) {
      startLegacyHealthServer(port);
    }
    return;
  }

  const getActiveSessionCount =
    typeof options.getActiveSessionCount === "function" ? options.getActiveSessionCount : null;

  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DASHBOARD_OAUTH_REDIRECT_URI;
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!clientSecret || !redirectUri || !sessionSecret || !clientId || !guildId) {
    console.warn(
      "[dashboard] DASHBOARD_ENABLE 이지만 필수 env 가 비어 있어 대시보드를 건너뜁니다. " +
        "DISCORD_CLIENT_SECRET, DASHBOARD_OAUTH_REDIRECT_URI, DASHBOARD_SESSION_SECRET, CLIENT_ID, GUILD_ID 를 채워 주세요."
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
    let sessionCount;
    try {
      sessionCount = getActiveSessionCount ? getActiveSessionCount() : undefined;
    } catch {
      sessionCount = undefined;
    }

    const displayName = du.global_name || du.username || du.id;
    const extraSessions =
      typeof sessionCount === "number"
        ? `<tr><th>활성 조율 세션</th><td>${escapeHtml(String(sessionCount))}</td></tr>`
        : "";

    res.type("text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>봇 상태</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.25rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #ddd; }
    th { width: 11rem; color: #444; }
    a { color: #5865f2; }
  </style>
</head>
<body>
  <h1>디스코드 봇 · 상태 (1단계)</h1>
  <p>로그인: <strong>${escapeHtml(displayName)}</strong> · <a href="/dashboard/logout">로그아웃</a></p>
  <table>
    <tr><th>봇</th><td>${escapeHtml(tag)}</td></tr>
    <tr><th>준비 상태</th><td>${ready ? "준비됨" : "아직 연결 중"}</td></tr>
    <tr><th>가동 시간(초)</th><td>${escapeHtml(String(uptimeSec))}</td></tr>
    <tr><th>대상 길드 ID</th><td><code>${escapeHtml(guildId)}</code></td></tr>
    <tr><th>길드 이름(캐시)</th><td>${escapeHtml(guildName)}</td></tr>
    ${extraSessions}
  </table>
</body>
</html>`);
  });

  app.listen(listenPort, () => {
    console.log(
      `[dashboard] ${listenPort} 포트에서 대기 중 — 로그인: http://localhost:${listenPort}/dashboard/login (배포 시 공개 URL로 접속)`
    );
  });
}

module.exports = { startDashboardIfEnabled, isDashboardEnabled };
