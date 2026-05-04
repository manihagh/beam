# Security policy

This document describes the security posture of Beam, what it protects against by default, and what is out of scope. It does not solicit vulnerability reports; this is a self-hosted project that you operate on your own infrastructure.

## Scope

In scope:

- The Worker source under `src/`.
- The deploy script and its handling of secrets.
- The MCP server, its auth checks, and its tool surface.
- The share-token generation, expiry, and revocation logic.
- The internal control plane API.
- The skill prompt content under `skill/`.

Out of scope:

- Vulnerabilities in upstream dependencies (Cloudflare Workers runtime, Wrangler,
  the JSON-RPC parser). Report those upstream.
- Issues that depend on an attacker already having admin access to your
  Cloudflare account, your Claude organization, or your SSO provider.
- Findings that require disabling Cloudflare Access or running a local dev
  build with a leaked bearer token.

## Self-hosted responsibility

Beam is intended to be deployed onto **your own** Cloudflare account. Once
deployed, you operate it. That means:

- You are responsible for keeping the deployment patched. Re-run `./deploy.sh`
  whenever a new release is tagged in this repo.
- You are responsible for your Cloudflare Access policies, your SSO
  configuration, and your `ADMIN_EMAILS` list. A misconfigured Access policy
  will let unauthorized users into the internal control plane regardless of
  what this codebase does.
- You are responsible for the content your users publish through Beam. The
  HTML viewer sandboxes published content with CSP headers, but the system
  is not designed to defend against fully malicious operators publishing
  hostile pages from inside your Claude org.
- You are responsible for your share-link distribution practices. Beam emits
  URL + password and tells you to send them via different channels; whether
  you do is up to you.

## Defaults that already protect you

The codebase ships with these properties on by default:

- Share tokens expire automatically via KV TTL. The default expiry is 72 hours.
- Revoking a share link invalidates all currently-valid tokens for that
  dashboard immediately, via a generation counter.
- The MCP host requires Cloudflare Access in production. The bearer token is
  a defense-in-depth fallback for local dev.
- The control plane host requires Cloudflare Access. The Worker additionally
  re-checks the SSO email's domain against `ALLOWED_SSO_DOMAINS`.
- The public share host has no SSO. Each path is a token; the token is the
  capability. Tokens are 192 bits of entropy.
- Audit events are recorded for every publish, update, share-rotate,
  share-revoke, visibility-change, and delete. They are exposed read-only
  to dashboard owners and to admins.

## Known limitations

- The Worker stores HTML in R2. Anyone with read access to your R2 bucket
  bypasses the share-token check. Restrict R2 bucket access in your
  Cloudflare account accordingly.
- Cloudflare Access cookies are scoped to the configured Access domain. If
  you serve Beam under a domain you also use for other Access-protected apps,
  a session compromise on one is a session compromise on the other.
- Email sends pass through whatever SMTP / Gmail API account you configure.
  The system never sends email if the credentials are missing; it does not
  warn the user. If you depend on the email notifications, monitor them.
