/**
 * MCP server (JSON-RPC 2.0 over HTTP).
 *
 * Tools (11):
 *   publish_dashboard         publish new HTML, return internal + external URLs
 *   update_dashboard          replace HTML; previous version archived
 *   list_dashboards           list dashboards visible to the requester
 *   delete_dashboard          permanent delete (irreversible)
 *   rotate_share_link         fresh external URL, optional fresh password
 *   revoke_share_links        kill all existing share links immediately
 *   set_visibility            internal sharing: private | shared | org
 *   regenerate_password       new password without rotating URL
 *   set_classification        public | internal | confidential (banner injected)
 *   list_versions             show available versions of a dashboard
 *   revert_dashboard          revert HTML to a prior version
 *   get_audit_log             show recent audit events for a dashboard
 *
 * Auth: accepts either Cloudflare Access (production) or bearer token (local dev).
 */

import type { Env } from "./index";
import { getConfig, isAllowedSsoEmail } from "./config";
import {
  Classification,
  DashboardMeta,
  ShareLink,
  Visibility,
  AuditEvent,
  clampShareHours,
  publishDashboard,
  updateDashboard,
  deleteDashboard,
  listDashboards,
  rotateShareLink,
  revokeShareLinks,
  getDashboard,
  canMutate,
  setSharing,
  setClassification,
  regeneratePassword,
  listVersions,
  revertDashboard,
  listAuditEvents,
} from "./store";
import {
  emailOwnerOnExternalShare,
  emailNewlySharedRecipients,
} from "./email-queue";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

function buildTools(env: Env) {
  const cfg = getConfig(env);
  const D = cfg.defaultShareHours;
  const M = cfg.maxShareHours;
  const m = cfg.minShareHours;
  const brand = cfg.brandName;

  return [
    {
      name: "publish_dashboard",
      description: `Publish an HTML dashboard. Returns three things: an internal URL for staff (SSO-protected), an external share URL for non-staff recipients, and an auto-generated password for the external URL.

The HTML must be a single self-contained file (inline CSS, inline JS, external scripts only from common CDNs). Always include a viewport meta tag for mobile compatibility. Avoid localStorage and sessionStorage.

By default, dashboards are private to the publisher and classified as "internal" (a discreet "Internal" banner is injected at the top of every page view). Use set_visibility to grant internal access to specific colleagues or the whole org. Use set_classification to change the classification banner ("public" hides it; "confidential" makes it red).

Pick a sensible share_duration_hours from the user's intent: ${D} hours by default (${Math.round(D / 24)} days), up to ${M} (${Math.round(M / 24)} days), minimum ${m}. If they say "for the meeting tomorrow" use 24, "for next week" use ${M}, "for a quick demo" use 1.`,
      inputSchema: {
        type: "object",
        properties: {
          html: { type: "string", description: "Complete self-contained HTML document." },
          title: { type: "string", description: "Short human-readable title." },
          share_duration_hours: {
            type: "number",
            description: `How long the external share link remains valid, in hours. Default ${D}, max ${M}, min ${m}.`,
          },
          classification: {
            type: "string",
            enum: ["public", "internal", "confidential"],
            description:
              "Classification banner shown on every page view. Defaults to 'internal'. Use 'public' for non-sensitive dashboards (no banner) and 'confidential' for restricted material (red banner).",
          },
        },
        required: ["html", "title"],
      },
    },
    {
      name: "update_dashboard",
      description:
        "Replace the HTML of an existing dashboard. The previous HTML is archived as a historical version (call list_versions to see them). Internal URL and any active share links continue to work and serve the new content.",
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid." },
          html: { type: "string", description: "New complete HTML document." },
        },
        required: ["uuid", "html"],
      },
    },
    {
      name: "list_dashboards",
      description:
        "List all published dashboards across the org with their UUIDs, titles, and internal URLs.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "delete_dashboard",
      description:
        "Permanently delete a dashboard. The internal URL and all share links become invalid immediately. All historical versions are also deleted. This action cannot be undone.",
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid to delete." },
        },
        required: ["uuid"],
      },
    },
    {
      name: "rotate_share_link",
      description: `Generate a fresh external share URL. The new URL is valid for share_duration_hours (default ${D}, max ${M}). The dashboard's existing password (if any) carries over to the new URL; recipients who already know it can re-use it. If the dashboard had no password, this call auto-generates one and returns it. Old share links continue to work until they expire naturally; to kill them immediately, call revoke_share_links first.`,
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid." },
          share_duration_hours: {
            type: "number",
            description: `Hours the new link remains valid. Default ${D}, max ${M}, min ${m}.`,
          },
        },
        required: ["uuid"],
      },
    },
    {
      name: "revoke_share_links",
      description:
        "Immediately invalidate all existing external share links for a dashboard. The internal URL and password are unaffected. After revoking, call rotate_share_link to issue a fresh external link.",
      inputSchema: {
        type: "object",
        properties: { uuid: { type: "string", description: "Dashboard uuid." } },
        required: ["uuid"],
      },
    },
    {
      name: "set_visibility",
      description: `Set internal visibility for a dashboard. Three modes: "private" (only the owner sees it), "shared" (owner plus a list of specific staff emails), and "org" (every authenticated staff member can see it). Use this when the user asks to share a dashboard internally with named colleagues or with the whole team.

When mode is "shared", the emails parameter must be a list of full email addresses on the configured SSO domains. If the user names colleagues without providing emails, ASK the user for the emails; do NOT guess from naming patterns. Multiple aliases for the same person should all be listed if you want robust coverage.

Internal visibility does NOT auto-expire. If the user mentions a time-bounded share for internal access ("share with X for 3 days"), explain that internal visibility persists until manually changed and offer to revert it after the window.`,
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid." },
          mode: {
            type: "string",
            enum: ["private", "shared", "org"],
            description: "Visibility mode.",
          },
          emails: {
            type: "array",
            items: { type: "string" },
            description: "List of email addresses, required only when mode is 'shared'.",
          },
        },
        required: ["uuid", "mode"],
      },
    },
    {
      name: "regenerate_password",
      description:
        "Generate a fresh password for the dashboard's external share link without rotating the URL. Returns the new cleartext password. Use this when the user says they need a new password (e.g. they sent the old one to the wrong person) but does not want to invalidate the URL itself.",
      inputSchema: {
        type: "object",
        properties: { uuid: { type: "string", description: "Dashboard uuid." } },
        required: ["uuid"],
      },
    },
    {
      name: "set_classification",
      description: `Set the classification banner injected at the top of the dashboard on every page view. Three values:

- "public": no banner is shown. Use only for dashboards intended for general external distribution.
- "internal" (default): a discreet grey "Internal" banner. Use for typical company dashboards.
- "confidential": a red "Confidential" banner. Use for sensitive material that should not leave a tightly scoped audience.

Classification is also surfaced in transactional emails and the audit log. Changing classification re-renders the banner on the next page load.`,
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid." },
          classification: {
            type: "string",
            enum: ["public", "internal", "confidential"],
          },
        },
        required: ["uuid", "classification"],
      },
    },
    {
      name: "list_versions",
      description:
        "List the available historical versions for a dashboard, newest first. The current version is included with `is_current: true`. Use this before calling revert_dashboard to confirm which version the user wants.",
      inputSchema: {
        type: "object",
        properties: { uuid: { type: "string", description: "Dashboard uuid." } },
        required: ["uuid"],
      },
    },
    {
      name: "revert_dashboard",
      description:
        "Revert a dashboard to a prior version. The current HTML becomes a new historical version (so revert is itself audit-logged and reversible). Internal URL and active share links continue to work and serve the reverted content.",
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid." },
          version: {
            type: "number",
            description:
              "The version number to revert to. Must be a value returned by list_versions where is_current was false.",
          },
        },
        required: ["uuid", "version"],
      },
    },
    {
      name: "get_audit_log",
      description: `Read recent audit events for a dashboard. The audit log records every mutation: publish, update, revert, delete, rotate_share, revoke_share, permanent_share, set_visibility, set_classification, regenerate_password, clear_password. Each event includes the actor email and a timestamp. Retention is one year.

Use this to answer questions like "who shared this with X" or "when did the classification change."`,
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Dashboard uuid." },
          limit: {
            type: "number",
            description: "Maximum number of events to return (default 50, max 500).",
          },
        },
        required: ["uuid"],
      },
    },
  ];
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth: Cloudflare Access (production) or bearer token (local dev).
  const cfAccessEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.MCP_BEARER_TOKEN}`;
  const hasValidBearer = auth === expected;

  if (!cfAccessEmail && !hasValidBearer) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Defense in depth: even if Access is misconfigured, reject emails outside
  // the allowed SSO domain set.
  const cfg = getConfig(env);
  if (cfAccessEmail && !isAllowedSsoEmail(cfAccessEmail, cfg)) {
    return new Response(
      JSON.stringify({
        error: "sso_domain_not_allowed",
        detail: `Email ${cfAccessEmail} is not on an allowed SSO domain. Update ALLOWED_SSO_DOMAINS to include your domain or fix your Access policy.`,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  if (body.jsonrpc !== "2.0" || !body.method) {
    return jsonRpcError(body.id ?? null, -32600, "Invalid Request");
  }

  // Owner email used for ownership/audit. In local dev with bearer auth, no email.
  const ownerEmail = cfAccessEmail || undefined;

  if (body.method === "tools/list") {
    return jsonRpcResult(body.id, { tools: buildTools(env) });
  }

  if (body.method === "tools/call") {
    return await handleToolCall(body, env, ctx, ownerEmail);
  }

  if (body.method === "initialize") {
    return jsonRpcResult(body.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: cfg.brandName, version: "1.0.0" },
    });
  }

  return jsonRpcError(body.id, -32601, `Method not found: ${body.method}`);
}

async function handleToolCall(
  body: JsonRpcRequest,
  env: Env,
  ctx: ExecutionContext,
  ownerEmail: string | undefined
): Promise<Response> {
  const params = (body.params || {}) as { name?: string; arguments?: Record<string, unknown> };
  const args = params.arguments || {};

  try {
    switch (params.name) {
      case "publish_dashboard": {
        const html = String(args.html || "");
        const title = String(args.title || "Untitled");
        if (!html) throw new Error("html is required");
        const hours = clampShareHours(args.share_duration_hours as number | undefined, env);
        const classification = parseClassification(args.classification);
        const result = await publishDashboard(html, title, hours, ownerEmail, classification, env);
        ctx.waitUntil(
          emailOwnerOnExternalShare({
            ownerEmail,
            uuid: result.meta.uuid,
            title: result.meta.title,
            shareUrl: result.share.url,
            password: result.password,
            expiresAt: result.share.expires_at,
            classification: result.meta.classification,
            env,
          })
        );
        return toolText(body.id, formatPublish(result.meta, result.share, result.password, env));
      }

      case "update_dashboard": {
        const uuid = String(args.uuid || "");
        const html = String(args.html || "");
        if (!uuid) throw new Error("uuid is required");
        if (!html) throw new Error("html is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const meta = await updateDashboard(uuid, html, ownerEmail, env);
        return toolText(body.id, formatUpdate(meta, env));
      }

      case "list_dashboards": {
        const items = await listDashboards(env, ownerEmail);
        return toolText(body.id, formatList(items, env));
      }

      case "delete_dashboard": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        await deleteDashboard(uuid, ownerEmail, env);
        return toolText(body.id, `Deleted ${existing.title} (${uuid}). All share links and historical versions are now invalid.`);
      }

      case "rotate_share_link": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const hours = clampShareHours(args.share_duration_hours as number | undefined, env);
        const result = await rotateShareLink(uuid, hours, ownerEmail, env);
        const refreshed = await getDashboard(uuid, env);
        ctx.waitUntil(
          emailOwnerOnExternalShare({
            ownerEmail: refreshed?.owner_email,
            uuid,
            title: refreshed?.title || existing.title,
            shareUrl: result.share.url,
            password: result.password,
            expiresAt: result.share.expires_at,
            classification: refreshed?.classification,
            env,
          })
        );
        return toolText(body.id, formatRotate(uuid, result.share, hours, result.password));
      }

      case "revoke_share_links": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        await revokeShareLinks(uuid, ownerEmail, env);
        return toolText(
          body.id,
          `All existing external share links for ${uuid} have been revoked. The internal URL still works for staff. Use rotate_share_link to issue a fresh external link.`
        );
      }

      case "set_visibility": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const modeRaw = String(args.mode || "");
        if (modeRaw !== "private" && modeRaw !== "shared" && modeRaw !== "org") {
          throw new Error("mode must be one of: private, shared, org");
        }
        const mode = modeRaw as Visibility;
        const emails = Array.isArray(args.emails) ? (args.emails as string[]) : [];
        if (mode === "shared" && emails.length === 0) {
          throw new Error("emails list cannot be empty when mode is 'shared'");
        }
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const result = await setSharing(uuid, mode, emails, ownerEmail, env);
        if (mode === "shared") {
          ctx.waitUntil(
            emailNewlySharedRecipients({
              ownerEmail: result.meta.owner_email,
              uuid: result.meta.uuid,
              title: result.meta.title,
              oldSharedWith: result.previousSharedWith,
              newSharedWith: result.meta.shared_with || [],
              classification: result.meta.classification,
              env,
            })
          );
        }
        return toolText(body.id, formatVisibility(result.meta, env));
      }

      case "regenerate_password": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const result = await regeneratePassword(uuid, ownerEmail, env);
        return toolText(
          body.id,
          [
            `New password for "${existing.title}":`,
            ``,
            `  ${result.password}`,
            ``,
            `Send this via a different channel than the share URL itself (text, voice, separate email).`,
            `The previous password is now invalid; anyone currently viewing will need to re-authenticate.`,
          ].join("\n")
        );
      }

      case "set_classification": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const classification = parseClassification(args.classification);
        if (!classification) throw new Error("classification must be public, internal, or confidential");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const meta = await setClassification(uuid, classification, ownerEmail, env);
        return toolText(
          body.id,
          `Classification for "${meta.title}" set to "${meta.classification}". The banner will appear on the next page load.`
        );
      }

      case "list_versions": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const versions = await listVersions(uuid, env);
        return toolText(body.id, formatVersions(existing, versions));
      }

      case "revert_dashboard": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const version = Number(args.version);
        if (!Number.isFinite(version) || version < 1) {
          throw new Error("version must be a positive integer");
        }
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const meta = await revertDashboard(uuid, version, ownerEmail, env);
        return toolText(
          body.id,
          `Reverted "${meta.title}" to version ${version}. New current version is ${meta.current_version}. Internal URL and active share links continue to work.`
        );
      }

      case "get_audit_log": {
        const uuid = String(args.uuid || "");
        if (!uuid) throw new Error("uuid is required");
        const existing = await getDashboard(uuid, env);
        if (!existing) throw new Error(`Dashboard ${uuid} not found`);
        const denied = canMutate(existing, ownerEmail, env);
        if (denied) throw new Error(denied);
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
        const events = await listAuditEvents(uuid, env, limit);
        return toolText(body.id, formatAudit(existing, events));
      }

      default:
        return jsonRpcError(body.id, -32602, `Unknown tool: ${params.name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolText(body.id, `Error: ${msg}`, true);
  }
}

// ---------- formatters ----------

function parseClassification(input: unknown): Classification | undefined {
  if (input === "public" || input === "internal" || input === "confidential") {
    return input;
  }
  return undefined;
}

function formatPublish(meta: DashboardMeta, share: ShareLink, password: string, env: Env): string {
  const cfg = getConfig(env);
  const internalUrl = `https://${cfg.serveHost}/${meta.uuid}`;
  return [
    `Published: ${meta.title}`,
    `Classification: ${meta.classification}`,
    ``,
    `Internal URL (private to you, no expiry):`,
    `  ${internalUrl}`,
    ``,
    `External share URL (expires ${formatExpiry(share.expires_at)}):`,
    `  ${share.url}`,
    ``,
    `External password:`,
    `  ${password}`,
    ``,
    `The dashboard is private to you. To grant internal access to specific colleagues or the whole org, use set_visibility (or open ${cfg.serveHost}).`,
    `Send the password to recipients through a different channel than the URL itself (text, voice, separate email).`,
    `Need a QR code for the share URL? Open ${cfg.serveHost} and click "Show QR" on this dashboard.`,
  ].join("\n");
}

function formatUpdate(meta: DashboardMeta, env: Env): string {
  const cfg = getConfig(env);
  const internalUrl = `https://${cfg.serveHost}/${meta.uuid}`;
  return `Updated: ${meta.title}\nNew current version: ${meta.current_version}\nInternal URL: ${internalUrl}\n\nThe previous version is archived. Use list_versions to see history, revert_dashboard to roll back. Existing share links continue to work and now serve the new content. Password (if set) is unchanged.`;
}

function formatRotate(uuid: string, share: ShareLink, hours: number, password?: string): string {
  const lines = [
    `Fresh external share URL for ${uuid}:`,
    ``,
    `  ${share.url}`,
    ``,
    `Valid for ${hours}h (expires ${formatExpiry(share.expires_at)}).`,
  ];
  if (password) {
    lines.push(``, `Password (auto-generated, send via separate channel):`, `  ${password}`);
  } else {
    lines.push(
      ``,
      `The existing password for this dashboard still applies. Recipients who already know it can use it for this URL.`
    );
  }
  lines.push(
    ``,
    `Previous share links remain valid until their own expiry. Use revoke_share_links first if you want them killed immediately.`
  );
  return lines.join("\n");
}

function formatVisibility(meta: DashboardMeta, env: Env): string {
  const cfg = getConfig(env);
  const v = meta.visibility || "private";
  if (v === "private") {
    return `${meta.title} is now private. Only you can see it on ${cfg.serveHost}.`;
  }
  if (v === "org") {
    return `${meta.title} is now visible to all staff on ${cfg.serveHost}.`;
  }
  const list = (meta.shared_with || []).join(", ");
  const count = (meta.shared_with || []).length;
  return `${meta.title} is now shared internally with ${count} ${count === 1 ? "person" : "people"}: ${list}\n\nNote: internal access does not auto-expire. To revoke access later, call set_visibility with mode "private".`;
}

function formatList(items: DashboardMeta[], env: Env): string {
  const cfg = getConfig(env);
  if (items.length === 0) return "No dashboards published yet.";
  const lines = [`Published dashboards (${items.length}):`, ""];
  for (const m of items) {
    lines.push(`- ${m.title}`);
    lines.push(`  Internal: https://${cfg.serveHost}/${m.uuid}`);
    if (m.owner_email) lines.push(`  Owner: ${m.owner_email}`);
    lines.push(`  Classification: ${m.classification || "internal"}`);
    lines.push(`  uuid: ${m.uuid}, created: ${m.created_at}`);
    lines.push("");
  }
  lines.push("To get a fresh external share link for any of these, ask to rotate the share link.");
  return lines.join("\n");
}

function formatVersions(
  meta: DashboardMeta,
  versions: Array<{ version: number; size_bytes: number; is_current: boolean }>
): string {
  if (versions.length === 0) {
    return `No versions found for ${meta.title}.`;
  }
  const lines = [`Versions of "${meta.title}":`, ""];
  for (const v of versions) {
    const tag = v.is_current ? " (current)" : "";
    lines.push(`- v${v.version}${tag}, ${v.size_bytes} bytes`);
  }
  lines.push(
    "",
    `To roll back, call revert_dashboard with one of the non-current version numbers.`
  );
  return lines.join("\n");
}

function formatAudit(meta: DashboardMeta, events: AuditEvent[]): string {
  if (events.length === 0) {
    return `No audit events recorded for ${meta.title}.`;
  }
  const lines = [`Audit log for "${meta.title}" (${events.length} most recent events):`, ""];
  for (const e of events) {
    const actor = e.actor_email || "(no email recorded)";
    const detail = e.detail ? " " + JSON.stringify(e.detail) : "";
    lines.push(`- ${e.timestamp} | ${e.action} | ${actor}${detail}`);
  }
  return lines.join("\n");
}

function formatExpiry(iso: string): string {
  if (iso === "permanent") return "never (permanent)";
  const d = new Date(iso);
  return d.toUTCString();
}

// ---------- JSON-RPC helpers ----------

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function toolText(id: string | number | null, text: string, isError = false): Response {
  return jsonRpcResult(id, {
    content: [{ type: "text", text }],
    isError,
  });
}
