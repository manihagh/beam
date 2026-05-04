/**
 * Storage layer for Beam.
 *
 * KV schema:
 *   dash:{uuid}                 -> DashboardMeta
 *   tok:{token}                 -> TokenRecord (with TTL = share duration)
 *   view:{uuid}:{ts}:{rand}     -> ViewRecord (90-day TTL)
 *   audit:{uuid}:{ts}:{rand}    -> AuditEvent (1-year TTL)
 *   pwfail:{uuid}:{ipKey}       -> failed-attempt record (10-min TTL)
 *
 * R2 schema:
 *   {uuid}/index.html                  -> current dashboard HTML
 *   {uuid}/versions/{n}.html           -> historical versions (n = 1..N)
 *
 * Tokens belong to a "share generation" of a dashboard. Revoking bumps
 * the dashboard's share_generation, making all existing tokens reject on
 * validation immediately. Old tokens still take up KV space until their
 * natural TTL expires; that is acceptable.
 *
 * Audit events are append-only. Owners and admins can read them. Nobody
 * can write to them outside the mutation paths in this module.
 */

import type { Env } from "./index";
import { getConfig, isAdmin as configIsAdmin, isAllowedSsoEmail } from "./config";

// ---------- types ----------

export type Visibility = "private" | "shared" | "org";

export type Classification = "public" | "internal" | "confidential";

export type AuditAction =
  | "publish"
  | "update"
  | "revert"
  | "delete"
  | "rotate_share"
  | "revoke_share"
  | "permanent_share"
  | "set_visibility"
  | "set_classification"
  | "regenerate_password"
  | "clear_password";

export interface DashboardMeta {
  uuid: string;
  title: string;
  created_at: string;
  updated_at: string;
  size_bytes: number;
  share_generation: number;
  owner_email?: string;
  latest_share_expires_at?: string | null;
  latest_share_generation?: number;
  visibility?: Visibility;
  shared_with?: string[];
  password_hash?: string;
  password_salt?: string;
  password_set_at?: string;

  // New in Beam:
  classification?: Classification; // default "internal"
  current_version?: number;        // 1-indexed; absent on legacy dashboards (= 1)
  total_versions?: number;         // total versions ever created (for pruning math)
}

export interface TokenRecord {
  uuid: string;
  generation: number;
  expires_at: string | null;
}

export interface ShareLink {
  token: string;
  url: string;
  expires_at: string; // ISO timestamp or "permanent"
}

export interface AuditEvent {
  uuid: string;
  action: AuditAction;
  actor_email?: string;
  timestamp: string;
  detail?: Record<string, unknown>;
}

export interface ViewRecord {
  uuid: string;
  session_id: string;
  timestamp: string;
  country?: string;
  region?: string;
  city?: string;
  ip_truncated?: string;
  device_class?: "mobile" | "tablet" | "desktop";
  via: "internal" | "share";
  share_token?: string;
  referrer?: string;
  internal_email?: string;
  visible_ms?: number;
}

// ---------- bounds and retention ----------

export const VIEW_RETENTION_DAYS = 90;
export const VIEW_RETENTION_SECONDS = VIEW_RETENTION_DAYS * 24 * 3600;

export const AUDIT_RETENTION_DAYS = 365;
export const AUDIT_RETENTION_SECONDS = AUDIT_RETENTION_DAYS * 24 * 3600;

// ---------- ID generation ----------

// Alphabet for IDs and tokens (no 0/1/i/l/o to avoid confusion).
const SAFE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateShortId(): string {
  return randomString(10);
}

export function generateShareToken(): string {
  return randomString(28); // ~140 bits entropy
}

function randomString(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SAFE_ALPHABET[bytes[i] % SAFE_ALPHABET.length];
  }
  return out;
}

// ---------- share-hours clamp (config-driven) ----------

export function clampShareHours(hours: number | undefined, env: Env): number {
  const cfg = getConfig(env);
  if (hours === undefined || hours === null || isNaN(hours)) {
    return cfg.defaultShareHours;
  }
  return Math.min(cfg.maxShareHours, Math.max(cfg.minShareHours, Math.floor(hours)));
}

// ---------- core CRUD ----------

export async function getDashboard(uuid: string, env: Env): Promise<DashboardMeta | null> {
  const v = await env.DASHBOARDS_KV.get(`dash:${uuid}`);
  if (!v) return null;
  return JSON.parse(v) as DashboardMeta;
}

export async function listDashboards(
  env: Env,
  requesterEmail?: string
): Promise<DashboardMeta[]> {
  const list = await env.DASHBOARDS_KV.list({ prefix: "dash:" });
  const items: DashboardMeta[] = [];
  for (const key of list.keys) {
    const v = await env.DASHBOARDS_KV.get(key.name);
    if (!v) continue;
    const meta = JSON.parse(v) as DashboardMeta;
    if (!requesterEmail || canView(meta, requesterEmail, env)) {
      items.push(meta);
    }
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items;
}

export async function publishDashboard(
  html: string,
  title: string,
  shareHours: number,
  ownerEmail: string | undefined,
  classification: Classification | undefined,
  env: Env
): Promise<{ meta: DashboardMeta; share: ShareLink; password: string }> {
  const uuid = generateShortId();
  const now = new Date().toISOString();

  await env.DASHBOARDS_BUCKET.put(`${uuid}/index.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  const meta: DashboardMeta = {
    uuid,
    title: title.slice(0, 200),
    created_at: now,
    updated_at: now,
    size_bytes: new Blob([html]).size,
    share_generation: 1,
    owner_email: ownerEmail,
    visibility: "private",
    shared_with: [],
    classification: classification || "internal",
    current_version: 1,
    total_versions: 1,
  };

  // Auto-generate password.
  const password = generateReadablePassword();
  const salt = newSaltHex();
  const hash = await pbkdf2(password, salt);
  meta.password_hash = hash;
  meta.password_salt = salt;
  meta.password_set_at = now;

  const { share, updatedMeta } = await issueToken(meta, shareHours, env);
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(updatedMeta));

  await recordAuditEvent(
    {
      uuid,
      action: "publish",
      actor_email: ownerEmail,
      timestamp: now,
      detail: {
        title: updatedMeta.title,
        size_bytes: updatedMeta.size_bytes,
        share_hours: shareHours,
        classification: updatedMeta.classification,
      },
    },
    env
  );

  return { meta: updatedMeta, share, password };
}

export async function updateDashboard(
  uuid: string,
  html: string,
  actorEmail: string | undefined,
  env: Env
): Promise<DashboardMeta> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);
  const cfg = getConfig(env);

  // Move the current HTML to versions/{currentVersion}.html before overwriting,
  // if versioning is enabled (versionsKept > 0).
  if (cfg.versionsKept > 0) {
    const currentVersion = meta.current_version || 1;
    const existing = await env.DASHBOARDS_BUCKET.get(`${uuid}/index.html`);
    if (existing) {
      const oldBody = await existing.text();
      await env.DASHBOARDS_BUCKET.put(
        `${uuid}/versions/${currentVersion}.html`,
        oldBody,
        { httpMetadata: { contentType: "text/html; charset=utf-8" } }
      );
    }

    // Prune older versions beyond versionsKept.
    await pruneOldVersions(uuid, currentVersion, cfg.versionsKept, env);
  }

  const now = new Date().toISOString();
  meta.updated_at = now;
  meta.size_bytes = new Blob([html]).size;
  meta.current_version = (meta.current_version || 1) + 1;
  meta.total_versions = (meta.total_versions || 1) + 1;

  await env.DASHBOARDS_BUCKET.put(`${uuid}/index.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "update",
      actor_email: actorEmail,
      timestamp: now,
      detail: { new_version: meta.current_version, size_bytes: meta.size_bytes },
    },
    env
  );

  return meta;
}

/**
 * Revert a dashboard to a prior version. The current HTML becomes a new version
 * (so revert is itself versioned), and the chosen prior version becomes the
 * new current. Audit logged.
 */
export async function revertDashboard(
  uuid: string,
  toVersion: number,
  actorEmail: string | undefined,
  env: Env
): Promise<DashboardMeta> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);

  if (toVersion < 1 || toVersion >= (meta.current_version || 1)) {
    throw new Error(
      `Version ${toVersion} is not available. Valid range: 1 to ${(meta.current_version || 1) - 1}.`
    );
  }

  const versionObj = await env.DASHBOARDS_BUCKET.get(
    `${uuid}/versions/${toVersion}.html`
  );
  if (!versionObj) {
    throw new Error(
      `Version ${toVersion} no longer exists in storage. It may have been pruned.`
    );
  }
  const versionHtml = await versionObj.text();

  // Snapshot current HTML as a new historical version, then write the chosen
  // version as the new current. This treats revert as just another update.
  return updateDashboard(uuid, versionHtml, actorEmail, env);
}

/**
 * List the available versions for a dashboard, newest first. The "current"
 * version is included in the list (marked with `is_current: true`).
 */
export async function listVersions(
  uuid: string,
  env: Env
): Promise<Array<{ version: number; size_bytes: number; is_current: boolean }>> {
  const meta = await getDashboard(uuid, env);
  if (!meta) return [];

  const out: Array<{ version: number; size_bytes: number; is_current: boolean }> = [];

  // Current
  const cur = await env.DASHBOARDS_BUCKET.head(`${uuid}/index.html`);
  if (cur) {
    out.push({
      version: meta.current_version || 1,
      size_bytes: cur.size,
      is_current: true,
    });
  }

  // Historical
  const list = await env.DASHBOARDS_BUCKET.list({ prefix: `${uuid}/versions/` });
  for (const obj of list.objects) {
    const m = obj.key.match(/\/versions\/(\d+)\.html$/);
    if (!m) continue;
    out.push({
      version: parseInt(m[1], 10),
      size_bytes: obj.size,
      is_current: false,
    });
  }

  out.sort((a, b) => b.version - a.version);
  return out;
}

async function pruneOldVersions(
  uuid: string,
  currentVersion: number,
  keep: number,
  env: Env
): Promise<void> {
  const list = await env.DASHBOARDS_BUCKET.list({ prefix: `${uuid}/versions/` });
  const versions: number[] = [];
  for (const obj of list.objects) {
    const m = obj.key.match(/\/versions\/(\d+)\.html$/);
    if (m) versions.push(parseInt(m[1], 10));
  }
  versions.sort((a, b) => b - a); // newest first

  // Note: we are about to add a new historical version with number = currentVersion,
  // so the future count is `versions.length + 1`. Prune while future count > keep.
  while (versions.length + 1 > keep) {
    const oldest = versions.pop();
    if (oldest === undefined) break;
    await env.DASHBOARDS_BUCKET.delete(`${uuid}/versions/${oldest}.html`);
  }
}

export async function deleteDashboard(
  uuid: string,
  actorEmail: string | undefined,
  env: Env
): Promise<void> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);

  // Delete current HTML and all historical versions.
  await env.DASHBOARDS_BUCKET.delete(`${uuid}/index.html`);
  const versions = await env.DASHBOARDS_BUCKET.list({ prefix: `${uuid}/versions/` });
  for (const obj of versions.objects) {
    await env.DASHBOARDS_BUCKET.delete(obj.key);
  }
  await env.DASHBOARDS_KV.delete(`dash:${uuid}`);
  // Tokens are not explicitly deleted; they fail validation because the
  // dashboard is gone. They expire naturally via KV TTL.

  await recordAuditEvent(
    {
      uuid,
      action: "delete",
      actor_email: actorEmail,
      timestamp: new Date().toISOString(),
      detail: { title: meta.title },
    },
    env
  );
}

// ---------- share-link operations ----------

export async function rotateShareLink(
  uuid: string,
  shareHours: number,
  actorEmail: string | undefined,
  env: Env
): Promise<{ share: ShareLink; password?: string }> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);

  let password: string | undefined;
  if (!isPasswordProtected(meta)) {
    password = generateReadablePassword();
    const salt = newSaltHex();
    meta.password_hash = await pbkdf2(password, salt);
    meta.password_salt = salt;
    meta.password_set_at = new Date().toISOString();
  }

  const { share, updatedMeta } = await issueToken(meta, shareHours, env);
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(updatedMeta));

  await recordAuditEvent(
    {
      uuid,
      action: "rotate_share",
      actor_email: actorEmail,
      timestamp: new Date().toISOString(),
      detail: { share_hours: shareHours, password_generated: !!password },
    },
    env
  );

  return { share, password };
}

export async function revokeShareLinks(
  uuid: string,
  actorEmail: string | undefined,
  env: Env
): Promise<DashboardMeta> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);

  meta.share_generation = (meta.share_generation || 1) + 1;
  meta.updated_at = new Date().toISOString();
  meta.latest_share_expires_at = null;
  meta.latest_share_generation = undefined;
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "revoke_share",
      actor_email: actorEmail,
      timestamp: new Date().toISOString(),
      detail: { new_generation: meta.share_generation },
    },
    env
  );

  return meta;
}

export async function issuePermanentShareLink(
  uuid: string,
  actorEmail: string | undefined,
  env: Env
): Promise<{ share: ShareLink; password?: string }> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);

  let password: string | undefined;
  if (!isPasswordProtected(meta)) {
    password = generateReadablePassword();
    const salt = newSaltHex();
    meta.password_hash = await pbkdf2(password, salt);
    meta.password_salt = salt;
    meta.password_set_at = new Date().toISOString();
  }

  const token = generateShareToken();
  const record: TokenRecord = {
    uuid: meta.uuid,
    generation: meta.share_generation || 1,
    expires_at: null,
  };
  await env.DASHBOARDS_KV.put(`tok:${token}`, JSON.stringify(record));

  meta.latest_share_expires_at = null;
  meta.latest_share_generation = meta.share_generation || 1;
  meta.updated_at = new Date().toISOString();
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "permanent_share",
      actor_email: actorEmail,
      timestamp: new Date().toISOString(),
      detail: { password_generated: !!password },
    },
    env
  );

  return {
    share: {
      token,
      url: `https://${env.PUBLIC_HOST}/${token}`,
      expires_at: "permanent",
    },
    password,
  };
}

async function issueToken(
  meta: DashboardMeta,
  shareHours: number,
  env: Env
): Promise<{ share: ShareLink; updatedMeta: DashboardMeta }> {
  const token = generateShareToken();
  const durationSeconds = shareHours * 3600;
  const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();

  const record: TokenRecord = {
    uuid: meta.uuid,
    generation: meta.share_generation || 1,
    expires_at: expiresAt,
  };
  await env.DASHBOARDS_KV.put(`tok:${token}`, JSON.stringify(record), {
    expirationTtl: durationSeconds,
  });

  const updatedMeta: DashboardMeta = {
    ...meta,
    latest_share_expires_at: expiresAt,
    latest_share_generation: meta.share_generation || 1,
  };

  return {
    share: {
      token,
      url: `https://${env.PUBLIC_HOST}/${token}`,
      expires_at: expiresAt,
    },
    updatedMeta,
  };
}

/**
 * Returns the active share status for a dashboard.
 */
export function activeShareStatus(meta: DashboardMeta): {
  active: boolean;
  expiresAt?: string | null;
  permanent?: boolean;
} {
  if (meta.latest_share_generation === undefined) return { active: false };
  if (meta.latest_share_generation !== (meta.share_generation || 1)) {
    return { active: false };
  }
  if (meta.latest_share_expires_at === null) {
    return { active: true, expiresAt: null, permanent: true };
  }
  if (!meta.latest_share_expires_at) return { active: false };
  if (new Date(meta.latest_share_expires_at).getTime() <= Date.now()) {
    return { active: false };
  }
  return { active: true, expiresAt: meta.latest_share_expires_at, permanent: false };
}

// ---------- visibility and classification ----------

export async function setSharing(
  uuid: string,
  visibility: Visibility,
  sharedWith: string[],
  actorEmail: string | undefined,
  env: Env
): Promise<{ meta: DashboardMeta; previousSharedWith: string[] }> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);

  const previousSharedWith = meta.shared_with ? [...meta.shared_with] : [];

  meta.visibility = visibility;
  meta.shared_with = visibility === "shared" ? normalizeEmails(sharedWith) : [];
  meta.updated_at = new Date().toISOString();
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "set_visibility",
      actor_email: actorEmail,
      timestamp: meta.updated_at,
      detail: {
        visibility,
        shared_with: meta.shared_with,
        previous_shared_with: previousSharedWith,
      },
    },
    env
  );

  return { meta, previousSharedWith };
}

export async function setClassification(
  uuid: string,
  classification: Classification,
  actorEmail: string | undefined,
  env: Env
): Promise<DashboardMeta> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);
  const previous = meta.classification || "internal";
  meta.classification = classification;
  meta.updated_at = new Date().toISOString();
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "set_classification",
      actor_email: actorEmail,
      timestamp: meta.updated_at,
      detail: { from: previous, to: classification },
    },
    env
  );

  return meta;
}

function normalizeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = raw.trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

// ---------- password operations ----------

export async function regeneratePassword(
  uuid: string,
  actorEmail: string | undefined,
  env: Env
): Promise<{ password: string }> {
  const password = generateReadablePassword();
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);
  const salt = newSaltHex();
  meta.password_hash = await pbkdf2(password, salt);
  meta.password_salt = salt;
  meta.password_set_at = new Date().toISOString();
  meta.updated_at = meta.password_set_at;
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "regenerate_password",
      actor_email: actorEmail,
      timestamp: meta.password_set_at,
    },
    env
  );

  return { password };
}

export async function setDashboardPassword(
  uuid: string,
  password: string,
  env: Env
): Promise<DashboardMeta> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);
  if (!password || password.length < 4) {
    throw new Error("Password must be at least 4 characters.");
  }
  const salt = newSaltHex();
  const hash = await pbkdf2(password, salt);
  meta.password_hash = hash;
  meta.password_salt = salt;
  meta.password_set_at = new Date().toISOString();
  meta.updated_at = meta.password_set_at;
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));
  return meta;
}

export async function clearDashboardPassword(
  uuid: string,
  actorEmail: string | undefined,
  env: Env
): Promise<DashboardMeta> {
  const meta = await getDashboard(uuid, env);
  if (!meta) throw new Error(`Dashboard ${uuid} not found`);
  delete meta.password_hash;
  delete meta.password_salt;
  delete meta.password_set_at;
  meta.updated_at = new Date().toISOString();
  await env.DASHBOARDS_KV.put(`dash:${uuid}`, JSON.stringify(meta));

  await recordAuditEvent(
    {
      uuid,
      action: "clear_password",
      actor_email: actorEmail,
      timestamp: meta.updated_at,
    },
    env
  );

  return meta;
}

export async function verifyDashboardPassword(
  meta: DashboardMeta,
  password: string
): Promise<boolean> {
  if (!meta.password_hash || !meta.password_salt) return false;
  const candidate = await pbkdf2(password, meta.password_salt);
  return constantTimeEqual(candidate, meta.password_hash);
}

export function isPasswordProtected(meta: DashboardMeta): boolean {
  return !!(meta.password_hash && meta.password_salt);
}

// ---------- permission checks (delegate to config helpers) ----------

export function canMutate(
  meta: DashboardMeta,
  requesterEmail: string | undefined,
  env: Env
): string | null {
  if (!requesterEmail) return null; // local dev with bearer
  const cfg = getConfig(env);
  const requester = requesterEmail.toLowerCase();

  if (meta.owner_email && meta.owner_email.toLowerCase() === requester) return null;
  if (configIsAdmin(requesterEmail, cfg)) return null;

  return `Only the owner${
    cfg.adminEmails.length > 0 ? " or an admin" : ""
  } can modify this dashboard. Owner: ${meta.owner_email || "unknown"}.`;
}

export function isAdmin(email: string | undefined, env: Env): boolean {
  return configIsAdmin(email || null, getConfig(env));
}

export function canView(
  meta: DashboardMeta,
  requesterEmail: string | undefined,
  env: Env
): boolean {
  if (!requesterEmail) return true;
  const cfg = getConfig(env);
  const requester = requesterEmail.toLowerCase();

  if (meta.owner_email && meta.owner_email.toLowerCase() === requester) return true;
  if (configIsAdmin(requesterEmail, cfg)) return true;

  const visibility: Visibility = meta.visibility || "private";
  if (visibility === "org") {
    // Any user who passes the SSO-domain check can see "org" dashboards.
    return isAllowedSsoEmail(requesterEmail, cfg);
  }
  if (visibility === "shared") {
    const shared = (meta.shared_with || []).map((e) => e.toLowerCase());
    return shared.includes(requester);
  }
  return false;
}

// ---------- audit log ----------

export async function recordAuditEvent(event: AuditEvent, env: Env): Promise<void> {
  const ts = event.timestamp || new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 10);
  const key = `audit:${event.uuid}:${ts}:${rand}`;
  await env.DASHBOARDS_KV.put(key, JSON.stringify({ ...event, timestamp: ts }), {
    expirationTtl: AUDIT_RETENTION_SECONDS,
  });
}

export async function listAuditEvents(
  uuid: string,
  env: Env,
  limit = 100
): Promise<AuditEvent[]> {
  const list = await env.DASHBOARDS_KV.list({
    prefix: `audit:${uuid}:`,
    limit: 1000,
  });
  const records: AuditEvent[] = [];
  for (const k of list.keys) {
    const v = await env.DASHBOARDS_KV.get(k.name);
    if (!v) continue;
    try {
      records.push(JSON.parse(v) as AuditEvent);
    } catch {
      continue;
    }
  }
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return records.slice(0, limit);
}

// ---------- view logging ----------

export function truncateIp(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    return undefined;
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return `${parts.slice(0, 4).join(":")}::`;
  }
  return undefined;
}

export function classifyDevice(
  ua: string | null | undefined
): "mobile" | "tablet" | "desktop" | undefined {
  if (!ua) return undefined;
  const s = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|kindle/.test(s)) return "tablet";
  if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/.test(s)) {
    if (/android/.test(s) && !/mobile/.test(s)) return "tablet";
    return "mobile";
  }
  return "desktop";
}

export async function recordView(record: ViewRecord, env: Env): Promise<void> {
  const ts = record.timestamp;
  const rand = Math.random().toString(36).slice(2, 10);
  const key = `view:${record.uuid}:${ts}:${rand}`;
  await env.DASHBOARDS_KV.put(key, JSON.stringify(record), {
    expirationTtl: VIEW_RETENTION_SECONDS,
  });
}

export async function updateViewVisibleMs(
  uuid: string,
  sessionId: string,
  visibleMs: number,
  env: Env
): Promise<void> {
  const list = await env.DASHBOARDS_KV.list({
    prefix: `view:${uuid}:`,
    limit: 200,
  });
  const keys = list.keys.map((k) => k.name).sort().reverse();
  for (const key of keys) {
    const v = await env.DASHBOARDS_KV.get(key);
    if (!v) continue;
    let rec: ViewRecord;
    try {
      rec = JSON.parse(v);
    } catch {
      continue;
    }
    if (rec.session_id !== sessionId) continue;
    if ((rec.visible_ms || 0) >= visibleMs) return;
    rec.visible_ms = visibleMs;
    const recordedAt = new Date(rec.timestamp).getTime();
    const ageSeconds = Math.floor((Date.now() - recordedAt) / 1000);
    const remaining = Math.max(60, VIEW_RETENTION_SECONDS - ageSeconds);
    await env.DASHBOARDS_KV.put(key, JSON.stringify(rec), {
      expirationTtl: remaining,
    });
    return;
  }
}

export async function listViews(
  uuid: string,
  env: Env,
  limit = 50
): Promise<ViewRecord[]> {
  const list = await env.DASHBOARDS_KV.list({
    prefix: `view:${uuid}:`,
    limit: 1000,
  });
  const records: ViewRecord[] = [];
  for (const k of list.keys) {
    const v = await env.DASHBOARDS_KV.get(k.name);
    if (!v) continue;
    try {
      records.push(JSON.parse(v) as ViewRecord);
    } catch {
      continue;
    }
  }
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return records.slice(0, limit);
}

export async function clearViews(uuid: string, env: Env): Promise<number> {
  const list = await env.DASHBOARDS_KV.list({
    prefix: `view:${uuid}:`,
    limit: 1000,
  });
  let deleted = 0;
  for (const k of list.keys) {
    await env.DASHBOARDS_KV.delete(k.name);
    deleted++;
  }
  return deleted;
}

// ---------- crypto helpers ----------

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BITS = 256;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function pbkdf2(password: string, saltHex: string): Promise<string> {
  const salt = hexToBytes(saltHex);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    PBKDF2_KEY_BITS
  );
  return bytesToHex(new Uint8Array(bits));
}

function newSaltHex(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToHex(salt);
}

/**
 * Three short common words plus two digits. Easy to dictate, easy to type.
 * ~30 bits combined with rate limiting (5 attempts per 10 min, 60s lockout)
 * makes brute force infeasible over normal share-link windows.
 */
export function generateReadablePassword(): string {
  const a = WORDLIST[crypto.getRandomValues(new Uint16Array(1))[0] % WORDLIST.length];
  const b = WORDLIST[crypto.getRandomValues(new Uint16Array(1))[0] % WORDLIST.length];
  const c = WORDLIST[crypto.getRandomValues(new Uint16Array(1))[0] % WORDLIST.length];
  const n = (crypto.getRandomValues(new Uint8Array(1))[0] % 90) + 10;
  return `${a}-${b}-${c}-${n}`;
}

const WORDLIST = [
  "amber","anchor","apple","arrow","aspen","atlas","autumn","azure","badge","balsa",
  "banner","barley","basin","beacon","beech","birch","bishop","bison","blaze","blossom",
  "boulder","branch","breeze","bridge","brook","bronze","buckle","cabin","cable","cactus",
  "calico","candle","canopy","canyon","carbon","cardinal","cargo","castle","cedar","cello",
  "chalk","cherry","chime","cinder","cirrus","citrus","clarity","clover","cobalt","cobble",
  "comet","compass","copper","coral","cosmos","cotton","crater","crayon","crystal","cypress",
  "daisy","dawn","delta","desert","diamond","dolphin","dragon","dune","eagle","echo",
  "ember","emerald","empire","ethos","falcon","feather","fennel","ferry","fjord","flannel",
  "flint","forest","fossil","foxglove","fractal","frost","galaxy","garnet","gentle","ginger",
  "glacier","glade","granite","grove","gypsum","hadron","hammock","harbor","harvest","haven",
  "hazel","heron","hickory","horizon","ibis","indigo","ingot","iris","ivory",
  "jade","jasper","jetty","journey","jubilee","junction","juniper","kettle","kindle","koala",
  "lagoon","lantern","lapis","laurel","lavender","ledger","lemon","lichen","lilac","linen",
  "lobster","lotus","lumen","lunar","lyric","magnet","mango","maple","marble","marine",
  "marsh","meadow","melody","meteor","midnight","mirror","mosaic","moss","mountain","myrtle",
  "nautical","nebula","needle","nimbus","nomad","northern","oasis","oat","ocean","olive",
  "onyx","opal","orbit","orchard","oregon","otter","oxide","paddle","parsley","pearl",
  "pebble","pecan","penguin","pepper","petal","pewter","phoenix","piano","pigeon","pine",
  "pioneer","pivot","plover","plum","polar","pollen","poppy","porcelain","prairie","prism",
  "puffin","quartz","quill","quokka","rabbit","raindrop","rapid","raven","reed","reef",
  "ribbon","rim","ripple","river","rosemary","rover","rowan","ruby","rye","sable",
  "saffron","sage","salmon","sandstone","sapphire","scarlet","sequoia","shadow","shale","shore",
  "silver","slate","sloth","snowdrop","sparrow","spruce","stable","stardust","stellar","stone",
  "summit","sycamore","tally","tangerine","tartan","tarot","teal","thistle","thunder","tidal",
  "tiger","timber","topaz","torch","tower","trail","trout","truffle","tundra","turquoise"
];

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ---------- password challenge cookie (HMAC) ----------

export async function makePasswordCookie(
  meta: DashboardMeta,
  env: Env
): Promise<{ cookie: string; expiresInSec: number }> {
  const max = 24 * 3600;
  let lifetime = max;
  if (meta.latest_share_expires_at) {
    const remaining = Math.floor(
      (new Date(meta.latest_share_expires_at).getTime() - Date.now()) / 1000
    );
    if (remaining > 0 && remaining < lifetime) lifetime = remaining;
  }
  const exp = Math.floor(Date.now() / 1000) + lifetime;
  const sig = await hmacForCookie(meta, env, exp);
  return { cookie: `${sig}.${exp}`, expiresInSec: lifetime };
}

export async function verifyPasswordCookie(
  meta: DashboardMeta,
  cookieValue: string | undefined,
  env: Env
): Promise<boolean> {
  if (!cookieValue) return false;
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return false;
  const sig = cookieValue.slice(0, idx);
  const expStr = cookieValue.slice(idx + 1);
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) >= exp) return false;
  const expected = await hmacForCookie(meta, env, exp);
  return constantTimeEqual(sig, expected);
}

async function hmacForCookie(
  meta: DashboardMeta,
  env: Env,
  exp: number
): Promise<string> {
  const secretMaterial = `${env.MCP_BEARER_TOKEN}|${meta.password_set_at || ""}|${meta.share_generation || 1}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = enc.encode(`${meta.uuid}|${exp}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return bytesToHex(new Uint8Array(sig));
}

// ---------- failed-attempt rate limiting ----------

export async function recordFailedAttempt(
  uuid: string,
  ipKey: string,
  env: Env
): Promise<{ count: number; locked_until?: number }> {
  const key = `pwfail:${uuid}:${ipKey}`;
  const existing = await env.DASHBOARDS_KV.get(key);
  let count = 1;
  if (existing) {
    try {
      count = (JSON.parse(existing).count || 0) + 1;
    } catch {
      // ignore
    }
  }
  const locked_until = count >= 5 ? Math.floor(Date.now() / 1000) + 60 : undefined;
  await env.DASHBOARDS_KV.put(
    key,
    JSON.stringify({ count, locked_until }),
    { expirationTtl: 600 }
  );
  return { count, locked_until };
}

export async function getAttemptStatus(
  uuid: string,
  ipKey: string,
  env: Env
): Promise<{ count: number; locked_until?: number }> {
  const key = `pwfail:${uuid}:${ipKey}`;
  const existing = await env.DASHBOARDS_KV.get(key);
  if (!existing) return { count: 0 };
  try {
    return JSON.parse(existing);
  } catch {
    return { count: 0 };
  }
}

export async function clearFailedAttempts(
  uuid: string,
  ipKey: string,
  env: Env
): Promise<void> {
  await env.DASHBOARDS_KV.delete(`pwfail:${uuid}:${ipKey}`);
}

// ---------- token validation ----------

export async function validateShareToken(
  token: string,
  env: Env
): Promise<DashboardMeta | null> {
  const tokenJson = await env.DASHBOARDS_KV.get(`tok:${token}`);
  if (!tokenJson) return null;

  let record: TokenRecord;
  try {
    record = JSON.parse(tokenJson);
  } catch {
    return null;
  }

  if (record.expires_at !== null && new Date(record.expires_at).getTime() < Date.now()) {
    return null;
  }

  const meta = await getDashboard(record.uuid, env);
  if (!meta) return null;
  if (record.generation < (meta.share_generation || 1)) return null;

  return meta;
}
