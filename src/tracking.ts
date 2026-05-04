/**
 * View tracking: records initial views and exposes a minimal beacon script
 * that gets injected into served HTML.
 *
 * Privacy posture:
 *   - IPs are truncated server-side (/24 for v4, /64 for v6) before storage.
 *   - 90-day retention via KV TTL.
 *   - No cookies, no persistent identifiers, no cross-session profiles.
 *   - Country/region/city come from request.cf at the edge; no geolocation
 *     library or external service is involved.
 *   - A visible footer notice is added to served HTML so viewers know.
 *
 * Classification banners are also injected here when the dashboard's
 * classification is "internal" or "confidential". The banner is inline
 * styled, sticks to the top, and cannot be dismissed; it is a governance
 * marker, not chrome.
 */

import type { Env } from "./index";
import {
  ViewRecord,
  recordView,
  truncateIp,
  classifyDevice,
  Classification,
} from "./store";
import { getConfig } from "./config";

interface TrackingOpts {
  uuid: string;
  via: "internal" | "share";
  shareToken?: string;
  internalEmail?: string;
}

function makeSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function recordInitialView(
  request: Request,
  opts: TrackingOpts,
  env: Env
): Promise<string> {
  const sessionId = makeSessionId();
  const cf = (request as { cf?: IncomingRequestCfProperties }).cf;
  const ip = request.headers.get("CF-Connecting-IP");
  const ua = request.headers.get("User-Agent");
  const referrer = request.headers.get("Referer") || undefined;

  const record: ViewRecord = {
    uuid: opts.uuid,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    country: (cf?.country as string | undefined) || undefined,
    region: (cf?.region as string | undefined) || undefined,
    city: (cf?.city as string | undefined) || undefined,
    ip_truncated: truncateIp(ip),
    device_class: classifyDevice(ua),
    via: opts.via,
    share_token: opts.shareToken,
    referrer,
    internal_email: opts.internalEmail,
  };

  await recordView(record, env);
  return sessionId;
}

interface InjectArgs {
  html: string;
  uuid: string;
  sessionId: string;
  classification?: Classification;
  showFooter: boolean;
  brandName: string;
}

/**
 * Inject classification banner (top), tracking footer (bottom, dismissable),
 * and the heartbeat beacon script.
 */
export function injectAll(args: InjectArgs): string {
  const { html, uuid, sessionId, classification, showFooter, brandName } = args;

  const banner = renderClassificationBanner(classification);

  const footer = showFooter
    ? `<div id="__beam_footer" style="position:fixed;bottom:0;left:0;right:0;padding:6px 12px;background:rgba(255,255,255,0.92);border-top:1px solid rgba(0,0,0,0.08);font:11px/1.4 system-ui,sans-serif;color:#52525B;text-align:center;z-index:2147483647;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)">${escapeHtml(brandName)} logs page views and approximate viewing duration for security and analytics. Retained 90 days.<button onclick="this.parentElement.remove()" style="margin-left:10px;background:none;border:1px solid rgba(0,0,0,0.15);border-radius:4px;padding:2px 8px;font:inherit;color:inherit;cursor:pointer">dismiss</button></div>`
    : "";

  const script = `<script>(function(){
    var UUID = ${JSON.stringify(uuid)};
    var SID = ${JSON.stringify(sessionId)};
    var visibleMs = 0;
    var lastTick = (document.visibilityState === 'visible') ? Date.now() : 0;
    var sent = 0;
    function tick() {
      if (lastTick && document.visibilityState === 'visible') {
        var now = Date.now();
        visibleMs += (now - lastTick);
        lastTick = now;
      }
    }
    function send(path) {
      tick();
      if (visibleMs <= sent + 1000) return;
      sent = visibleMs;
      var body = JSON.stringify({uuid: UUID, session_id: SID, visible_ms: visibleMs});
      try {
        if (navigator.sendBeacon) {
          var blob = new Blob([body], {type: 'application/json'});
          navigator.sendBeacon(path, blob);
          return;
        }
      } catch(e) {}
      try {
        fetch(path, {method:'POST', body: body, headers:{'Content-Type':'application/json'}, keepalive: true});
      } catch(e) {}
    }
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible') {
        lastTick = Date.now();
      } else {
        tick();
        lastTick = 0;
        send('/track/heartbeat');
      }
    });
    setInterval(function(){ tick(); send('/track/heartbeat'); }, 30000);
    window.addEventListener('pagehide', function(){ send('/track/leave'); });
    window.addEventListener('beforeunload', function(){ send('/track/leave'); });
  })();</script>`;

  let out = html;

  // Inject classification banner just after <body> if banner is set.
  if (banner) {
    if (/<body[^>]*>/i.test(out)) {
      out = out.replace(/(<body[^>]*>)/i, `$1${banner}`);
    } else {
      out = banner + out;
    }
  }

  // Inject footer + script before </body> if present, otherwise append.
  if (/<\/body>/i.test(out)) {
    return out.replace(/<\/body>/i, `${footer}${script}</body>`);
  }
  return out + footer + script;
}

function renderClassificationBanner(c: Classification | undefined): string {
  if (!c || c === "public") return "";
  if (c === "internal") {
    return `<div id="__beam_classification" style="position:sticky;top:0;left:0;right:0;padding:6px 12px;background:#EBE3D0;border-bottom:1px solid #D9CFB6;font:11px/1.4 'JetBrains Mono',ui-monospace,Menlo,monospace;color:#6B6358;text-align:center;z-index:2147483646;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;">Internal</div>`;
  }
  return `<div id="__beam_classification" style="position:sticky;top:0;left:0;right:0;padding:6px 12px;background:#F6E4D6;border-bottom:1px solid #B5482A;font:11px/1.4 'JetBrains Mono',ui-monospace,Menlo,monospace;color:#B5482A;text-align:center;z-index:2147483646;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;">Confidential</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Stream-rewrite an R2 object's HTML body. Materializes in memory because
 * dashboards are small; a transform stream is not worth the complexity here.
 */
export async function injectIntoR2Html(args: {
  obj: R2ObjectBody;
  uuid: string;
  sessionId: string;
  classification?: Classification;
  showFooter: boolean;
  env: Env;
}): Promise<string> {
  const html = await args.obj.text();
  const cfg = getConfig(args.env);
  return injectAll({
    html,
    uuid: args.uuid,
    sessionId: args.sessionId,
    classification: args.classification,
    showFooter: args.showFooter,
    brandName: cfg.brandName,
  });
}
