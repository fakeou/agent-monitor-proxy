#!/bin/bash
# Agent Monitor Proxy — Claude Code Hook Bridge
#
# Forwards Claude Code hook payloads to the local AMP server.

set -euo pipefail

AMP_URL="${AMP_URL:-http://127.0.0.1:9527/api/hooks/claude-code}"
PAYLOAD="$(cat)"

curl -sS -X POST "$AMP_URL" \
  -H 'content-type: application/json' \
  --data "$PAYLOAD" >/dev/null
