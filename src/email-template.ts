/**
 * HTML email templates.
 *
 * Two variants:
 *   - ownerExternalEmail: sent to the dashboard's owner whenever an external
 *     share link is created or rotated. Forward-friendly; recipients can be
 *     forwarded the email and use the link, password, and QR.
 *   - internalSharedEmail: sent to a colleague when they are added to a
 *     dashboard's shared_with list.
 *
 * Brand color and brand name come from config. The header glyph is the
 * dashboard's deterministic fingerprint, not a static logo. QR codes are
 * referenced via <img src="https://.../qr-public?u=..."> rather than inline
 * SVG, because Gmail and many other email clients strip or sanitize inline
 * SVG.
 *
 * Tables, inline styles, no JS. Tested in Apple Mail, Gmail web/mobile,
 * Outlook web. Outlook desktop falls back to system UI fonts.
 */

import type { Config } from "./config";
import { tint } from "./config";
import { fingerprintSvg } from "./fingerprint";
import type { Classification } from "./store";

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function classificationBadge(classification: Classification | undefined): string {
  if (!classification || classification === "internal") {
    return `<span style="display:inline-block;padding:3px 8px;border:1px solid #6B6358;border-radius:4px;background:transparent;color:#6B6358;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;">Internal</span>`;
  }
  if (classification === "public") {
    return `<span style="display:inline-block;padding:3px 8px;border:1px solid #6B6358;border-radius:4px;background:transparent;color:#6B6358;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;">Public</span>`;
  }
  return `<span style="display:inline-block;padding:3px 8px;border:1px solid #B5482A;border-radius:4px;background:transparent;color:#B5482A;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;">Confidential</span>`;
}

interface Wrap {
  preview: string;
  caption: string;
  headline: string;
  bodyInner: string;
  unsubUrl?: string;
  uuid: string;
  cfg: Config;
  classification?: Classification;
}

function emailWrap(w: Wrap): string {
  const accent = w.cfg.brandPrimaryColor;
  const accentTint = tint(accent, 0.08);
  const ink = "#1B1A18";
  const muted = "#6B6358";
  const surface = "#FFFFFF";
  const surfaceMuted = "#F1ECE0";
  const border = "#D9CFB6";

  const unsubBlock = w.unsubUrl
    ? `<a href="${w.unsubUrl}" style="color:${muted};text-decoration:underline;">Stop receiving these notifications</a> &nbsp;&middot;&nbsp; `
    : "";

  const glyph = fingerprintSvg(w.uuid, 44, surface);

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(w.headline)}</title>
<style>
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%}
table{border-collapse:collapse}img{border:0;outline:none;text-decoration:none}a{color:${accent}}
</style></head>
<body style="margin:0;padding:0;background-color:${surfaceMuted};font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;color:${ink};">
<div style="display:none;max-height:0;overflow:hidden;">${escHtml(w.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${surfaceMuted};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:${surface};border:1px solid ${border};border-radius:6px;overflow:hidden;">
<tr><td style="background:${surface};padding:24px 28px;border-bottom:1px solid ${border};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" style="vertical-align:middle;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td valign="middle" style="vertical-align:middle;width:44px;">${glyph}</td>
    <td valign="middle" style="vertical-align:middle;padding-left:12px;font-size:13px;color:${muted};letter-spacing:0.04em;text-transform:uppercase;font-weight:500;">${escHtml(w.cfg.brandName)}</td>
  </tr></table>
</td>
<td align="right" valign="middle" style="vertical-align:middle;">${classificationBadge(w.classification)}</td>
</tr></table></td></tr>
<tr><td style="padding:32px 28px 8px 28px;">
<p style="margin:0 0 6px 0;font-size:13px;color:${muted};letter-spacing:0.02em;">${escHtml(w.caption)}</p>
<h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:600;color:${ink};letter-spacing:-0.01em;">${escHtml(w.headline)}</h1>
</td></tr>
${w.bodyInner}
<tr><td style="background-color:${surfaceMuted};padding:18px 28px;border-top:1px solid ${border};">
<p style="margin:0 0 4px 0;font-size:11px;color:${muted};line-height:1.5;">You are receiving this because you have access to a dashboard published with ${escHtml(w.cfg.brandName)}.</p>
<p style="margin:0;font-size:11px;color:${muted};line-height:1.5;">${unsubBlock}<a href="https://${w.cfg.serveHost}" style="color:${muted};text-decoration:underline;">${escHtml(w.cfg.serveHost)}</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

interface OwnerExternalArgs {
  uuid: string;
  title: string;
  shareUrl: string;
  password?: string;
  expiresAt: string;
  classification?: Classification;
  cfg: Config;
}

export function ownerExternalEmail(a: OwnerExternalArgs): { html: string; text: string } {
  const expires =
    a.expiresAt === "permanent"
      ? "Never expires until you revoke it"
      : `Expires ${new Date(a.expiresAt).toUTCString()}`;
  const qrSrc = `https://${a.cfg.publicHost}/qr-public?u=${encodeURIComponent(a.shareUrl)}`;

  const ink = "#1B1A18";
  const muted = "#6B6358";
  const accent = a.cfg.brandPrimaryColor;
  const accentTint = tint(accent, 0.1);
  const codeBg = "#EBE3D0";
  const border = "#D9CFB6";

  const passwordBlock = a.password
    ? `<p style="margin:0 0 6px 0;font-size:11px;color:${muted};letter-spacing:0.04em;text-transform:uppercase;">Password</p>
<p style="margin:0;font-size:18px;color:${ink};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500;background-color:${accentTint};padding:12px 14px;border-radius:6px;letter-spacing:0.02em;">${escHtml(a.password)}</p>
<p style="margin:8px 0 0 0;font-size:12px;color:${muted};line-height:1.5;">${escHtml(expires)}. Send the password through a different channel than this email if security matters (text, voice, separate message).</p>`
    : `<p style="margin:0 0 6px 0;font-size:11px;color:${muted};letter-spacing:0.04em;text-transform:uppercase;">Status</p>
<p style="margin:0;font-size:14px;color:${ink};background-color:${codeBg};padding:12px 14px;border-radius:6px;">No password set on this share link. ${escHtml(expires)}.</p>`;

  const bodyInner = `
<tr><td style="padding:14px 28px 8px 28px;">
<p style="margin:0;font-size:15px;line-height:1.55;color:${ink};">Your external share link is ready. Forward this email to the people you want to share it with. The link, password, and QR are all below; the password works only with this link.</p>
</td></tr>
<tr><td style="padding:20px 28px 8px 28px;">
<p style="margin:0 0 6px 0;font-size:11px;color:${muted};letter-spacing:0.04em;text-transform:uppercase;">Share link</p>
<p style="margin:0 0 14px 0;font-size:14px;color:${ink};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;background-color:${codeBg};padding:12px 14px;border-radius:6px;">${escHtml(a.shareUrl)}</p>
${passwordBlock}
</td></tr>
<tr><td style="padding:20px 28px 8px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${ink}" style="border-radius:6px;">
<a href="${escHtml(a.shareUrl)}" style="display:inline-block;padding:12px 20px;font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;font-size:14px;font-weight:500;color:#FFFFFF;text-decoration:none;border-radius:6px;letter-spacing:0.01em;">Open share link</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background-color:${border};margin-top:24px;"></div></td></tr>
<tr><td style="padding:24px 28px 8px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="top" style="vertical-align:top;width:200px;padding-right:20px;">
<div style="background-color:#FFFFFF;border:1px solid ${border};border-radius:6px;padding:10px;width:180px;height:180px;text-align:center;"><img src="${qrSrc}" alt="QR code for the share link" width="180" height="180" style="display:block;width:180px;height:180px;border:0;" /></div>
</td>
<td valign="top" style="vertical-align:top;">
<p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:${ink};">Open on a phone</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${muted};">Recipients can scan this code to open the share link. The password is NOT in the QR; send it separately.</p>
</td>
</tr></table>
</td></tr>
<tr><td style="padding:18px 28px 28px 28px;">
<div style="background-color:${codeBg};border-radius:6px;padding:14px 18px;">
<p style="margin:0 0 6px 0;font-size:13px;font-weight:600;color:${ink};">How to share</p>
<p style="margin:0;font-size:12px;line-height:1.6;color:${muted};">Forward this email to anyone you want to share with. They can use the link, the QR, or the open button. To rotate the link or change the password, ask Claude or open <a href="https://${a.cfg.serveHost}" style="color:${accent};">${escHtml(a.cfg.serveHost)}</a>.</p>
</div>
</td></tr>`;

  const html = emailWrap({
    preview: `Your external share link for "${a.title}"`,
    caption: "Ready to forward",
    headline: a.title,
    bodyInner,
    uuid: a.uuid,
    cfg: a.cfg,
    classification: a.classification,
  });
  const text = [
    `Your external share link for "${a.title}" is ready.`,
    ``,
    `Share link: ${a.shareUrl}`,
    a.password ? `Password: ${a.password}` : `(no password set)`,
    expires,
    ``,
    `Forward this email to anyone you want to share with. Send the password through a different channel than the URL itself.`,
    ``,
    `Manage at: https://${a.cfg.serveHost}`,
  ].join("\n");
  return { html, text };
}

interface InternalSharedArgs {
  uuid: string;
  title: string;
  internalUrl: string;
  publisherName: string;
  unsubUrl: string;
  classification?: Classification;
  cfg: Config;
}

export function internalSharedEmail(a: InternalSharedArgs): { html: string; text: string } {
  const ink = "#1B1A18";
  const muted = "#6B6358";
  const codeBg = "#EBE3D0";
  const border = "#D9CFB6";
  const qrSrc = `https://${a.cfg.publicHost}/qr-public?u=${encodeURIComponent(a.internalUrl)}`;

  const bodyInner = `
<tr><td style="padding:14px 28px 24px 28px;">
<p style="margin:0;font-size:15px;line-height:1.55;color:${ink};">You now have internal access to this dashboard. Open it any time using your SSO. The dashboard stays available until ${escHtml(a.publisherName)} changes its visibility.</p>
</td></tr>
<tr><td style="padding:0 28px 28px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${ink}" style="border-radius:6px;">
<a href="${escHtml(a.internalUrl)}" style="display:inline-block;padding:12px 20px;font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;font-size:14px;font-weight:500;color:#FFFFFF;text-decoration:none;border-radius:6px;letter-spacing:0.01em;">Open dashboard</a>
</td></tr></table>
<p style="margin:14px 0 0 0;font-size:12px;color:${muted};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;">${escHtml(a.internalUrl)}</p>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background-color:${border};"></div></td></tr>
<tr><td style="padding:24px 28px 28px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="top" style="vertical-align:top;width:200px;padding-right:20px;">
<div style="background-color:#FFFFFF;border:1px solid ${border};border-radius:6px;padding:10px;width:180px;height:180px;text-align:center;"><img src="${qrSrc}" alt="QR code for this dashboard" width="180" height="180" style="display:block;width:180px;height:180px;border:0;" /></div>
</td>
<td valign="top" style="vertical-align:top;">
<p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:${ink};">Open on your phone</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${muted};">Scan with your phone camera to open this dashboard. You will be asked to sign in.</p>
</td>
</tr></table>
</td></tr>
<tr><td style="padding:0 28px 28px 28px;">
<div style="background-color:${codeBg};border-radius:6px;padding:14px 18px;">
<p style="margin:0;font-size:12px;line-height:1.55;color:${muted};">This dashboard is internal. It is visible only to people the publisher has granted access to, authenticated through your SSO. Verify any claims before sharing externally.</p>
</div>
</td></tr>`;

  const html = emailWrap({
    preview: `${a.publisherName} shared "${a.title}" with you`,
    caption: `${a.publisherName} shared a dashboard with you`,
    headline: a.title,
    bodyInner,
    unsubUrl: a.unsubUrl,
    uuid: a.uuid,
    cfg: a.cfg,
    classification: a.classification,
  });
  const text = [
    `${a.publisherName} shared "${a.title}" with you.`,
    ``,
    `Open: ${a.internalUrl}`,
    ``,
    `You can open this on a phone with the QR code in the HTML version, or sign in with your SSO at the link above.`,
    ``,
    `Stop receiving these notifications: ${a.unsubUrl}`,
  ].join("\n");
  return { html, text };
}

/**
 * Convert an email like "alice.smith@company.com" or "ed@company.com" into a
 * best-guess display name. Falls back to the email itself for weird shapes.
 */
export function deriveDisplayName(email: string): string {
  const local = email.split("@")[0] || email;
  if (!local) return email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return email;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}
