/**
 * Internal HTTP API used by the control plane landing page.
 *
 * Cloudflare Access protects this hostname in production, so any caller is
 * already SSO-authenticated. We additionally enforce per-dashboard ownership
 * for mutations and the SSO-domain allowlist as defense in depth.
 *
 * Endpoints (all POST, JSON in/out, all take a `uuid`):
 *   /api/rotate             generate a fresh share link
 *   /api/permanent          generate a permanent share link (admin-only)
 *   /api/revoke             invalidate all share links
 *   /api/delete             permanently delete the dashboard
 *   /api/sharing            change visibility / shared_with
 *   /api/classification     set classification (public | internal | confidential)
 *   /api/views              list recent views
 *   /api/clear-views        clear view log
 *   /api/regenerate-password
 *   /api/clear-password     admin-only
 *   /api/qr                 SVG of the most recent share-link QR
 *   /api/list-versions      list available historical versions
 *   /api/revert             revert to a prior version
 *   /api/audit              list audit events for this dashboard
 */

import type { Env } from "./index";
import {
  Visibility,
  Classification,
  clampShareHours,
  rotateShareLink,
  revokeShareLinks,
  deleteDashboard,
  getDashboard,
  canMutate,
  isAdmin,
  setSharing,
  setClassification,
  issuePermanentShareLink,
  listViews,
  clearViews,
  regeneratePassword,
  clearDashboardPassword,
  listVersions,
  revertDashboard,
  listAuditEvents,
} from "./store";
import { generateQrSvg } from "./qr";
import {
  emailOwnerOnExternalShare,
  emailNewlySharedRecipients,
} from "./email-queue";

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const requesterEmail =
    request.headers.get("Cf-Access-Authenticated-User-Email") || undefined;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const uuid = String(body.uuid || "");
  if (!uuid) return json({ error: "uuid_required" }, 400);

  try {
    const existing = await getDashboard(uuid, env);
    if (!existing) return json({ error: "not_found" }, 404);

    const denied = canMutate(existing, requesterEmail, env);
    if (denied) return json({ error: denied }, 403);

    switch (url.pathname) {
      case "/api/rotate": {
        const hours = clampShareHours(body.duration_hours as number | undefined, env);
        const result = await rotateShareLink(uuid, hours, requesterEmail, env);
        ctx.waitUntil(
          emailOwnerOnExternalShare({
            ownerEmail: existing.owner_email,
            uuid,
            title: existing.title,
            shareUrl: result.share.url,
            password: result.password,
            expiresAt: result.share.expires_at,
            classification: existing.classification,
            env,
          })
        );
        return json({
          share_url: result.share.url,
          expires_at: result.share.expires_at,
          duration_hours: hours,
          password: result.password || null,
        });
      }

      case "/api/permanent": {
        if (!isAdmin(requesterEmail, env)) {
          return json({ error: "Permanent share links are admin-only." }, 403);
        }
        const result = await issuePermanentShareLink(uuid, requesterEmail, env);
        ctx.waitUntil(
          emailOwnerOnExternalShare({
            ownerEmail: existing.owner_email,
            uuid,
            title: existing.title,
            shareUrl: result.share.url,
            password: result.password,
            expiresAt: "permanent",
            classification: existing.classification,
            env,
          })
        );
        return json({
          share_url: result.share.url,
          expires_at: null,
          permanent: true,
          password: result.password || null,
        });
      }

      case "/api/revoke": {
        await revokeShareLinks(uuid, requesterEmail, env);
        return json({ ok: true });
      }

      case "/api/delete": {
        await deleteDashboard(uuid, requesterEmail, env);
        return json({ ok: true });
      }

      case "/api/sharing": {
        const visibilityRaw = String(body.visibility || "");
        if (
          visibilityRaw !== "private" &&
          visibilityRaw !== "shared" &&
          visibilityRaw !== "org"
        ) {
          return json({ error: "invalid_visibility" }, 400);
        }
        const visibility = visibilityRaw as Visibility;
        const sharedWithRaw = body.shared_with;
        const sharedWith = Array.isArray(sharedWithRaw)
          ? sharedWithRaw.map(String)
          : [];
        const result = await setSharing(uuid, visibility, sharedWith, requesterEmail, env);
        if (visibility === "shared") {
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
        return json({
          ok: true,
          visibility: result.meta.visibility,
          shared_with: result.meta.shared_with,
        });
      }

      case "/api/classification": {
        const classRaw = String(body.classification || "");
        if (
          classRaw !== "public" &&
          classRaw !== "internal" &&
          classRaw !== "confidential"
        ) {
          return json({ error: "invalid_classification" }, 400);
        }
        const meta = await setClassification(
          uuid,
          classRaw as Classification,
          requesterEmail,
          env
        );
        return json({ ok: true, classification: meta.classification });
      }

      case "/api/views": {
        const records = await listViews(uuid, env, 50);
        const sanitized = records.map((r) => ({
          timestamp: r.timestamp,
          country: r.country,
          region: r.region,
          city: r.city,
          device_class: r.device_class,
          via: r.via,
          share_token_short: r.share_token ? r.share_token.slice(0, 6) : null,
          referrer: r.referrer,
          internal_email: r.internal_email,
          visible_ms: r.visible_ms || 0,
        }));
        return json({ views: sanitized, retention_days: 90 });
      }

      case "/api/clear-views": {
        const deleted = await clearViews(uuid, env);
        return json({ ok: true, deleted });
      }

      case "/api/regenerate-password": {
        const result = await regeneratePassword(uuid, requesterEmail, env);
        return json({ ok: true, password: result.password });
      }

      case "/api/clear-password": {
        if (!isAdmin(requesterEmail, env)) {
          return json({ error: "Removing password protection is admin-only." }, 403);
        }
        await clearDashboardPassword(uuid, requesterEmail, env);
        return json({ ok: true });
      }

      case "/api/list-versions": {
        const versions = await listVersions(uuid, env);
        return json({ versions });
      }

      case "/api/revert": {
        const toVersion = Number(body.version);
        if (!Number.isFinite(toVersion) || toVersion < 1) {
          return json({ error: "version_required" }, 400);
        }
        const meta = await revertDashboard(uuid, toVersion, requesterEmail, env);
        return json({ ok: true, current_version: meta.current_version });
      }

      case "/api/audit": {
        const limit = Math.min(500, Math.max(1, Number(body.limit) || 100));
        const events = await listAuditEvents(uuid, env, limit);
        return json({ events });
      }

      case "/api/current-share": {
        // Return the current active share URL for this dashboard, looked up the
        // same way the QR endpoint does. Returns 404 with no_active_share if
        // there is no live token at the current generation. This exists so the
        // control plane can copy the URL without ever rotating.
        if (!existing.latest_share_generation) {
          return json({ error: "no_active_share" }, 404);
        }
        const tokList = await env.DASHBOARDS_KV.list({ prefix: "tok:", limit: 1000 });
        let bestToken: string | null = null;
        let bestTime = 0;
        let bestExpires: string | null | undefined;
        for (const k of tokList.keys) {
          const v = await env.DASHBOARDS_KV.get(k.name);
          if (!v) continue;
          let rec: { uuid: string; generation: number; expires_at: string | null };
          try {
            rec = JSON.parse(v);
          } catch {
            continue;
          }
          if (rec.uuid !== uuid) continue;
          if (rec.generation < (existing.share_generation || 1)) continue;
          const ts =
            rec.expires_at === null ? Infinity : new Date(rec.expires_at).getTime();
          if (ts > bestTime) {
            bestTime = ts;
            bestToken = k.name.slice("tok:".length);
            bestExpires = rec.expires_at;
          }
        }
        if (!bestToken) return json({ error: "no_active_share" }, 404);
        return json({
          share_url: `https://${env.PUBLIC_HOST}/${bestToken}`,
          expires_at: bestExpires === null ? null : bestExpires,
          permanent: bestExpires === null,
        });
      }

      case "/api/qr": {
        if (!existing.latest_share_generation) {
          return json({ error: "no_active_share" }, 404);
        }
        const list = await env.DASHBOARDS_KV.list({ prefix: "tok:", limit: 1000 });
        let bestToken: string | null = null;
        let bestTime = 0;
        for (const k of list.keys) {
          const v = await env.DASHBOARDS_KV.get(k.name);
          if (!v) continue;
          let rec: { uuid: string; generation: number; expires_at: string | null };
          try {
            rec = JSON.parse(v);
          } catch {
            continue;
          }
          if (rec.uuid !== uuid) continue;
          if (rec.generation < (existing.share_generation || 1)) continue;
          const ts =
            rec.expires_at === null ? Infinity : new Date(rec.expires_at).getTime();
          if (ts > bestTime) {
            bestTime = ts;
            bestToken = k.name.slice("tok:".length);
          }
        }
        if (!bestToken) {
          return json({ error: "no_active_share" }, 404);
        }
        const shareUrl = `https://${env.PUBLIC_HOST}/${bestToken}`;
        const svg = generateQrSvg(shareUrl);
        return new Response(svg, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "private, no-store",
          },
        });
      }

      default:
        return json({ error: "unknown_endpoint" }, 404);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
