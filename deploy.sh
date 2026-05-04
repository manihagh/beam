#!/usr/bin/env bash
#
# Beam: deployment via wrangler login session.
#
# No long-lived API token is used. Wrangler authenticates via your browser
# (OAuth-style) and the session is tied to your Cloudflare identity.
#
# Usage:
#   ./deploy.sh
#
# One-time prerequisites:
#   1. Copy wrangler.example.toml to wrangler.toml and fill in YOUR_COMPANY,
#      brand color, admin emails, allowed SSO domains.
#   2. Run `npx wrangler login` once to establish a session.
#
# Compatibility: written for POSIX sed (works on macOS BSD sed and GNU sed).
# Do NOT use \s in the regexes; macOS does not support it. Use [[:space:]].

set -euo pipefail

if [ ! -f wrangler.toml ]; then
  echo "ERROR: wrangler.toml not found." >&2
  echo "Run: cp wrangler.example.toml wrangler.toml" >&2
  echo "Then edit wrangler.toml to fill in your domain, brand, and admin emails." >&2
  exit 1
fi

# POSIX-compatible TOML parsing. \s does not work in BSD sed (macOS).
WORKER_NAME=$(grep -E '^name[[:space:]]*=' wrangler.toml | head -1 | sed -E 's/^name[[:space:]]*=[[:space:]]*"([^"]+)".*$/\1/')
R2_BUCKET=$(grep -A2 '^\[\[r2_buckets\]\]' wrangler.toml | grep 'bucket_name' | head -1 | sed -E 's/^.*=[[:space:]]*"([^"]+)".*$/\1/')
KV_NAME="${WORKER_NAME}-meta"

# Sanity-check the parsed values. If TOML parsing failed, fail loud now
# rather than passing garbage to wrangler.
if [ -z "$WORKER_NAME" ] || [ "${WORKER_NAME#*=}" != "$WORKER_NAME" ]; then
  echo "ERROR: could not parse worker name from wrangler.toml." >&2
  echo "Got: '$WORKER_NAME'" >&2
  exit 1
fi
if [ -z "$R2_BUCKET" ] || [ "${R2_BUCKET#*=}" != "$R2_BUCKET" ]; then
  echo "ERROR: could not parse R2 bucket name from wrangler.toml." >&2
  echo "Got: '$R2_BUCKET'" >&2
  exit 1
fi

log() { echo ">> $*"; }

log "Worker name:       $WORKER_NAME"
log "R2 bucket:         $R2_BUCKET"
log "KV namespace:      $KV_NAME"

# 1. Install dependencies
if [ ! -d node_modules ]; then
  log "Installing dependencies..."
  npm install --silent
fi

# 2. Verify wrangler session
if ! npx wrangler whoami >/dev/null 2>&1; then
  log "No active Wrangler session. Opening browser to log in..."
  npx wrangler login
fi

ACCOUNT_INFO=$(npx wrangler whoami 2>&1 || true)
log "Active Cloudflare session:"
echo "$ACCOUNT_INFO" | grep -E "(account|email|You are logged in)" || echo "$ACCOUNT_INFO" | head -5

# 3. Create R2 bucket. Capture stderr so we can distinguish "already exists"
#    from a real error.
log "Creating R2 bucket: $R2_BUCKET"
R2_TMP=$(mktemp)
if npx wrangler r2 bucket create "$R2_BUCKET" >"$R2_TMP" 2>&1; then
  log "  bucket created."
else
  if grep -qiE "already exists|already_exists|10004" "$R2_TMP"; then
    log "  (bucket already exists)"
  else
    echo "ERROR: failed to create R2 bucket '$R2_BUCKET'." >&2
    cat "$R2_TMP" >&2
    rm -f "$R2_TMP"
    exit 1
  fi
fi
rm -f "$R2_TMP"

# 4. KV namespace
log "Creating KV namespace: $KV_NAME"
KV_OUTPUT=$(npx wrangler kv namespace create "$KV_NAME" 2>&1 || true)
KV_ID=$(echo "$KV_OUTPUT" | grep -oE 'id[[:space:]]*=[[:space:]]*"[a-f0-9]+"' | head -1 | sed -E 's/.*"([a-f0-9]+)".*/\1/')

if [ -z "$KV_ID" ]; then
  log "  namespace probably already exists, looking up ID..."
  KV_LIST=$(npx wrangler kv namespace list 2>/dev/null || echo "[]")
  KV_ID=$(echo "$KV_LIST" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for ns in data:
        if ns.get('title') == '$KV_NAME':
            print(ns['id'])
            break
except Exception:
    pass
" 2>/dev/null || true)
fi

if [ -z "$KV_ID" ]; then
  echo "ERROR: could not determine KV namespace ID for $KV_NAME." >&2
  echo "If wrangler.toml already has the ID under [[kv_namespaces]], you can skip this script and run 'npx wrangler deploy' directly." >&2
  exit 1
fi

log "KV namespace ID:   $KV_ID"

# 5. Patch wrangler.toml with the KV ID (only if still the placeholder)
if grep -q "REPLACE_WITH_KV_ID" wrangler.toml; then
  sed -i.bak "s/REPLACE_WITH_KV_ID/$KV_ID/" wrangler.toml
  rm -f wrangler.toml.bak
  log "Wrote KV ID into wrangler.toml"
fi

# 6. Generate or reuse the MCP bearer token (local dev only; prod uses Access).
if [ ! -f .mcp-token ]; then
  openssl rand -hex 32 > .mcp-token
  log "Generated MCP bearer token (for local dev), saved to .mcp-token"
fi
log "Uploading bearer token as Worker secret..."
cat .mcp-token | npx wrangler secret put MCP_BEARER_TOKEN

# 7. Deploy Worker
log "Deploying Worker..."
npx wrangler deploy

# 8. Read configured hostnames for the post-deploy message
SERVE_HOST=$(grep -E '^SERVE_HOST[[:space:]]*=' wrangler.toml | head -1 | sed -E 's/^.*=[[:space:]]*"([^"]+)".*$/\1/')
MCP_HOST=$(grep -E '^MCP_HOST[[:space:]]*=' wrangler.toml | head -1 | sed -E 's/^.*=[[:space:]]*"([^"]+)".*$/\1/')
PUBLIC_HOST=$(grep -E '^PUBLIC_HOST[[:space:]]*=' wrangler.toml | head -1 | sed -E 's/^.*=[[:space:]]*"([^"]+)".*$/\1/')

cat <<EOF

============================================================
  Worker deployed.
============================================================

  Internal control plane:    https://${SERVE_HOST}
  MCP endpoint:              https://${MCP_HOST}/mcp
  Public share host:         https://${PUBLIC_HOST}/{token}

  Three one-time manual steps remain in the Cloudflare dashboard:

  STEP 1: Cloudflare Zero Trust > Access > Applications > Add application
    Create a Self-hosted app for the CONTROL PLANE:
    - Application name: ${WORKER_NAME} control plane
    - Application domain: ${SERVE_HOST}
    - Identity providers: pick one (Google Workspace, Microsoft Entra,
      Okta, GitHub, One-Time PIN for solo testing, etc.)
    - Policy: Allow > Emails ending in > your ALLOWED_SSO_DOMAINS

  STEP 2: Repeat for the MCP host, then enable Managed OAuth on it:
    a. Add a SECOND Self-hosted app:
       - Application name: ${WORKER_NAME} MCP
       - Application domain: ${MCP_HOST}
       - Same identity providers and policy as STEP 1
    b. Open this app's "Additional settings" tab > "OAuth" section.
    c. Toggle Managed OAuth to ON (currently Beta on Cloudflare).
    d. Allow localhost clients: ON
       Allow loopback clients: ON
       Allowed redirect URIs: https://claude.ai/api/mcp/auth_callback
       Grant session duration: Same as session duration
       Access token lifetime: Default
    e. Save.

  Do NOT create an Access application for ${PUBLIC_HOST}. That host is
  intentionally public, gated only by share tokens.

  STEP 3: Claude > Settings > Connectors > Add custom connector
    - Name: ${WORKER_NAME}
    - URL:  https://${MCP_HOST}/mcp
    - Leave OAuth fields empty. Cloudflare's Managed OAuth handles the
      handshake on the connector's first request.

  STEP 4 (recommended): install the publishing skill at claude.ai/customize/skills.
    Click "Add skill", paste the contents of skill/publishing/SKILL.md
    from this repo, save. On Team/Enterprise plans, an admin does this once
    for the whole org. The skill teaches Claude when and how to use Beam.

  Re-run this script any time to redeploy. It is idempotent.

EOF
