/**
 * Email sending module.
 *
 * Sends mail via the Gmail API as a single dedicated workspace user, using
 * an OAuth refresh token. The refresh token is bound to that one user; the
 * Gmail API scope is `gmail.send` only (least privilege). Cannot read mail,
 * cannot impersonate any other user.
 *
 * Set BRAND_FROM_EMAIL in wrangler.toml to the address you want messages to
 * appear from. The display name comes from the brand config and is wired
 * through email-queue.ts.
 *
 * This module never throws to its caller. All errors are caught and logged
 * to KV. Email failures must not block dashboard operations.
 */

import type { Env } from "./index";

// Per-Worker access-token cache. Each isolated Worker reuses the access
// token until it expires; refresh-token exchange happens at most once
// per ~50 minutes per Worker instance.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

interface EmailMessage {
  from: string; // "Display Name <addr@domain>"
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send a single email. Returns true on success, false on any failure.
 * Never throws.
 */
export async function sendEmail(msg: EmailMessage, env: Env): Promise<boolean> {
  try {
    if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
      console.warn("[email] Gmail credentials not configured; skipping send.");
      await recordMetric("skipped_unconfigured", env);
      return false;
    }

    const accessToken = await getAccessToken(env);
    if (!accessToken) {
      await recordMetric("failed_token", env);
      return false;
    }

    const raw = buildRawMime(msg);
    const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[email] Gmail send failed (${res.status}):`, body.slice(0, 500));
      await recordMetric(`failed_${res.status}`, env);
      if (res.status === 401) cachedAccessToken = null;
      return false;
    }

    await recordMetric("sent", env);
    return true;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[email] Unexpected send error:", m);
    await recordMetric("failed_exception", env).catch(() => {});
    return false;
  }
}

async function getAccessToken(env: Env): Promise<string | null> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GMAIL_CLIENT_ID!,
        client_secret: env.GMAIL_CLIENT_SECRET!,
        refresh_token: env.GMAIL_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[email] OAuth refresh failed (${res.status}):`, body.slice(0, 500));
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[email] OAuth refresh exception:", m);
    return null;
  }
}

function buildRawMime(msg: EmailMessage): string {
  const boundary = "beam_" + Math.random().toString(36).slice(2, 12);
  const headers: string[] = [`From: ${msg.from}`, `To: ${msg.to}`];
  if (msg.replyTo) headers.push(`Reply-To: ${msg.replyTo}`);
  headers.push(
    `Subject: ${encodeMimeHeader(msg.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  );

  const body = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    quotedPrintableEncode(msg.text),
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    quotedPrintableEncode(msg.html),
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  const full = headers.join("\r\n") + "\r\n\r\n" + body;
  return base64UrlEncode(full);
}

function encodeMimeHeader(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const utf8 = new TextEncoder().encode(s);
  let b64 = "";
  for (let i = 0; i < utf8.length; i += 3) {
    const triplet = (utf8[i] << 16) | ((utf8[i + 1] || 0) << 8) | (utf8[i + 2] || 0);
    const c1 = (triplet >> 18) & 0x3f,
      c2 = (triplet >> 12) & 0x3f,
      c3 = (triplet >> 6) & 0x3f,
      c4 = triplet & 0x3f;
    b64 +=
      B64[c1] +
      B64[c2] +
      (i + 1 < utf8.length ? B64[c3] : "=") +
      (i + 2 < utf8.length ? B64[c4] : "=");
  }
  return `=?UTF-8?B?${b64}?=`;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function quotedPrintableEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  let lineLen = 0;
  const writeChunk = (chunk: string) => {
    if (lineLen + chunk.length > 75) {
      out += "=\r\n";
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) {
      out += "\r\n";
      lineLen = 0;
      continue;
    }
    if (b === 0x0d) continue;
    if (b === 0x20 || b === 0x09) {
      const next = bytes[i + 1];
      if (next === 0x0a || next === undefined) {
        writeChunk("=" + b.toString(16).toUpperCase().padStart(2, "0"));
      } else {
        writeChunk(String.fromCharCode(b));
      }
      continue;
    }
    if (b === 0x3d || b < 0x20 || b > 0x7e) {
      writeChunk("=" + b.toString(16).toUpperCase().padStart(2, "0"));
    } else {
      writeChunk(String.fromCharCode(b));
    }
  }
  return out;
}

async function recordMetric(kind: string, env: Env): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `email_metric:${day}:${kind}`;
    const cur = await env.DASHBOARDS_KV.get(key);
    const n = cur ? parseInt(cur, 10) || 0 : 0;
    await env.DASHBOARDS_KV.put(key, String(n + 1), {
      expirationTtl: 60 * 60 * 24 * 90,
    });
  } catch {
    // metrics failure must not block anything
  }
}

export async function isUnsubscribed(email: string, env: Env): Promise<boolean> {
  if (!email) return false;
  try {
    const v = await env.DASHBOARDS_KV.get(`nomail:${email.toLowerCase()}`);
    return v !== null;
  } catch {
    return false;
  }
}

export async function addUnsubscribe(email: string, env: Env): Promise<void> {
  if (!email) return;
  await env.DASHBOARDS_KV.put(
    `nomail:${email.toLowerCase()}`,
    new Date().toISOString()
  );
}

export async function computeUnsubToken(email: string, env: Env): Promise<string> {
  const secret = env.UNSUB_SECRET || "fallback-please-set-UNSUB_SECRET";
  const data = new TextEncoder().encode(`${secret}:${email.toLowerCase()}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const arr = new Uint8Array(hash).slice(0, 12);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(36);
  return s;
}

export async function verifyUnsubToken(
  email: string,
  token: string,
  env: Env
): Promise<boolean> {
  const expected = await computeUnsubToken(email, env);
  if (expected.length !== token.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}

const DEDUP_WINDOW_SECONDS = 5 * 60;

export async function shouldDedup(
  uuid: string,
  recipient: string,
  env: Env
): Promise<boolean> {
  try {
    const key = `email_dedup:${uuid}:${recipient.toLowerCase()}`;
    const v = await env.DASHBOARDS_KV.get(key);
    if (v) return true;
    await env.DASHBOARDS_KV.put(key, "1", {
      expirationTtl: DEDUP_WINDOW_SECONDS,
    });
    return false;
  } catch {
    return false;
  }
}
