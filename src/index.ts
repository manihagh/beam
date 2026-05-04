/**
 * Beam Worker entrypoint.
 *
 * One Worker, three production hostnames:
 *   {MCP_HOST}     -> MCP server (Cloudflare Access in front)
 *   {SERVE_HOST}   -> internal control plane (Cloudflare Access in front)
 *   {PUBLIC_HOST}  -> public share viewer (no Access, token-gated)
 *
 * In local dev, hostname is rewritten by Wrangler so we route by path:
 *   /mcp                 -> MCP
 *   /api/...             -> internal API
 *   /share/{token}       -> public viewer
 *   /, /{uuid}           -> internal landing / serving
 */

import { handleMcp } from "./mcp";
import { handleServe } from "./serve";
import { handleShare } from "./share";
import { handleApi } from "./api";
import { handleTrack } from "./track-api";
import { renderLanding } from "./landing";
import { generateQrSvg } from "./qr";
import { getConfig, isAdmin, isAllowedSsoEmail } from "./config";

export interface Env {
  // Bindings
  DASHBOARDS_BUCKET: R2Bucket;
  DASHBOARDS_KV: KVNamespace;

  // Hostnames
  SERVE_HOST: string;
  MCP_HOST: string;
  PUBLIC_HOST: string;

  // Branding
  BRAND_NAME?: string;
  BRAND_PRIMARY_COLOR?: string;
  BRAND_FROM_EMAIL?: string;

  // Access control
  ALLOWED_SSO_DOMAINS?: string;
  ADMIN_EMAILS?: string;

  // Share link policy
  DEFAULT_SHARE_HOURS?: string;
  MIN_SHARE_HOURS?: string;
  MAX_SHARE_HOURS?: string;

  // Versioning
  DASHBOARD_VERSIONS_KEPT?: string;

  // Secrets
  MCP_BEARER_TOKEN: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  UNSUB_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;
    const cfg = getConfig(env);

    // /mcp on any host -> MCP server. Auth check is inside.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return handleMcp(request, env, ctx);
    }

    // /track endpoints accept beacons from served dashboards on any host.
    if (url.pathname === "/track/heartbeat" || url.pathname === "/track/leave") {
      return handleTrack(request, env);
    }

    // Public QR endpoint. Lives on the public host (no Access auth) so
    // recipient email clients can fetch the image directly. The URL to encode
    // is passed as a query param. We restrict the target to URLs on our own
    // hosts so this cannot be abused as a generic QR generator.
    if (host === cfg.publicHost && url.pathname === "/qr-public") {
      const target = url.searchParams.get("u");
      if (!target) {
        return new Response("missing u parameter", { status: 400 });
      }
      try {
        const t = new URL(target);
        if (t.hostname !== cfg.serveHost && t.hostname !== cfg.publicHost) {
          return new Response("disallowed host", { status: 400 });
        }
      } catch {
        return new Response("invalid url", { status: 400 });
      }
      const svg = generateQrSvg(target);
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Public share host: every path is a token.
    if (host === cfg.publicHost) {
      return handleShare(request, env);
    }

    // MCP host: nothing else valid.
    if (host === cfg.mcpHost) {
      return new Response("Not found", { status: 404 });
    }

    // Local dev path-based routing for the public share viewer.
    if (url.pathname === "/share" || url.pathname.startsWith("/share/")) {
      return handleShare(request, env);
    }

    // Internal API used by the control plane UI.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    // Default: internal control plane (serve host or local dev).
    if (url.pathname === "/whoami") {
      const email = request.headers.get("Cf-Access-Authenticated-User-Email") || null;
      return new Response(
        JSON.stringify(
          {
            cf_access_email: email,
            allowed_sso: isAllowedSsoEmail(email, cfg),
            you_are_admin: isAdmin(email, cfg),
            admin_emails_configured: cfg.adminEmails,
            allowed_sso_domains: cfg.allowedSsoDomains,
          },
          null,
          2
        ),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/" || url.pathname === "") {
      const requesterEmail =
        request.headers.get("Cf-Access-Authenticated-User-Email") || undefined;
      return renderLanding(env, requesterEmail);
    }

    return handleServe(request, env);
  },
};
