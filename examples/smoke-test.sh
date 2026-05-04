#!/usr/bin/env bash
#
# Smoke test for a local Beam dev server.
#
# Usage:
#   1. Start the dev server: npm run dev
#   2. In another shell: ./examples/smoke-test.sh
#
# This exercises the full lifecycle: list tools, publish, list dashboards,
# rotate share, set classification, list versions, get audit log, delete.

set -euo pipefail

BASE="${BEAM_BASE:-http://localhost:8787}"
TOKEN="${BEAM_TOKEN:-dev-test-token}"

mcp() {
  local id="$1"
  local body="$2"
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,$body}"
}

echo ">> tools/list"
mcp 1 '"method":"tools/list"' | jq '.result.tools | length'

HTML=$(cat examples/sample-dashboard.html | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))")

echo ">> publish_dashboard"
PUBLISH=$(mcp 2 "\"method\":\"tools/call\",\"params\":{\"name\":\"publish_dashboard\",\"arguments\":{\"html\":$HTML,\"title\":\"Smoke test dashboard\",\"share_duration_hours\":1,\"classification\":\"internal\"}}")
echo "$PUBLISH" | jq -r '.result.content[0].text'
UUID=$(echo "$PUBLISH" | jq -r '.result.content[0].text' | grep -oE '/[a-z0-9]{10}' | head -1 | tr -d '/')
echo "Captured uuid: $UUID"

echo ">> list_dashboards"
mcp 3 '"method":"tools/call","params":{"name":"list_dashboards","arguments":{}}' | jq -r '.result.content[0].text' | head -10

echo ">> rotate_share_link"
mcp 4 "\"method\":\"tools/call\",\"params\":{\"name\":\"rotate_share_link\",\"arguments\":{\"uuid\":\"$UUID\",\"share_duration_hours\":24}}" | jq -r '.result.content[0].text'

echo ">> set_classification confidential"
mcp 5 "\"method\":\"tools/call\",\"params\":{\"name\":\"set_classification\",\"arguments\":{\"uuid\":\"$UUID\",\"classification\":\"confidential\"}}" | jq -r '.result.content[0].text'

echo ">> update_dashboard"
NEWHTML=$(echo "<html><body><h1>Updated content</h1></body></html>" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))")
mcp 6 "\"method\":\"tools/call\",\"params\":{\"name\":\"update_dashboard\",\"arguments\":{\"uuid\":\"$UUID\",\"html\":$NEWHTML}}" | jq -r '.result.content[0].text'

echo ">> list_versions"
mcp 7 "\"method\":\"tools/call\",\"params\":{\"name\":\"list_versions\",\"arguments\":{\"uuid\":\"$UUID\"}}" | jq -r '.result.content[0].text'

echo ">> get_audit_log"
mcp 8 "\"method\":\"tools/call\",\"params\":{\"name\":\"get_audit_log\",\"arguments\":{\"uuid\":\"$UUID\",\"limit\":20}}" | jq -r '.result.content[0].text' | head -10

echo ">> delete_dashboard"
mcp 9 "\"method\":\"tools/call\",\"params\":{\"name\":\"delete_dashboard\",\"arguments\":{\"uuid\":\"$UUID\"}}" | jq -r '.result.content[0].text'

echo ""
echo "Smoke test complete."
