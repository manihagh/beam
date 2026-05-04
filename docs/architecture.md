# Architecture

Beam is one Cloudflare Worker that serves three custom domains plus the local-dev path-based routes. State lives in R2 (HTML payloads) and KV (metadata, tokens, audit log, view log).

## Components

```
                                 Claude (the AI)
                                       |
                                       | MCP JSON-RPC
                                       v
                +--------------------------------------+
                |   mcp-beam.YOUR_COMPANY.com          |
                |   (Cloudflare Access protected)      |
                |   handleMcp() in src/mcp.ts          |
                +-----------------+--------------------+
                                  |
                                  v
                +--------------------------------------+
                |   src/store.ts                       |
                |   - R2: dashboard HTML + versions    |
                |   - KV: meta, tokens, audit, views   |
                +-----+----------------+---------------+
                      ^                ^
                      |                |
       +--------------+----+    +------+--------------------+
       | beam.YOUR_COMPANY |    | share-beam.YOUR_COMPANY   |
       | (Access protected)|    | (public, token-gated)     |
       | handleServe       |    | handleShare               |
       | renderLanding     |    | renderPasswordPrompt      |
       | handleApi         |    | renderError               |
       +-------------------+    +---------------------------+
              ^                              ^
              |                              |
            staff                       external recipients
       (your SSO IdP)                   (no account needed)
```

## Hostnames and routing

| Host | Auth | Purpose |
|------|------|---------|
| `mcp-beam.YOUR_COMPANY.com` | Cloudflare Access | MCP JSON-RPC endpoint Claude calls |
| `beam.YOUR_COMPANY.com` | Cloudflare Access | Internal control plane UI + `/api/*` |
| `share-beam.YOUR_COMPANY.com` | None (token-gated) | Public viewer for share links |

Routing happens in `src/index.ts`. The Worker matches on `URL.hostname` first, then path. In local dev, Wrangler rewrites all three hostnames onto `localhost:8787` and the same routing collapses to path-based.

## Storage layout

### R2

```
{uuid}/index.html            current HTML
{uuid}/versions/{n}.html     historical version n
                             (kept up to DASHBOARD_VERSIONS_KEPT, default 10)
```

### KV

```
dash:{uuid}                  DashboardMeta (see below)
tok:{token}                  TokenRecord with TTL = share duration
view:{uuid}:{ts}:{rand}      ViewRecord (90-day TTL)
audit:{uuid}:{ts}:{rand}     AuditEvent (1-year TTL)
pwfail:{uuid}:{ipKey}        password rate-limit (10-min TTL)
nomail:{email}               unsubscribe marker (no TTL)
email_dedup:{uuid}:{email}   transactional email dedup (5-min TTL)
email_metric:{day}:{kind}    daily counters (90-day TTL)
```

`DashboardMeta` shape (TypeScript):

```ts
interface DashboardMeta {
  uuid: string;
  title: string;
  created_at: string;
  updated_at: string;
  size_bytes: number;
  share_generation: number;       // bumped on revoke; older tokens fail
  owner_email?: string;
  latest_share_expires_at?: string | null;
  latest_share_generation?: number;
  visibility?: "private" | "shared" | "org";
  shared_with?: string[];
  password_hash?: string;
  password_salt?: string;
  password_set_at?: string;
  classification?: "public" | "internal" | "confidential";
  current_version?: number;
  total_versions?: number;
}
```

## Request flows

### Publishing

```
User types "publish this" in Claude
        |
Claude calls publish_dashboard via MCP
        |
mcp.ts handleMcp -> auth check (Access or bearer)
        |
store.ts publishDashboard:
  1. Generate uuid (10-char safe alphabet)
  2. Write {uuid}/index.html to R2
  3. Build DashboardMeta with classification: "internal" by default
  4. Generate password (3 wordlist words + 2 digits)
  5. PBKDF2-hash password, store hash + salt
  6. Issue first share token with KV TTL
  7. Write dash:{uuid} to KV
  8. Append audit:{uuid}:{ts}:{rand} event
        |
mcp.ts formats response with internal URL, share URL, password
        |
ctx.waitUntil(emailOwnerOnExternalShare) sends owner an email if Gmail configured
        |
Response returns to Claude, which shows the URLs to the user.
```

### Internal serving

```
Staff opens https://beam.YOUR_COMPANY.com/{uuid}
        |
Cloudflare Access challenges (SSO) if not yet authenticated
        |
Worker handleServe:
  1. Validate uuid format
  2. Read DashboardMeta from KV
  3. canView() check: owner / admin / shared_with / org
  4. Read {uuid}/index.html from R2
  5. recordInitialView (KV write with 90-day TTL)
  6. injectAll(): classification banner + footer + beacon
  7. Return HTML with cache-control: private, no-store
```

### External serving

```
Recipient opens https://share-beam.YOUR_COMPANY.com/{token}
        |
Worker handleShare:
  1. Look up tok:{token} in KV (TTL handled by KV)
  2. Verify generation matches dashboard's current share_generation
  3. If password-protected:
     - Read beam_share cookie if present
     - Verify HMAC (secret = bearer + password_set_at + share_generation)
     - If invalid, render password prompt or accept POST submission
     - Rate-limit failed attempts: 5 per 10 min, 60s lockout
  4. Read {uuid}/index.html from R2
  5. recordInitialView with via=share
  6. injectAll() with classification banner + footer + beacon
  7. Return HTML with security headers
```

### Revoke

```
Owner clicks Revoke (or asks Claude to revoke)
        |
api.ts /api/revoke (or mcp.ts revoke_share_links):
  1. canMutate() check (owner or admin)
  2. Increment share_generation on DashboardMeta
  3. Audit event recorded
        |
All existing tok:{token} entries still exist in KV but their
recorded generation is now < dashboard's generation, so
validateShareToken() rejects them. They expire naturally via TTL.
```

## Security boundaries

- **Cloudflare Access** is the primary gate for the internal control plane and the MCP host. Every authenticated request reaches the Worker with `Cf-Access-Authenticated-User-Email` set.
- **Cloudflare Managed OAuth** (Beta) sits on top of the MCP-host Access app. It exposes RFC 8707-compliant OAuth endpoints that Claude's MCP custom connector negotiates with on first use; on success, Cloudflare issues an access token bound to the user's SSO identity, and that token authenticates each subsequent MCP request.
- **`ALLOWED_SSO_DOMAINS`** is a defense-in-depth check: even if the Access policy is misconfigured to allow a wider set, the Worker rejects emails outside the configured domains.
- **Bearer token** at `MCP_BEARER_TOKEN` is local dev only. In production, requests reaching the MCP host without a valid Access-issued token are rejected.
- **Share tokens** are 28 characters from a 31-symbol safe alphabet, ~140 bits of entropy.
- **Password hashing** uses PBKDF2-HMAC-SHA256 with 100,000 iterations.
- **Password challenge cookie** is HMAC-signed; the secret rotates whenever the password changes or shares are revoked, invalidating outstanding cookies.
- **Rate limiting** on password attempts: 5 per IP/uuid/10min, 60s lockout.

## OAuth handshake (MCP host)

When a user adds Beam as a custom connector in Claude and uses it for the first time:

1. Claude POSTs to `https://mcp-beam.YOUR_COMPANY.com/mcp`. Cloudflare Access intercepts because there is no token yet, and replies with `WWW-Authenticate: Bearer realm=...` plus a `resource_metadata` URL pointing to Cloudflare's discovery document.
2. Claude's connector follows the discovery document to find the authorization and token endpoints (hosted by Cloudflare Managed OAuth, not by your Worker).
3. Claude opens an OAuth authorize URL in the user's browser. Cloudflare runs the configured SSO challenge (Google, OTP, etc.) and, on success, redirects back to `https://claude.ai/api/mcp/auth_callback` with an authorization code.
4. Claude exchanges the code for an access token at Cloudflare's token endpoint.
5. Claude POSTs to `/mcp` again, this time with `Authorization: Bearer <token>`. Cloudflare validates the token, sets `Cf-Access-Authenticated-User-Email`, and proxies to the Worker.
6. The Worker checks the email against `ALLOWED_SSO_DOMAINS` and proceeds.

The Worker itself does **not** implement OAuth. Cloudflare's Managed OAuth provides the OAuth surface; the Worker just consumes the trusted email header. This means there is no OAuth secret to rotate, no client credentials to leak, and no token store to maintain on Beam's side.

For full threat-model coverage, see [threat-model.md](threat-model.md).

## Why this shape

The architecture is deliberately small. One Worker, one R2 bucket, one KV namespace, no external services. Reasons:

1. **Cost.** Three Cloudflare resources on the free tier costs nothing.
2. **Operational simplicity.** Re-running `./deploy.sh` is the entire upgrade path. No build pipeline, no container orchestrator.
3. **Auditability.** A reader can understand the whole system from the source in a single sitting (~5,000 lines of TypeScript).
4. **Deployment portability.** The same code runs locally via `wrangler dev`, on any Cloudflare account via deploy, and tests do not require infrastructure mocks.

If your usage outgrows this shape (multi-region active-active, more than the KV write rate, etc.), Beam is the wrong tool. Move to a real backend.
