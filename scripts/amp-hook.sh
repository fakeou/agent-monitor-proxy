#!/bin/bash
# AMP Hook Bridge — forwards agent hook payloads to the local AMP server.
# Reads JSON from stdin, POSTs to AMP, exits cleanly regardless of outcome.
# Designed to be installed as a Claude Code / Codex hook command.

set -euo pipefail

SOURCE="claude-code"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:-claude-code}"; shift 2 ;;
    --source=*) SOURCE="${1#--source=}"; shift ;;
    *) shift ;;
  esac
done

AMP_URL="${AMP_URL:-http://127.0.0.1:9527/api/hooks/${SOURCE}}"
PAYLOAD="$(cat)"

curl -sS -X POST "$AMP_URL" \
  -H 'content-type: application/json' \
  --data "$PAYLOAD" \
  --max-time 5 \
  >/dev/null 2>&1 || true
