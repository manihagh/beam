# Threat model

This document describes what Beam is designed to defend against, what it isn't, and the reasoning behind specific design choices. It is intended as a self-honest read so adopters can decide whether the system fits their risk tolerance.

## Trust assumptions

Beam trusts:

1. **Cloudflare**, fully. Workers, R2, KV, and Cloudflare Access are all in the trusted compute base. A Cloudflare compromise compromises Beam.
2. **Your SSO identity provider** for staff identity. Whoever Cloudflare Access says is authenticated, the Worker treats as that person.
3. **Your admin list** (`ADMIN_EMAILS`). Admins can issue permanent share links and override owner-only mutations.
4. **Your DNS configuration**. If an attacker can change DNS for any of the three Beam hostnames, they can mount a session-stealing attack against staff.

Beam does not trust:

- **The recipient of a share link.** They may forward the URL, screenshot the content, or attempt to brute-force the password. Mitigations: short-lived tokens, password protection, rate limiting, classification banners visible in screenshots.
- **The publisher's HTML.** The HTML is sandboxed under a same-origin policy in the viewer, served with `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`. The Worker does not parse or evaluate the HTML.
- **The internet at large.** The public share host has no SSO; the share token is the only credential.

## Adversaries

### A1. Random internet stranger

**Capabilities:** Can guess URLs. No insider information.

**What they can do:** Hit the share host with random tokens. Hit the internal host without an Access cookie.

**Defenses:**
- Internal control plane is behind Cloudflare Access; every request without a valid Access JWT is rejected at the edge.
- Share tokens are 28 characters from a 31-symbol alphabet (~140 bits). Brute-force search is infeasible.
- Tokens have KV TTL; expired tokens vanish.

### A2. Recipient of a share link

**Capabilities:** Has the URL and possibly the password.

**What they might do:** Forward the URL to others, attempt to share without sending the password, save the page locally.

**Defenses:**
- Each share URL has an explicit expiry (default 72 hours, max 168). Forwarded URLs become useless after the window.
- Passwords are auto-generated and required by default. Sending only the URL gates the recipient at the password prompt.
- Failed password attempts are rate-limited (5 per IP/dashboard/10 min, 60s lockout).
- The classification banner ("Internal" or "Confidential") is visible at the top of every page view, including in screenshots.
- Revoking shares immediately invalidates all outstanding tokens (generation counter increments; existing tokens fail validation on the next request).

**Not defended:**
- Screenshots. There is no DRM or watermark beyond the classification banner. If the recipient is determined to leak the content, they can.
- Browser-side caching. The Worker sets `Cache-Control: private, no-store`, but a determined adversary can still save the page or print it.

### A3. Departed employee

**Capabilities:** Knows the publishing flow, has historical share links they sent or received, may still have an authenticated session if Access cookies have not expired.

**What they might do:** Use a stale share link they hold from before they left.

**Defenses:**
- `revoke_share_links` invalidates all tokens for a dashboard immediately. Owners and admins can call this. The audit log records who revoked when.
- Cloudflare Access sessions are bound to the SSO IdP; deprovisioning the user in the IdP terminates their session at the next IdP refresh interval (typically minutes to hours).
- The `ADMIN_EMAILS` list is in `wrangler.toml`; admin status is removed by editing the file and re-deploying. Re-deploy is fast; this is not a real-time access removal mechanism.

**Not defended:**
- Cached share-link content. If they downloaded the HTML before leaving, they keep it.
- Screenshots they took before leaving.

### A4. Compromised SSO account

**Capabilities:** Full credentials for one staff member.

**What they can do:** Sign in to the control plane, see every dashboard the compromised user could see, mutate any dashboard the user owns, rotate or revoke share links the user owns.

**Defenses:**
- Every mutation is recorded in the audit log with the actor's email. Forensics can reconstruct what happened.
- `canMutate` enforces ownership. A non-admin compromised account can only mutate dashboards the compromised user owns or is admin over; they cannot delete other people's work.
- Admins can override; if the compromised account is an admin, the blast radius is wider. Treat `ADMIN_EMAILS` as a privileged group and review it regularly.

**Not defended:**
- The IdP itself. If your IdP is compromised, every Access-protected app is at risk, not just Beam.

### A5. Insider with publish access

**Capabilities:** Legitimate staff member who can publish dashboards.

**What they might do:** Publish hostile HTML (cross-site scripting against other staff who view it, phishing forms posing as internal tools, beacon scripts that exfiltrate data).

**Defenses:**
- The viewer serves user-published HTML on a separate hostname (`beam.your-company.com`) that is *not* used for any other authenticated app. A hostile dashboard that exfiltrates Access cookies via JavaScript only gets the Beam Access cookie, not your other apps.
- `X-Frame-Options: SAMEORIGIN` blocks framing in attacker-controlled pages.
- The audit log shows who published what.

**Not defended:**
- A hostile insider IS a real risk and the design partially trusts them. If a publisher has the option to push HTML onto a domain you trust, they have meaningful capability. The classification banner does not prevent malicious code; it labels it.
- Mitigation: do not run Beam on a domain that shares cookies with other authenticated apps. Use a dedicated `beam.your-company.com` (not a subdomain of an app domain).

### A6. Supply-chain attack on this repo

**Capabilities:** Pushes a malicious change to the upstream Beam repo.

**What they could do:** Inject backdoor on next `./deploy.sh` from main.

**Defenses:**
- `./deploy.sh` does not auto-pull from upstream. Adopters control when they pull, and from where.
- The codebase is small enough to review on each upgrade. Five thousand lines, no transitive build-time dependencies executing arbitrary code.
- All runtime dependencies (`qrcode-svg`, `@cloudflare/workers-types`, `wrangler`, `typescript`) are pinned in `package.json`.

**Recommended:** fork the repo and pull updates on your schedule. Review the diff before deploying.

## Specific defenses

### Share-token revocation

Tokens carry a `generation` field; the dashboard's `share_generation` is the current value. `revokeShareLinks` increments it. Existing tokens still exist in KV (with their original generation), but `validateShareToken` rejects any token whose generation is below the dashboard's current value. They expire naturally via KV TTL.

This is faster and simpler than scanning and deleting tokens, and it is consistent: a single KV write atomically revokes any number of outstanding tokens.

### Password challenge cookie binding

Once a recipient submits the correct password, the Worker sets a signed cookie. The HMAC secret combines:

```
MCP_BEARER_TOKEN | password_set_at | share_generation
```

Rotating any of those invalidates all outstanding cookies:
- Calling `regenerate_password` updates `password_set_at`.
- Calling `revoke_share_links` increments `share_generation`.

The cookie's own embedded expiry caps the lifetime at 24h or the remaining token lifetime (whichever is shorter).

### IP truncation in view logs

View records store the truncated IP only:
- IPv4: `/24` (last octet zeroed)
- IPv6: `/64` (first four hextets only)

This gives enough resolution to correlate sessions and rate-limit, while not retaining identifiable per-user IP history.

### Email scope minimization

The Gmail integration uses a single workspace user with `gmail.send` scope only. The refresh token cannot read mail, cannot impersonate other users, and cannot be used for anything except sending. If exfiltrated, the blast radius is "attacker can send mail from the dedicated address". They cannot read your inbox or anyone else's.

## Known limitations

- **Cloudflare Managed OAuth is Beta.** Beam relies on it for MCP authentication on the `mcp-beam.your-company.com` host. Cloudflare may change the surface area before GA. If they do, the README will need a small update; the Worker code does not need to change because it only reads the `Cf-Access-Authenticated-User-Email` header that Cloudflare sets after a successful OAuth handshake. Worst case during a breaking change: connectors fail to authenticate until the docs catch up. The control plane (`beam.your-company.com`) and share host (`share-beam.your-company.com`) do not depend on Managed OAuth and continue to work.
- **Cookie scope.** Cloudflare Access cookies are scoped to the configured Access domain. If you serve Beam under a domain you also use for other Access-protected apps, a cookie compromise on one is a compromise on the other. Use a dedicated subdomain.
- **R2 bucket access.** Anyone with read access to the R2 bucket bypasses the share-token check; they can read the HTML directly. Restrict R2 bucket access in your Cloudflare account to the same group that has Worker deploy access.
- **No content scanning.** Beam does not scan published HTML for malicious code, exfiltration patterns, or PII. The classification banner is a label, not a filter. If you need DLP, add a pre-publish hook in your fork.
- **No multi-region active-active.** Cloudflare Workers are global, but KV writes are eventually consistent globally. Two near-simultaneous writes from different regions to the same `dash:{uuid}` may resolve in either order. For a small Beam deployment this is academic; for high-throughput it would matter.
- **Audit retention.** One year via KV TTL. If you need longer, export the audit log to your SIEM regularly.
- **No session revocation for share-link viewers.** Once a viewer has a valid password cookie, it works until the embedded expiry passes or `password_set_at`/`share_generation` rotates. There is no "force logout this specific viewer" capability.
