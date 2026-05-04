/**
 * Internal dashboard serving from R2 by uuid.
 * Cloudflare Access protects this hostname in production. We further
 * enforce per-dashboard visibility (private / shared / org).
 *
 * Classification banner and tracking are injected here for HTML dashboards.
 */

import type { Env } from "./index";
import { renderError } from "./share";
import { getDashboard, canView } from "./store";
import { recordInitialView, injectIntoR2Html } from "./tracking";

export async function handleServe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(1);

  const match = path.match(/^([a-z0-9]+)(?:\/(.*))?$/);
  if (!match) {
    return renderError("Not found", "This URL does not match a known dashboard.", 404, env);
  }

  const [, uuid, subpath] = match;
  const requesterEmail =
    request.headers.get("Cf-Access-Authenticated-User-Email") || undefined;

  const meta = await getDashboard(uuid, env);
  if (!meta) {
    return renderError(
      "Dashboard not found",
      "The dashboard you are looking for does not exist or has been deleted.",
      404,
      env
    );
  }

  if (!canView(meta, requesterEmail, env)) {
    return renderError(
      "You do not have access",
      `This dashboard is private. Ask ${meta.owner_email || "the owner"} to share it with you.`,
      403,
      env
    );
  }

  const key = subpath ? `${uuid}/${subpath}` : `${uuid}/index.html`;
  const obj = await env.DASHBOARDS_BUCKET.get(key);
  if (!obj) {
    return renderError(
      "Dashboard not found",
      "The dashboard you are looking for does not exist or has been deleted.",
      404,
      env
    );
  }

  const contentType = obj.httpMetadata?.contentType || guessContentType(key);

  const isMainHtml = !subpath && contentType.startsWith("text/html");
  if (isMainHtml) {
    const sessionId = await recordInitialView(
      request,
      { uuid, via: "internal", internalEmail: requesterEmail },
      env
    );
    const html = await injectIntoR2Html({
      obj,
      uuid,
      sessionId,
      classification: meta.classification,
      showFooter: true,
      env,
    });
    const headers = new Headers();
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    return new Response(html, { headers });
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

function guessContentType(key: string): string {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".css")) return "text/css; charset=utf-8";
  if (key.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".svg")) return "image/svg+xml";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}
