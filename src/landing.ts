/**
 * Internal control plane.
 *
 * Renders a dense, operator-focused table of all dashboards visible to the
 * authenticated user. Each row carries the dashboard's fingerprint glyph,
 * classification badge, owner, visibility controls, share-link countdown,
 * and per-row action buttons. Modals expose the version history and audit
 * log for any dashboard.
 *
 * This file is the only consumer of the visual design system in code form;
 * the share viewer uses a smaller subset (see share.ts).
 */

import type { Env } from "./index";
import { getConfig, isAdmin, isAllowedSsoEmail, tint } from "./config";
import {
  listDashboards,
  isPasswordProtected,
  activeShareStatus,
  DashboardMeta,
  Visibility,
  Classification,
} from "./store";
import { fingerprintSvg } from "./fingerprint";

export async function renderLanding(env: Env, requesterEmail?: string): Promise<Response> {
  const cfg = getConfig(env);
  const dashboards = await listDashboards(env, requesterEmail);
  const userIsAdmin = isAdmin(requesterEmail || null, cfg);
  const ssoOk = !requesterEmail || isAllowedSsoEmail(requesterEmail, cfg);

  if (requesterEmail && !ssoOk) {
    return new Response(
      renderUnauthorized(cfg.brandName, requesterEmail, cfg.brandPrimaryColor),
      { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const html = renderShell({
    brandName: cfg.brandName,
    accent: cfg.brandPrimaryColor,
    accentTint: tint(cfg.brandPrimaryColor, 0.08),
    serveHost: cfg.serveHost,
    publicHost: cfg.publicHost,
    requesterEmail,
    userIsAdmin,
    dashboards,
    defaultShareHours: cfg.defaultShareHours,
    minShareHours: cfg.minShareHours,
    maxShareHours: cfg.maxShareHours,
  });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

interface ShellArgs {
  brandName: string;
  accent: string;
  accentTint: string;
  serveHost: string;
  publicHost: string;
  requesterEmail?: string;
  userIsAdmin: boolean;
  dashboards: DashboardMeta[];
  defaultShareHours: number;
  minShareHours: number;
  maxShareHours: number;
}

function renderShell(a: ShellArgs): string {
  const rows = a.dashboards.map((d) => renderRow(d, a)).join("\n");
  const empty = a.dashboards.length === 0 ? renderEmpty(a.brandName) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(a.brandName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
${renderStyle(a)}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand-block">
      <span class="brand">${escapeHtml(a.brandName)}</span>
      <span class="brand-sub">Self-hosted publishing</span>
    </div>
    <div class="user-block">
      ${a.requesterEmail ? `<span class="user-email">${escapeHtml(a.requesterEmail)}</span>` : ""}
      ${a.userIsAdmin ? `<span class="user-badge">admin</span>` : ""}
    </div>
  </div>
</header>

<main class="main">
  <div class="page-head">
    <div>
      <h1>Dashboards</h1>
      <p class="lead">${a.dashboards.length === 0 ? "No dashboards published yet." : `${a.dashboards.length} ${a.dashboards.length === 1 ? "dashboard" : "dashboards"} visible to you.`}</p>
    </div>
    <div class="page-tools">
      <input id="filterInput" type="text" placeholder="Filter by title, owner, uuid" autocomplete="off" />
    </div>
  </div>

  ${empty}

  <div class="table-wrap" id="tableWrap" ${a.dashboards.length === 0 ? 'style="display:none"' : ""}>
    <table class="table">
      <thead>
        <tr>
          <th class="col-title">Dashboard</th>
          <th class="col-class">Class.</th>
          <th class="col-vis">Visibility</th>
          <th class="col-share">External share</th>
          <th class="col-actions"></th>
        </tr>
      </thead>
      <tbody id="rows">
${rows}
      </tbody>
    </table>
  </div>
</main>

<div id="toast" class="toast" role="status" aria-live="polite"></div>

<dialog id="modal" class="modal">
  <div class="modal-head">
    <h3 id="modalTitle">Modal</h3>
    <button type="button" class="icon-btn" id="modalClose" aria-label="Close">&times;</button>
  </div>
  <div class="modal-body" id="modalBody"></div>
</dialog>

<script>
${renderScript(a)}
</script>
</body>
</html>`;
}

// ---------- styles ----------

function renderStyle(a: ShellArgs): string {
  return `
:root {
  --color-surface: #FFFFFF;
  --color-surface-muted: #F1ECE0;
  --color-surface-subtle: #EBE3D0;
  --color-ink: #1B1A18;
  --color-ink-secondary: #3A3835;
  --color-muted: #6B6358;
  --color-border: #D9CFB6;
  --color-border-subtle: #E0D5BC;
  --color-accent: ${a.accent};
  --color-accent-tint: ${a.accentTint};
  --color-success: #2E7D52;
  --color-success-tint: #E5EFE7;
  --color-warning: #B5482A;
  --color-warning-tint: #F6E4D6;
  --color-danger: #B5482A;
  --color-danger-tint: #F6E4D6;
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

/* topbar */
.topbar {
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.topbar-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand-block { display: flex; align-items: baseline; gap: 16px; }
.brand {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-accent);
}
.brand-sub {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-muted);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.user-block { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--color-muted); }
.user-email { font-family: var(--font-mono); font-size: 12px; color: var(--color-muted); }
.user-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--color-ink);
  color: var(--color-surface-muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 500;
}

/* main */
.main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 32px 24px 80px;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.page-head h1 {
  margin: 0 0 6px;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.lead {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-muted);
  letter-spacing: 0.02em;
}
.page-tools input[type="text"] {
  width: 280px;
  padding: 9px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  font: 13px var(--font-mono);
  color: var(--color-ink);
  outline: none;
}
.page-tools input::placeholder { color: var(--color-muted); letter-spacing: 0.02em; }
.page-tools input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-tint);
}

/* empty state */
.empty {
  margin: 32px 0;
  padding: 48px 24px;
  background: var(--color-surface);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  text-align: center;
}
.empty h2 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
.empty p { margin: 0 auto; max-width: 44ch; font-size: 13px; color: var(--color-muted); line-height: 1.55; }
.empty code {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-surface-subtle);
  padding: 2px 8px;
  border-radius: var(--radius);
  margin-top: 4px;
}

/* table */
.table-wrap {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: visible;
}
.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.table th {
  text-align: left;
  padding: 12px 16px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 500;
  color: var(--color-muted);
  background: transparent;
  border-bottom: 1px solid var(--color-border-subtle);
  white-space: nowrap;
}
.table td {
  padding: 18px 16px;
  font-size: 14px;
  vertical-align: top;
  border-bottom: 1px solid var(--color-border-subtle);
}
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr.row-hidden { display: none; }
.table tbody tr:hover td { background: rgba(217, 207, 182, 0.15); }

.col-title { width: auto; min-width: 280px; }
.col-class { width: 140px; }
.col-vis { width: 160px; }
.col-share { width: 200px; }
.col-actions { width: 320px; padding-right: 16px; }

.cell-title {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.glyph {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--color-surface);
}
.glyph svg { display: block; width: 100%; height: 100%; }
.title-block { min-width: 0; padding-top: 2px; }
.title-link {
  font-size: 18px;
  font-weight: 500;
  color: var(--color-ink);
  text-decoration: none;
  display: inline-block;
  word-break: break-word;
  line-height: 1.3;
}
.title-link:hover { color: var(--color-accent); }
.title-link:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: 2px;
}
.title-link:focus { outline: none; }
.title-meta {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--color-muted);
  font-family: var(--font-mono);
  word-break: break-all;
}
.owner { display: inline-block; margin-top: 2px; font-size: 11.5px; color: var(--color-muted); font-family: var(--font-mono); }

/* badges */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}
.badge-public { color: var(--color-muted); border-color: var(--color-muted); background: transparent; }
.badge-internal { color: var(--color-muted); border-color: var(--color-muted); background: transparent; }
.badge-confidential { color: var(--color-accent); border-color: var(--color-accent); background: transparent; }

/* visibility selector */
.vis-cell { display: flex; flex-direction: column; gap: 4px; }
select.vis {
  appearance: none;
  -webkit-appearance: none;
  padding: 6px 28px 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%236B6358' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>") no-repeat right 10px center;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-ink);
  cursor: pointer;
  letter-spacing: 0.02em;
}
select.vis:hover { border-color: var(--color-ink); }
select.vis:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-tint);
}
input.shared-emails {
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font: 12px var(--font-mono);
  width: 100%;
  outline: none;
}
input.shared-emails:focus {
  border-color: var(--color-accent);
}
.vis-hidden { display: none; }

/* share status */
.share-status { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.share-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  width: fit-content;
  background: transparent;
}
.share-pill.active { color: var(--color-ink); border-color: var(--color-ink); }
.share-pill.expired { color: var(--color-muted); border-color: var(--color-muted); }
.share-pill.permanent { color: var(--color-ink); border-color: var(--color-ink); }
.share-pill.expiring { color: var(--color-accent); border-color: var(--color-accent); }
.dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.countdown { font-family: var(--font-mono); font-size: 11px; color: var(--color-muted); }

/* action buttons */
.actions { display: flex; gap: 6px; flex-wrap: nowrap; align-items: center; justify-content: flex-end; }
.btn {
  appearance: none;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  padding: 7px 11px;
  background: var(--color-surface);
  color: var(--color-ink);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.2;
}
.btn:hover { border-color: var(--color-ink); }
.btn-primary {
  background: var(--color-ink);
  color: var(--color-surface-muted);
  border-color: var(--color-ink);
}
.btn-primary:hover { opacity: 0.9; }
.btn-danger { color: var(--color-accent); border-color: var(--color-accent); }
.btn-danger:hover { background: var(--color-accent-tint); }
.btn-icon-only {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.btn[disabled] { opacity: 0.4; cursor: not-allowed; }

/* more menu */
.more-menu { position: relative; }
.more-menu summary {
  list-style: none;
  display: inline-block;
}
.more-menu summary::-webkit-details-marker { display: none; }
.more-menu summary::marker { display: none; }
.btn-more { user-select: none; }
.more-menu[open] .btn-more { background: var(--color-surface-subtle); border-color: var(--color-ink); }
.more-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  min-width: 200px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 4px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 1px;
  box-shadow: 0 4px 12px rgba(27, 26, 24, 0.10);
}
.btn-menu {
  appearance: none;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  padding: 7px 10px;
  background: transparent;
  color: var(--color-ink);
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-menu:hover { background: var(--color-surface-subtle); }
.btn-menu-danger { color: var(--color-accent); }
.btn-menu-danger:hover { background: var(--color-accent-tint); }
.more-divider { border: 0; border-top: 1px solid var(--color-border-subtle); margin: 4px 0; }

/* toast */
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(100%);
  background: var(--color-ink);
  color: #FFFFFF;
  padding: 10px 16px;
  border-radius: var(--radius);
  font-size: 13px;
  z-index: 100;
  transition: transform 0.18s ease, opacity 0.18s ease;
  opacity: 0;
}
.toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
.toast.error { background: var(--color-danger); }

/* modal */
.modal {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 0;
  width: min(680px, 92vw);
  max-height: 80vh;
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: var(--font-sans);
}
.modal::backdrop { background: rgba(0, 0, 0, 0.45); }
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--color-border);
}
.modal-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.icon-btn {
  appearance: none;
  background: none;
  border: 0;
  font-size: 20px;
  color: var(--color-muted);
  cursor: pointer;
  line-height: 1;
  padding: 4px 8px;
  border-radius: var(--radius);
}
.icon-btn:hover { background: var(--color-surface-subtle); color: var(--color-ink); }
.modal-body { padding: 16px 20px; max-height: calc(80vh - 56px); overflow-y: auto; }

/* modal contents */
.versions-list, .audit-list { list-style: none; margin: 0; padding: 0; }
.versions-list li, .audit-list li {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.versions-list .meta, .audit-list .meta {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-muted);
}
.audit-list li {
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.audit-event {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: space-between;
}
.audit-action {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
}
.audit-detail {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-muted);
  word-break: break-word;
}
.qr-wrap {
  text-align: center;
  padding: 12px;
}
.qr-wrap svg {
  display: block;
  margin: 0 auto 12px;
  width: 220px;
  height: 220px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: #FFFFFF;
}
.qr-wrap .qr-url {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-muted);
  word-break: break-all;
}

/* themed prompt / confirm */
.modal-message {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--color-ink-secondary);
}
.modal-input-row {
  margin: 0 0 20px;
}
.modal-input-row label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--color-muted);
  margin: 0 0 6px;
}
.modal-input-row input {
  width: 100%;
  padding: 9px 12px;
  font: 14px var(--font-sans);
  color: var(--color-ink);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  outline: none;
}
.modal-input-row input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-tint);
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
.modal-actions .btn { font-size: 13px; padding: 8px 14px; }

/* mobile */
@media (max-width: 1080px) {
  .table-wrap { background: transparent; border: 0; overflow: visible; }
  .table { table-layout: auto; }
  .table thead { display: none; }
  .table, .table tbody, .table tr, .table td { display: block; width: 100%; }
  .table tr {
    background: var(--color-surface);
    margin: 0 0 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .table td { border-bottom: 1px solid var(--color-border-subtle); padding: 14px 16px; }
  .table td:first-child { padding: 16px; }
  .table tbody tr:last-child { margin-bottom: 0; }
  .col-title, .col-class, .col-vis, .col-share, .col-actions { width: auto; min-width: 0; padding-right: 16px; }
  .actions { justify-content: flex-start; flex-wrap: wrap; gap: 6px; }
  .actions .btn { flex: 0 1 auto; }
  .more-panel { right: auto; left: 0; }
  .page-tools input[type="text"] { width: 100%; }
  .page-head { flex-direction: column; align-items: stretch; }
  .topbar-inner { flex-wrap: wrap; gap: 12px; }
  .brand-block { gap: 12px; }
  .user-block { font-size: 12px; }
}
`;
}

// ---------- row ----------

function renderRow(d: DashboardMeta, a: ShellArgs): string {
  const v: Visibility = d.visibility || "private";
  const c: Classification = d.classification || "internal";
  const visClass = v === "shared" ? "" : "vis-hidden";
  const sharedEmails = (d.shared_with || []).join(", ");
  const status = activeShareStatus(d);
  const internalUrl = `https://${a.serveHost}/${d.uuid}`;
  const glyph = fingerprintSvg(d.uuid, 32, "#FFFFFF");
  const owner = d.owner_email ? `Owner: ${escapeHtml(d.owner_email)}` : "Owner: unknown";

  let pillClass = "expired";
  let pillText = "Expired";
  let countdownText = "Click rotate to issue a fresh link.";
  if (status.active) {
    if (status.permanent) {
      pillClass = "permanent";
      pillText = "Permanent";
      countdownText = "Never expires until revoked.";
    } else {
      pillClass = "active";
      pillText = "Active";
      countdownText = `Expires ${formatExpiryShort(status.expiresAt as string)}`;
    }
  }

  return `
        <tr class="row" data-uuid="${escapeAttr(d.uuid)}" data-title="${escapeAttr(d.title)}" data-owner="${escapeAttr(d.owner_email || "")}">
          <td class="col-title">
            <div class="cell-title">
              <div class="glyph">${glyph}</div>
              <div class="title-block">
                <a href="${escapeAttr(internalUrl)}" class="title-link" target="_blank" rel="noopener">${escapeHtml(d.title)}</a>
                <div class="title-meta">${escapeHtml(d.uuid)} &middot; v${d.current_version || 1}</div>
                <div class="owner">${owner}</div>
              </div>
            </div>
          </td>
          <td class="col-class">
            <select class="vis class-select" data-uuid="${escapeAttr(d.uuid)}" aria-label="Classification">
              <option value="public" ${c === "public" ? "selected" : ""}>Public</option>
              <option value="internal" ${c === "internal" ? "selected" : ""}>Internal</option>
              <option value="confidential" ${c === "confidential" ? "selected" : ""}>Confidential</option>
            </select>
          </td>
          <td class="col-vis">
            <div class="vis-cell">
              <select class="vis vis-select" data-uuid="${escapeAttr(d.uuid)}" aria-label="Visibility">
                <option value="private" ${v === "private" ? "selected" : ""}>Private</option>
                <option value="shared" ${v === "shared" ? "selected" : ""}>Shared with</option>
                <option value="org" ${v === "org" ? "selected" : ""}>All staff</option>
              </select>
              <input type="text" class="shared-emails ${visClass}" placeholder="alice@company.com, bob@company.com" value="${escapeAttr(sharedEmails)}" data-uuid="${escapeAttr(d.uuid)}" />
            </div>
          </td>
          <td class="col-share">
            <div class="share-status">
              <span class="share-pill ${pillClass}"><span class="dot"></span>${pillText}</span>
              <span class="countdown" data-expires="${escapeAttr(status.expiresAt || "")}">${escapeHtml(countdownText)}</span>
            </div>
          </td>
          <td class="col-actions">
            <div class="actions">
              <button class="btn btn-primary act-rotate" data-uuid="${escapeAttr(d.uuid)}">Rotate link</button>
              <button class="btn act-copy" data-uuid="${escapeAttr(d.uuid)}" title="Copy current share URL">Copy</button>
              <button class="btn act-qr" data-uuid="${escapeAttr(d.uuid)}" title="Show QR">QR</button>
              <details class="more-menu">
                <summary class="btn btn-more" title="More actions">More</summary>
                <div class="more-panel">
                  <button class="btn-menu act-pw" data-uuid="${escapeAttr(d.uuid)}">Regenerate password</button>
                  <button class="btn-menu act-versions" data-uuid="${escapeAttr(d.uuid)}">Version history</button>
                  <button class="btn-menu act-audit" data-uuid="${escapeAttr(d.uuid)}">Audit log</button>
                  ${a.userIsAdmin ? `<button class="btn-menu act-permanent" data-uuid="${escapeAttr(d.uuid)}">Make permanent</button>` : ""}
                  <hr class="more-divider">
                  <button class="btn-menu btn-menu-danger act-revoke" data-uuid="${escapeAttr(d.uuid)}">Revoke share links</button>
                  <button class="btn-menu btn-menu-danger act-delete" data-uuid="${escapeAttr(d.uuid)}">Delete dashboard</button>
                </div>
              </details>
            </div>
          </td>
        </tr>`;
}

function renderEmpty(brandName: string): string {
  return `
  <div class="empty">
    <h2>No dashboards yet</h2>
    <p>Ask Claude to publish a dashboard. It will appear here and you will get an internal URL plus an external share link with a password.</p>
    <p style="margin-top:12px;">Try: <code>publish this as a dashboard called "Q4 metrics"</code></p>
  </div>`;
}

function renderUnauthorized(brandName: string, email: string, accent: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(brandName)}</title><meta name="viewport" content="width=device-width, initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"><style>body{margin:0;padding:80px 24px;font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;background:#F1ECE0;color:#1B1A18}main{max-width:480px;margin:0 auto;padding:40px 32px;background:#FFFFFF;border:1px solid #D9CFB6;border-radius:6px;text-align:center}h1{margin:0 0 12px;font-size:22px;font-weight:600}p{font-size:14px;color:#6B6358;line-height:1.55}code{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;background:#EBE3D0;padding:2px 8px;border-radius:6px;font-size:12px}</style></head><body><main><h1>Domain not allowed</h1><p>Your email <code>${escapeHtml(email)}</code> is not on the allowed SSO domains for ${escapeHtml(brandName)}. Ask an admin to add your domain to <code>ALLOWED_SSO_DOMAINS</code>.</p></main></body></html>`;
}

// ---------- script ----------

function renderScript(a: ShellArgs): string {
  return `
(function() {
  const DEFAULT_HOURS = ${a.defaultShareHours};
  const MIN_HOURS = ${a.minShareHours};
  const MAX_HOURS = ${a.maxShareHours};
  const PUBLIC_HOST = ${JSON.stringify(a.publicHost)};
  const SERVE_HOST = ${JSON.stringify(a.serveHost)};

  const toast = (msg, isError) => {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  };

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  };

  // --- modal helpers ---
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");
  document.getElementById("modalClose").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (e) => {
    const r = modal.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      modal.close();
    }
  });

  function openModal(title, html) {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
  }

  // Themed replacement for window.confirm. Returns Promise<boolean>.
  // Esc, X-button, and backdrop-click all resolve to false.
  function themedConfirm(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        modal.removeEventListener("close", onClose);
        resolve(false);
      };
      modal.addEventListener("close", onClose);

      const dangerClass = opts.danger ? "btn-danger" : "btn-primary";
      openModal(
        opts.title || "Confirm",
        '<p class="modal-message">' + escapeHtml(opts.message) + '</p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" data-modal-cancel>' + escapeHtml(opts.cancelLabel || "Cancel") + '</button>' +
          '<button type="button" class="btn ' + dangerClass + '" data-modal-ok>' + escapeHtml(opts.confirmLabel || "Confirm") + '</button>' +
        '</div>'
      );

      const okBtn = modalBody.querySelector("[data-modal-ok]");
      const cancelBtn = modalBody.querySelector("[data-modal-cancel]");
      cancelBtn.addEventListener("click", () => modal.close());
      okBtn.addEventListener("click", () => {
        if (settled) return;
        settled = true;
        modal.removeEventListener("close", onClose);
        modal.close();
        resolve(true);
      });
      setTimeout(() => okBtn.focus(), 0);
    });
  }

  // Themed replacement for window.prompt. Returns Promise<string|null>.
  // Esc, X-button, and backdrop-click all resolve to null.
  function themedPrompt(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        modal.removeEventListener("close", onClose);
        resolve(null);
      };
      modal.addEventListener("close", onClose);

      const messageHtml = opts.message
        ? '<p class="modal-message">' + escapeHtml(opts.message) + '</p>'
        : '';
      openModal(
        opts.title || "Input",
        messageHtml +
        '<div class="modal-input-row">' +
          '<label for="modal-themed-input">' + escapeHtml(opts.inputLabel || "Value") + '</label>' +
          '<input id="modal-themed-input" type="' + escapeHtml(opts.inputType || "text") + '" value="' + escapeHtml(String(opts.defaultValue || "")) + '" />' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" data-modal-cancel>Cancel</button>' +
          '<button type="button" class="btn btn-primary" data-modal-ok>' + escapeHtml(opts.confirmLabel || "OK") + '</button>' +
        '</div>'
      );

      const input = modalBody.querySelector("#modal-themed-input");
      const okBtn = modalBody.querySelector("[data-modal-ok]");
      const cancelBtn = modalBody.querySelector("[data-modal-cancel]");
      const submit = () => {
        if (settled) return;
        settled = true;
        modal.removeEventListener("close", onClose);
        const v = input.value;
        modal.close();
        resolve(v);
      };
      cancelBtn.addEventListener("click", () => modal.close());
      okBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  // --- more-menu: close on outside click and after any action click ---
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".more-menu[open]").forEach((m) => {
      if (!m.contains(e.target)) m.removeAttribute("open");
    });
  });
  document.querySelectorAll(".more-panel .btn-menu").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const m = e.currentTarget.closest(".more-menu");
      if (m) m.removeAttribute("open");
    });
  });

  // --- countdown ticker ---
  function updateCountdowns() {
    const els = document.querySelectorAll(".countdown[data-expires]");
    const now = Date.now();
    els.forEach((el) => {
      const exp = el.getAttribute("data-expires");
      if (!exp) return;
      const t = new Date(exp).getTime();
      const ms = t - now;
      if (!Number.isFinite(ms) || ms <= 0) {
        el.textContent = "Expired. Click rotate to issue a fresh link.";
        return;
      }
      const totalSec = Math.floor(ms / 1000);
      const days = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      let parts = [];
      if (days) parts.push(days + "d");
      if (hours || days) parts.push(hours + "h");
      parts.push(mins + "m");
      if (!days && !hours) parts.push(secs + "s");
      el.textContent = "Expires in " + parts.join(" ");
    });
  }
  updateCountdowns();
  setInterval(updateCountdowns, 1000);

  // --- filter ---
  document.getElementById("filterInput").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    document.querySelectorAll("tr.row").forEach((row) => {
      if (!q) { row.classList.remove("row-hidden"); return; }
      const t = (row.dataset.title || "").toLowerCase();
      const o = (row.dataset.owner || "").toLowerCase();
      const u = (row.dataset.uuid || "").toLowerCase();
      const match = t.includes(q) || o.includes(q) || u.includes(q);
      row.classList.toggle("row-hidden", !match);
    });
  });

  // --- visibility ---
  document.querySelectorAll("select.vis-select").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const uuid = e.target.dataset.uuid;
      const mode = e.target.value;
      const row = e.target.closest("tr");
      const emailsInput = row.querySelector("input.shared-emails");
      emailsInput.classList.toggle("vis-hidden", mode !== "shared");
      let emails = [];
      if (mode === "shared") {
        emails = (emailsInput.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      }
      try {
        await post("/api/sharing", { uuid, visibility: mode, shared_with: emails });
        toast(mode === "private" ? "Now private." : mode === "org" ? "Visible to all staff." : "Sharing updated.");
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });
  document.querySelectorAll("input.shared-emails").forEach((inp) => {
    inp.addEventListener("blur", async (e) => {
      const uuid = e.target.dataset.uuid;
      const row = e.target.closest("tr");
      const sel = row.querySelector("select.vis-select");
      if (sel.value !== "shared") return;
      const emails = (e.target.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        await post("/api/sharing", { uuid, visibility: "shared", shared_with: emails });
        toast("Shared with " + emails.length + " " + (emails.length === 1 ? "person" : "people") + ".");
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- classification ---
  document.querySelectorAll("select.class-select").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const uuid = e.target.dataset.uuid;
      const cls = e.target.value;
      try {
        await post("/api/classification", { uuid, classification: cls });
        toast("Classification set to " + cls + ".");
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- rotate ---
  document.querySelectorAll(".act-rotate").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      const hoursStr = await themedPrompt({
        title: "Rotate share link",
        message: "Issue a fresh external share URL. Min " + MIN_HOURS + ", default " + DEFAULT_HOURS + ", max " + MAX_HOURS + " hours.",
        inputLabel: "Hours valid",
        inputType: "number",
        defaultValue: String(DEFAULT_HOURS),
        confirmLabel: "Rotate",
      });
      if (hoursStr === null) return;
      const hours = parseInt(hoursStr, 10);
      if (!Number.isFinite(hours)) return toast("Invalid hours.", true);
      try {
        const r = await post("/api/rotate", { uuid, duration_hours: hours });
        await navigator.clipboard.writeText(r.share_url);
        let msg = "Fresh link copied to clipboard.";
        if (r.password) msg += " Password: " + r.password;
        toast(msg);
        // Update the countdown without refreshing the whole page.
        const row = e.currentTarget.closest("tr");
        const cd = row.querySelector(".countdown");
        cd.setAttribute("data-expires", r.expires_at || "");
        const pill = row.querySelector(".share-pill");
        pill.classList.remove("expired", "permanent");
        pill.classList.add("active");
        pill.innerHTML = '<span class="dot"></span>Active';
        updateCountdowns();
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- copy current share URL ---
  document.querySelectorAll(".act-copy").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      try {
        const res = await fetch("/api/current-share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uuid }),
        });
        if (res.status === 404) {
          return toast("No active share link. Click 'Rotate link' to issue one.", true);
        }
        if (!res.ok) {
          let err = "HTTP " + res.status;
          try { const j = await res.json(); err = j.error || err; } catch {}
          return toast("Copy failed: " + err, true);
        }
        const data = await res.json();
        await navigator.clipboard.writeText(data.share_url);
        toast("Share URL copied. The password (if set) is on the publish/rotate notification email.");
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- QR ---
  document.querySelectorAll(".act-qr").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      try {
        const res = await fetch("/api/qr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uuid }),
        });
        if (res.status === 404) return toast("No active share link. Rotate first.", true);
        if (!res.ok) {
          let err = "HTTP " + res.status;
          try { const j = await res.json(); err = j.error || err; } catch {}
          return toast("QR failed: " + err, true);
        }
        const svg = await res.text();
        openModal(
          "Share QR",
          '<div class="qr-wrap">' + svg + '<div class="qr-url">Scan to open the most recent share URL.</div></div>'
        );
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- password ---
  document.querySelectorAll(".act-pw").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      const ok = await themedConfirm({
        title: "Regenerate password",
        message: "Generate a fresh password for this dashboard? The old password becomes invalid immediately.",
        confirmLabel: "Regenerate",
      });
      if (!ok) return;
      try {
        const r = await post("/api/regenerate-password", { uuid });
        await navigator.clipboard.writeText(r.password);
        toast("New password copied: " + r.password);
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- revoke ---
  document.querySelectorAll(".act-revoke").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      const ok = await themedConfirm({
        title: "Revoke share links",
        message: "Invalidate ALL existing share links for this dashboard? Internal access is unaffected.",
        confirmLabel: "Revoke all links",
        danger: true,
      });
      if (!ok) return;
      try {
        await post("/api/revoke", { uuid });
        toast("Share links revoked.");
        const row = e.currentTarget.closest("tr");
        const pill = row.querySelector(".share-pill");
        pill.classList.remove("active", "permanent");
        pill.classList.add("expired");
        pill.innerHTML = '<span class="dot"></span>Expired';
        const cd = row.querySelector(".countdown");
        cd.setAttribute("data-expires", "");
        cd.textContent = "All share links revoked.";
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- permanent (admin) ---
  document.querySelectorAll(".act-permanent").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      const ok = await themedConfirm({
        title: "Make share link permanent",
        message: "Issue a permanent share link for this dashboard? The URL never expires until you revoke it.",
        confirmLabel: "Issue permanent link",
      });
      if (!ok) return;
      try {
        const r = await post("/api/permanent", { uuid });
        await navigator.clipboard.writeText(r.share_url);
        let msg = "Permanent link copied.";
        if (r.password) msg += " Password: " + r.password;
        toast(msg);
        const row = e.currentTarget.closest("tr");
        const pill = row.querySelector(".share-pill");
        pill.classList.remove("active", "expired");
        pill.classList.add("permanent");
        pill.innerHTML = '<span class="dot"></span>Permanent';
        const cd = row.querySelector(".countdown");
        cd.setAttribute("data-expires", "");
        cd.textContent = "Never expires until revoked.";
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- delete ---
  document.querySelectorAll(".act-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      const row = e.currentTarget.closest("tr");
      const title = row.dataset.title || uuid;
      const ok = await themedConfirm({
        title: "Delete dashboard",
        message: 'Permanently delete "' + title + '"? All versions and share links will become invalid. This cannot be undone.',
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await post("/api/delete", { uuid });
        row.remove();
        toast("Deleted.");
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- versions ---
  document.querySelectorAll(".act-versions").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      try {
        const r = await post("/api/list-versions", { uuid });
        const versions = r.versions || [];
        if (versions.length === 0) {
          openModal("Versions", "<p>No versions found.</p>");
          return;
        }
        const list = versions.map((v) => {
          const tag = v.is_current
            ? '<span class="badge badge-internal">Current</span>'
            : '<button class="btn btn-primary" data-revert-uuid="' + uuid + '" data-revert-version="' + v.version + '">Revert to v' + v.version + '</button>';
          return '<li><div><strong>v' + v.version + '</strong> <span class="meta">' + v.size_bytes + ' bytes</span></div><div>' + tag + '</div></li>';
        }).join("");
        openModal("Version history", '<ul class="versions-list">' + list + "</ul>");
        modalBody.querySelectorAll("[data-revert-uuid]").forEach((b) => {
          b.addEventListener("click", async (ev) => {
            const u = ev.currentTarget.getAttribute("data-revert-uuid");
            const v = parseInt(ev.currentTarget.getAttribute("data-revert-version"), 10);
            // Replace the modal contents in-place with a confirm dialog.
            const ok = await themedConfirm({
              title: "Revert dashboard",
              message: "Revert to v" + v + "? The current version will be archived as a new historical version.",
              confirmLabel: "Revert to v" + v,
            });
            if (!ok) return;
            try {
              await post("/api/revert", { uuid: u, version: v });
              toast("Reverted to v" + v + ".");
              modal.close();
              setTimeout(() => location.reload(), 600);
            } catch (err) {
              toast("Failed: " + err.message, true);
            }
          });
        });
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  // --- audit ---
  document.querySelectorAll(".act-audit").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const uuid = e.currentTarget.dataset.uuid;
      try {
        const r = await post("/api/audit", { uuid, limit: 100 });
        const events = r.events || [];
        if (events.length === 0) {
          openModal("Audit log", "<p>No events recorded.</p>");
          return;
        }
        const list = events.map((ev) => {
          const detail = ev.detail ? '<div class="audit-detail">' + escapeHtml(JSON.stringify(ev.detail)) + "</div>" : "";
          return '<li><div class="audit-event"><span class="audit-action">' + escapeHtml(ev.action) + '</span><span class="meta">' + escapeHtml(ev.timestamp) + '</span></div><div class="meta">' + escapeHtml(ev.actor_email || "(no email)") + "</div>" + detail + "</li>";
        }).join("");
        openModal("Audit log", '<ul class="audit-list">' + list + "</ul>");
      } catch (err) {
        toast("Failed: " + err.message, true);
      }
    });
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
})();
`;
}

// ---------- formatting helpers ----------

function formatExpiryShort(iso: string): string {
  if (!iso || iso === "permanent") return "never";
  const d = new Date(iso);
  return d.toUTCString().replace("GMT", "UTC");
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
