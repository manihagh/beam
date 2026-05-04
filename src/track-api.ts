/**
 * /track/heartbeat and /track/leave endpoints.
 *
 * Called by the beacon JS injected into served dashboards. The payloads
 * carry visible_ms only. We update the existing view record (created when
 * the page first loaded) with the latest visible_ms.
 *
 * No auth: these endpoints are reachable from the public share host, which
 * has no SSO. To prevent random abuse we require the (uuid, session_id)
 * pair to correspond to a real view record.
 *
 * Listing and clearing views are exposed via api.ts (Cloudflare Access auth).
 */

import type { Env } from "./index";
import { updateViewVisibleMs } from "./store";

export async function handleTrack(request: Request, env: Env): Promise<Response> {
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
    return new Response(null, { status: 204 });
  }

  let body: { uuid?: string; session_id?: string; visible_ms?: number };
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 204 });
  }

  const uuid = (body.uuid || "").toString();
  const sessionId = (body.session_id || "").toString();
  const visibleMs = Number(body.visible_ms);

  if (!uuid || !sessionId || !Number.isFinite(visibleMs) || visibleMs < 0) {
    return new Response(null, { status: 204 });
  }
  // Sanity cap: nobody watched a dashboard for >24h continuously.
  const capped = Math.min(visibleMs, 24 * 3600 * 1000);

  await updateViewVisibleMs(uuid, sessionId, capped, env);

  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
