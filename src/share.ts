/**
 * Public share viewer.
 *
 * Hostname has no Cloudflare Access. The share token in the URL path is
 * the credential. If the dashboard is password-protected, the recipient
 * sees a password prompt. On success a short-lived signed cookie is set
 * (max 24h or remaining token lifetime, whichever is shorter). The cookie
 * is automatically invalidated when:
 *   - The owner changes the password (password_set_at changes)
 *   - The owner revokes shares (share_generation increments)
 *   - The cookie's own embedded expiry passes
 *
 * Error pages, password prompt, and unsubscribe page all use the same
 * neutral design system: Source Serif type, dashboard fingerprint glyph as the
 * single visual signature, no logo, brand color reserved for buttons and
 * accents.
 */

import type { Env } from "./index";
import { getConfig, tint } from "./config";
import {
  validateShareToken,
  isPasswordProtected,
  verifyDashboardPassword,
  makePasswordCookie,
  verifyPasswordCookie,
  recordFailedAttempt,
  getAttemptStatus,
  clearFailedAttempts,
  truncateIp,
  DashboardMeta,
} from "./store";
import { recordInitialView, injectAll } from "./tracking";
import { verifyUnsubToken, addUnsubscribe } from "./email";
import { fingerprintSvg } from "./fingerprint";

const COOKIE_NAME = "beam_share";

export async function handleShare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Unsubscribe endpoint: /unsub/{email}/{token}
  if (url.pathname.startsWith("/unsub/")) {
    return handleUnsubscribe(url.pathname, request, env);
  }

  let token = url.pathname;
  if (token.startsWith("/share/")) token = token.slice("/share/".length);
  else if (token === "/share") token = "";
  else token = token.slice(1);

  const slashIdx = token.indexOf("/");
  if (slashIdx >= 0) token = token.slice(0, slashIdx);

  if (!token) {
    return renderError(
      "Share link required",
      "This URL is missing a share token. Ask the publisher to send you the full link.",
      400,
      env
    );
  }

  const meta = await validateShareToken(token, env);
  if (!meta) {
    return renderError(
      "This link has expired",
      "Share links expire automatically for security. Ask the publisher to send you a fresh link.",
      410,
      env
    );
  }

  // Password gate
  if (isPasswordProtected(meta)) {
    const cookieOk = await verifyPasswordCookie(
      meta,
      readCookie(request, COOKIE_NAME),
      env
    );

    if (!cookieOk) {
      if (request.method === "POST") {
        return await handlePasswordSubmit(request, meta, token, env);
      }
      return renderPasswordPrompt(meta, undefined, false, token, env);
    }
  }

  return await serveDashboard(request, meta, token, env);
}

async function handlePasswordSubmit(
  request: Request,
  meta: DashboardMeta,
  token: string,
  env: Env
): Promise<Response> {
  let password = "";
  const ct = request.headers.get("Content-Type") || "";
  try {
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const fd = await request.formData();
      password = String(fd.get("password") || "");
    } else if (ct.includes("application/json")) {
      const body = (await request.json()) as { password?: string };
      password = String(body.password || "");
    }
  } catch {
    // ignore
  }

  // Rate limit by truncated IP. 5 fails -> 60s lockout.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = truncateIp(ip) || "unknown";

  const status = await getAttemptStatus(meta.uuid, ipKey, env);
  if (status.locked_until && Math.floor(Date.now() / 1000) < status.locked_until) {
    const wait = status.locked_until - Math.floor(Date.now() / 1000);
    return renderPasswordPrompt(
      meta,
      `Too many failed attempts. Try again in ${wait}s.`,
      true,
      token,
      env
    );
  }

  if (!password) {
    return renderPasswordPrompt(meta, "Please enter the password.", false, token, env);
  }

  const ok = await verifyDashboardPassword(meta, password);
  if (!ok) {
    const result = await recordFailedAttempt(meta.uuid, ipKey, env);
    const remaining = Math.max(0, 5 - result.count);
    const msg = result.locked_until
      ? `Too many failed attempts. Try again in 60 seconds.`
      : `Incorrect password. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;
    return renderPasswordPrompt(meta, msg, !!result.locked_until, token, env);
  }

  // Success: clear rate limit, set cookie, redirect to GET so refresh works.
  await clearFailedAttempts(meta.uuid, ipKey, env);
  const { cookie, expiresInSec } = await makePasswordCookie(meta, env);
  const cookieHeader = `${COOKIE_NAME}=${cookie}; Path=/; Max-Age=${expiresInSec}; HttpOnly; Secure; SameSite=Strict`;

  return new Response(null, {
    status: 303,
    headers: {
      Location: `/${token}`,
      "Set-Cookie": cookieHeader,
    },
  });
}

async function serveDashboard(
  request: Request,
  meta: DashboardMeta,
  token: string,
  env: Env
): Promise<Response> {
  const obj = await env.DASHBOARDS_BUCKET.get(`${meta.uuid}/index.html`);
  if (!obj) {
    return renderError(
      "Dashboard not available",
      "The dashboard this link points to has been deleted by the publisher.",
      410,
      env
    );
  }

  const sessionId = await recordInitialView(
    request,
    { uuid: meta.uuid, via: "share", shareToken: token },
    env
  );
  const cfg = getConfig(env);
  const rawHtml = await obj.text();
  const html = injectAll({
    html: rawHtml,
    uuid: meta.uuid,
    sessionId,
    classification: meta.classification,
    showFooter: true,
    brandName: cfg.brandName,
  });

  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(html, { headers });
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  const parts = header.split(";").map((s) => s.trim());
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    if (p.slice(0, eq) === name) return p.slice(eq + 1);
  }
  return undefined;
}

// ---------- shared layout helpers ----------

interface Page {
  title: string;
  body: string;
  uuid?: string;
  status: number;
}

function renderPage(p: Page, env: Env): Response {
  const cfg = getConfig(env);
  const accent = cfg.brandPrimaryColor;
  const accentBg = tint(accent, 0.08);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --color-surface: #FFFFFF;
    --color-surface-muted: #F1ECE0;
    --color-surface-subtle: #EBE3D0;
    --color-ink: #1B1A18;
    --color-ink-secondary: #3A3835;
    --color-muted: #6B6358;
    --color-border: #D9CFB6;
    --color-accent: ${accent};
    --color-accent-tint: ${accentBg};
    --color-danger: #B5482A;
    --color-danger-tint: #F6E4D6;
    --color-warning: #B5482A;
    --color-warning-tint: #F6E4D6;
    --radius: 6px;
    --font-sans: 'Source Serif 4', 'Source Serif Pro', Georgia, serif;
    --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: var(--font-sans);
    color: var(--color-ink);
    background: var(--color-surface-muted);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  .wrap {
    max-width: 480px;
    margin: 0 auto;
    padding: 80px 24px 48px;
  }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 40px 32px;
  }
  .glyph {
    width: 56px;
    height: 56px;
    margin: 0 auto 28px;
    display: block;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .glyph svg { width: 100%; height: 100%; display: block; }
  h1 {
    font-size: 22px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 0 0 12px;
    color: var(--color-ink);
    text-align: center;
  }
  p, .sub {
    font-size: 14px;
    line-height: 1.5;
    color: var(--color-muted);
    margin: 0 auto 24px;
    max-width: 42ch;
    text-align: center;
  }
  .footer-badge {
    display: block;
    margin: 32px auto 0;
    text-align: center;
    font-size: 11px;
    color: var(--color-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 500;
  }
  label {
    display: block;
    font-size: 12px;
    color: var(--color-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 500;
    margin: 8px 0 6px;
  }
  input[type="password"], input[type="text"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    font: 15px var(--font-sans);
    color: var(--color-ink);
    background: var(--color-surface);
    outline: none;
    transition: border-color 0.12s;
  }
  input:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px var(--color-accent-tint);
  }
  button {
    width: 100%;
    margin-top: 16px;
    padding: 11px 14px;
    border: 0;
    border-radius: var(--radius);
    background: var(--color-ink);
    color: #FFFFFF;
    font: 500 14px var(--font-sans);
    cursor: pointer;
    transition: opacity 0.12s;
  }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .hint {
    margin-top: 14px;
    font-size: 12px;
    color: var(--color-muted);
    text-align: center;
  }
  .msg {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    line-height: 1.5;
    text-align: left;
  }
  .msg-error { background: var(--color-danger-tint); color: var(--color-danger); }
  .msg-locked { background: var(--color-warning-tint); color: var(--color-warning); }
  .email-pill {
    display: inline-block;
    padding: 4px 10px;
    border-radius: var(--radius);
    background: var(--color-surface-subtle);
    font: 13px var(--font-mono);
    color: var(--color-ink-secondary);
  }
  a { color: var(--color-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main class="wrap">
${p.body}
</main>
</body>
</html>`;
  return new Response(html, {
    status: p.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

// ---------- password prompt ----------

function renderPasswordPrompt(
  meta: DashboardMeta,
  errorMessage: string | undefined,
  locked: boolean,
  token: string,
  env: Env
): Response {
  const cfg = getConfig(env);
  const ownerLine = meta.owner_email
    ? `Sent by <span class="email-pill">${escapeHtml(meta.owner_email)}</span>`
    : `Sent by a member of the team.`;

  const errorBlock = errorMessage
    ? `<div class="msg ${locked ? "msg-locked" : "msg-error"}">${escapeHtml(errorMessage)}</div>`
    : "";

  const glyph = fingerprintSvg(meta.uuid, 56, "#FFFFFF");

  const body = `
<div class="card">
  <div class="glyph">${glyph}</div>
  <h1>Password required</h1>
  <p class="sub">This dashboard is password-protected. ${ownerLine}</p>
  <form method="POST" action="/${escapeHtml(token)}" autocomplete="off">
    ${errorBlock}
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autofocus ${locked ? "disabled" : ""} />
    <button type="submit" ${locked ? "disabled" : ""}>View dashboard</button>
    <p class="hint">Do not have it? Ask the person who shared the link.</p>
  </form>
</div>
<span class="footer-badge">${escapeHtml(cfg.brandName)}</span>`;

  return renderPage(
    {
      title: "Password required",
      body,
      uuid: meta.uuid,
      status: errorMessage ? (locked ? 429 : 401) : 401,
    },
    env
  );
}

// ---------- error page ----------

export function renderError(
  title: string,
  message: string,
  status: number,
  env: Env
): Response {
  const cfg = getConfig(env);

  // Derive a "fingerprint" for an error page: deterministic but tied to
  // the title, so different errors look subtly different.
  const glyph = fingerprintSvg("error:" + title, 56, "#FFFFFF");

  const body = `
<div class="card">
  <div class="glyph">${glyph}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</div>
<span class="footer-badge">${escapeHtml(cfg.brandName)}</span>`;

  return renderPage({ title, body, status }, env);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]!);
}

// ---------- unsubscribe page ----------

async function handleUnsubscribe(
  pathname: string,
  request: Request,
  env: Env
): Promise<Response> {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "unsub") {
    return renderError("Invalid unsubscribe link", "This link is malformed.", 400, env);
  }

  const email = decodeURIComponent(parts[1]);
  const token = parts[2];

  const ok = await verifyUnsubToken(email, token, env);
  if (!ok) {
    return renderError(
      "Invalid unsubscribe link",
      "This link is invalid or has been tampered with. Please reach out to the dashboard owner directly if you want to stop receiving notifications.",
      400,
      env
    );
  }

  await addUnsubscribe(email, env);

  const cfg = getConfig(env);
  const glyph = fingerprintSvg("unsub:" + email, 56, "#FFFFFF");

  const body = `
<div class="card">
  <div class="glyph">${glyph}</div>
  <h1>You are unsubscribed</h1>
  <p><span class="email-pill">${escapeHtml(email)}</span> will no longer receive notification emails from ${escapeHtml(cfg.brandName)}.</p>
  <p>You can still access any dashboards that have been shared with you by visiting <a href="https://${escapeHtml(cfg.serveHost)}">${escapeHtml(cfg.serveHost)}</a> directly.</p>
  <p style="font-size:12px;color:var(--color-muted);">If this was a mistake, contact the person who shared the dashboard with you and they can re-add you.</p>
</div>
<span class="footer-badge">${escapeHtml(cfg.brandName)}</span>`;

  return renderPage({ title: "Unsubscribed", body, status: 200 }, env);
}
