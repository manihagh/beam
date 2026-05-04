---
name: publishing
description: Use this skill when the user asks to publish, share, deploy, or host an HTML output as a dashboard or web page, or to manage previously-published dashboards. Triggers on phrases like "publish this dashboard", "share this externally", "give me a link", "rotate the share link", "revoke external access", "list my dashboards", "update that dashboard", "make this confidential", "show me the audit log", "revert to the previous version", or any mention of the configured publishing host. Covers an MCP connector named after the configured BRAND_NAME with eleven tools that publish HTML to an internal SSO-protected URL and an external token-protected share URL on the company's own domain. The skill explains tool selection, share-duration heuristics, classification choices, visibility modes, version control, and the audit trail.
---

# Publishing skill

The publishing service lets anyone in the org turn an HTML output from a Claude chat into a hosted page. Internal staff manage and view dashboards behind SSO. External recipients view via a time-limited share URL that includes a password. The system is exposed to Claude as an MCP connector with eleven tools.

This skill covers tool selection, parameter heuristics, and the response shape you should give the user. It does not cover deployment; that lives in the project README.

## Tools

- `publish_dashboard(html, title, share_duration_hours?, classification?)` Publishes a new dashboard. Returns the internal URL (SSO-protected, no expiry), the external share URL (expires by default in 72 hours), and an auto-generated password for the external URL.
- `update_dashboard(uuid, html)` Replaces the HTML of an existing dashboard. The previous version is archived. Internal URL and active share links continue to work and serve the new content.
- `list_dashboards()` Lists dashboards visible to the requesting user (their own, plus shared, plus org-wide).
- `delete_dashboard(uuid)` Permanently deletes a dashboard. Irreversible. Internal URL and all share links become invalid.
- `rotate_share_link(uuid, share_duration_hours?)` Issues a fresh external share URL. Existing password carries over; if there was none, a fresh one is generated. Old share links continue to work until they expire naturally.
- `revoke_share_links(uuid)` Invalidates ALL existing share links for a dashboard immediately. Internal URL is unaffected.
- `set_visibility(uuid, mode, emails?)` Sets internal visibility. Mode is `"private"`, `"shared"`, or `"org"`. When `"shared"`, emails is the list of email addresses to grant access to.
- `regenerate_password(uuid)` Generates a fresh password without rotating the URL. Use when the old password was sent to the wrong recipient.
- `set_classification(uuid, classification)` Sets the classification banner injected at the top of the dashboard. Values are `"public"` (no banner), `"internal"` (default, grey banner), `"confidential"` (red banner).
- `list_versions(uuid)` Lists historical versions of a dashboard, newest first. The current version is included with `is_current: true`.
- `revert_dashboard(uuid, version)` Reverts the dashboard's HTML to a prior version. The current version is archived as a new historical version (revert is itself reversible). Internal URL and share links continue to work.
- `get_audit_log(uuid, limit?)` Reads recent audit events for a dashboard. Each event records the action, actor email, timestamp, and details. Retention is one year.

## Default response shape after publish

When you call `publish_dashboard`, return the response in this exact shape so users learn to expect it:

> Published "[title]"
>
> Internal (private to you, no expiry): https://[serve-host]/{uuid}
>
> External share (expires [duration]): https://[public-host]/{token}
>
> Password: word-word-word-NN
>
> Classification: internal (default)
>
> The dashboard is private to you. To grant internal access to specific colleagues or the whole org, ask me to share it (or open the control plane). Send the password through a different channel than the URL itself (text, voice, separate email).

If the user asks for a confidential publish or specifies a classification, surface the classification value at publish time rather than forcing them to use `set_classification` afterwards.

## Heuristics for share_duration_hours

Translate the user's intent. Default is 72 hours (3 days). Min is 1, max is 168 (1 week).

- "for the meeting tomorrow" → 24
- "for the rest of the week" → 168
- "for a quick demo" → 1
- "for the next few days" → 72
- "for a presentation next Tuesday" → calculate
- No mention of duration → use the default

If the user asks for "permanent" or "no expiry", do NOT silently issue a long link. Tell them: "External links through me cap at 168 hours (1 week). For a permanent link, an admin can click 'Make permanent' in the control plane. That is admin-only by design." Do not call any tool to circumvent this. The admin-only path exists in the control plane UI on purpose.

## Heuristics for classification

The classification banner is injected at the top of the dashboard on every page view. Use this to choose:

- `"public"`: no banner. Use only when the user explicitly says the content is for general external distribution (a marketing landing page, a public report). If unsure, do NOT pick public.
- `"internal"` (default): a small grey "Internal" banner. Use for typical company dashboards even when there is an external share link. Most dashboards should be internal.
- `"confidential"`: a red "Confidential" banner. Use when the user mentions sensitivity, restricted audience, board material, financials, salary data, security findings, or words like "sensitive", "do not forward", "restricted".

When in doubt between internal and confidential, ask the user once: "Is this material confidential or general internal?" Do not guess. The banner choice is recorded in the audit log; the visible default of "internal" is the right safe default for most cases.

## Heuristics for visibility

Visibility controls who can see the dashboard at the *internal* URL behind SSO.

- `"private"` (default at publish time): only the publisher can see it on the control plane.
- `"shared"`: the publisher plus a list of specific emails can see it.
- `"org"`: any authenticated staff member with SSO can see it.

Rules:

1. If the user named individuals but did not give email addresses, ASK for them BEFORE publishing or BEFORE setting visibility. Do NOT publish first and ask after; do NOT guess from naming patterns. Phrasing: "What is Alice's and Bob's email at company.com?" Reasonable user replies: short alias ("alice@company.com") or full ("alice.smith@company.com").

2. Pass full email addresses to `set_visibility`. If the user gives only first names, do not invent the suffix; ask.

3. If the user says "share with everyone at the company" or similar, call `set_visibility(uuid, "org", [])`.

4. **Important:** internal visibility does NOT auto-expire. If the user says "share with X for 3 days", tell them: "Internal access stays until you change it. I can revoke it whenever you ask, or you can flip it back to private from the control plane." Then either accept the implicit "share without expiry" or ask if they want a calendar reminder.

## Versions and revert

Each `update_dashboard` call archives the previous version. `list_versions` returns them newest first; `revert_dashboard` restores one and archives the current as a new historical version (revert is reversible).

Use cases that should trigger you to call `list_versions`:

- "what was the previous version"
- "show me the history"
- "go back to last week's version"
- "did this change recently"

Use cases that should trigger you to call `revert_dashboard`:

- "revert to the previous version"
- "roll this back"
- "undo my last update"

Always call `list_versions` first and confirm the version number with the user before calling `revert_dashboard`. Do not pick a version number without confirmation.

## Audit log

Use `get_audit_log` when the user asks "who did X" or "when did Y change". The log records every mutating action with the actor's email and a timestamp.

Examples:

- "Who shared this with the auditors?" → `get_audit_log(uuid)`, search for `set_visibility` events.
- "When was this published?" → first `publish` event.
- "Did anyone change the classification?" → look for `set_classification` events.
- "Who deleted the link?" → look for `revoke_share` events.

The log retention is one year. Older events are pruned automatically.

## HTML constraints

When you generate the HTML to publish, follow these constraints. They are not optional; they affect whether the dashboard works in the viewer.

- A single self-contained HTML file. No external assets except scripts from common CDNs (jsdelivr, unpkg, cdnjs).
- Inline CSS and inline JS. No `<link>` to a separate stylesheet on a non-CDN host.
- Always include `<meta name="viewport" content="width=device-width, initial-scale=1">` for mobile compatibility.
- Avoid `localStorage` and `sessionStorage`. The viewer does not block them, but the artifact may be opened in unusual contexts where they fail.
- Avoid `top.location` or `parent.location` references; the viewer sets X-Frame-Options to SAMEORIGIN, so iframe embeds break by default anyway.
- The classification banner and the privacy footer are injected at serve time. Do not try to render your own classification or your own footer; they will be replaced.
- Keep the file under 5 MB for KV TTL math and viewer responsiveness. For larger payloads, ask the user to host elsewhere and link to it.

## Common phrasings the user will use

- "publish this as a dashboard called X" → `publish_dashboard(html, X)`
- "share it with alice@company.com and bob@company.com" → after publish, `set_visibility(uuid, "shared", [...])`
- "let everyone at the company see it" → `set_visibility(uuid, "org", [])`
- "give me a fresh link" → `rotate_share_link(uuid)`
- "kill the link" / "make the link invalid" → `revoke_share_links(uuid)`
- "regenerate the password" → `regenerate_password(uuid)`
- "mark this as confidential" / "this is sensitive" → `set_classification(uuid, "confidential")`
- "revert to the previous version" → `list_versions(uuid)` first, then confirm, then `revert_dashboard(uuid, version)`
- "who has seen this" → not directly answerable through MCP (views are in the control plane UI). Tell the user to open the control plane.
- "who did X" → `get_audit_log(uuid)`

## Hard rules

- Do NOT publish a dashboard without a title. If the user does not give one, infer a reasonable one and confirm it in your response.
- Do NOT silently extend share durations beyond 168 hours.
- Do NOT call `delete_dashboard` without an explicit "delete" verb from the user. "Take it down" or "remove it" should first prompt: "Do you mean revoke the share link (still keeps the dashboard internally) or permanently delete the dashboard?"
- Do NOT change classification or visibility on a dashboard the user did not explicitly reference. If they say "share this", clarify *which* this if there are multiple in scope.
- Do NOT include real email addresses you have not been given. When in doubt, ask.
