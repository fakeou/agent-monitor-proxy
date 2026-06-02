#!/bin/bash
# AMP — Codex Hook Installer
#
# Installs the AMP hook bridge into ~/.codex/hooks.json and enables hooks in ~/.codex/config.toml.

set -euo pipefail

CODEX_DIR="$HOME/.codex"
HOOKS_FILE="$CODEX_DIR/hooks.json"
CONFIG_FILE="$CODEX_DIR/config.toml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SOURCE="$SCRIPT_DIR/amp-hook.sh"
HOOKS_DIR="$CODEX_DIR/hooks"
HOOK_TARGET="$HOOKS_DIR/amp-hook.sh"
HOOK_COMMAND="$HOOK_TARGET --source codex"

echo "==> Installing AMP hook bridge for Codex CLI..."

mkdir -p "$CODEX_DIR" "$HOOKS_DIR"
cp "$HOOK_SOURCE" "$HOOK_TARGET"
chmod +x "$HOOK_TARGET"

# ── Update hooks.json ─────────────────────────────────────────────

python3 - "$HOOKS_FILE" "$HOOK_COMMAND" <<'PY'
import json, sys

hooks_path = sys.argv[1]
hook_command = sys.argv[2]

# Events with optional matcher filter
managed_events = {
    "SessionStart": "startup|resume",
    "UserPromptSubmit": None,
    "PreToolUse": None,
    "PostToolUse": None,
    "Notification": None,
    "Stop": None,
}

try:
    with open(hooks_path) as f:
        root = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    root = {}

if not isinstance(root, dict):
    root = {}

hooks = root.get("hooks")
if not isinstance(hooks, dict):
    hooks = {}

for event_name, matcher in managed_events.items():
    groups = hooks.get(event_name)
    if not isinstance(groups, list):
        groups = []

    # Remove existing AMP hooks for this event
    cleaned = []
    for group in groups:
        group_hooks = group.get("hooks") if isinstance(group, dict) else None
        if not isinstance(group_hooks, list):
            cleaned.append(group)
            continue
        remaining = [
            h for h in group_hooks
            if not (isinstance(h, dict) and "amp-hook.sh" in h.get("command", ""))
        ]
        if remaining:
            next_group = dict(group)
            next_group["hooks"] = remaining
            cleaned.append(next_group)

    # Append our hook
    managed_group = {
        "hooks": [{
            "type": "command",
            "command": hook_command,
            "timeout": 45,
        }]
    }
    if matcher:
        managed_group["matcher"] = matcher
    hooks[event_name] = cleaned + [managed_group]

root["hooks"] = hooks
with open(hooks_path, "w") as f:
    json.dump(root, f, indent=2, sort_keys=True)
    f.write("\n")

print(f"Updated {hooks_path} ({len(managed_events)} hook events)")
PY

# ── Enable hooks feature in config.toml ───────────────────────────

python3 - "$CONFIG_FILE" <<'PY'
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
try:
    contents = config_path.read_text()
except FileNotFoundError:
    contents = ""
lines = contents.splitlines()

feature_index = None
for i, line in enumerate(lines):
    if line.strip() == "[features]":
        feature_index = i
        break

if feature_index is None:
    if lines and lines[-1].strip():
        lines.append("")
    lines.extend(["[features]", "hooks = true"])
else:
    insert_at = feature_index + 1
    hooks_line = None
    for i in range(feature_index + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            break
        if stripped.startswith("hooks"):
            hooks_line = i
            break
        insert_at = i + 1
    if hooks_line is None:
        lines.insert(insert_at, "hooks = true")
    else:
        lines[hooks_line] = "hooks = true"

config_path.write_text("\n".join(lines).rstrip() + "\n")
print(f"Enabled hooks in {config_path}")
PY

echo ""
echo "Codex hooks installed:"
echo "  Hook script : $HOOK_TARGET"
echo "  Hooks file  : $HOOKS_FILE"
echo "  Config file : $CONFIG_FILE"
echo "  Events      : SessionStart UserPromptSubmit PreToolUse PostToolUse Notification Stop"
echo "  Target      : http://127.0.0.1:9527/api/hooks/codex"
