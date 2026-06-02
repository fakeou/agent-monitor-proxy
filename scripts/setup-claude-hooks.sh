#!/bin/bash
# AMP — Claude Code Hook Installer
#
# Installs the AMP hook bridge into ~/.claude/settings.json.
# Safely merges with existing settings — never overwrites env, model, or other keys.

set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SOURCE="$SCRIPT_DIR/amp-hook.sh"
HOOK_TARGET="$HOOKS_DIR/amp-hook.sh"

echo "==> Installing AMP hook bridge for Claude Code..."

mkdir -p "$HOOKS_DIR"
cp "$HOOK_SOURCE" "$HOOK_TARGET"
chmod +x "$HOOK_TARGET"

python3 - "$SETTINGS_FILE" "$HOOK_TARGET" <<'PY'
import json, sys

settings_path = sys.argv[1]
hook_command = sys.argv[2]

# Read existing settings or start fresh
if settings_path.endswith('.json'):
    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}
else:
    settings = {}

if not isinstance(settings, dict):
    settings = {}

# Events we care about
events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']

# Existing hooks or fresh dict
hooks = settings.get('hooks')
if not isinstance(hooks, dict):
    hooks = {}

for event_name in events:
    groups = hooks.get(event_name)
    if not isinstance(groups, list):
        groups = []

    # Remove any existing AMP hook from this event (dedup)
    cleaned = []
    for group in groups:
        group_hooks = group.get('hooks') if isinstance(group, dict) else None
        if not isinstance(group_hooks, list):
            cleaned.append(group)
            continue
        remaining = [
            h for h in group_hooks
            if not (isinstance(h, dict) and 'amp-hook.sh' in h.get('command', ''))
        ]
        if remaining:
            new_group = dict(group)
            new_group['hooks'] = remaining
            cleaned.append(new_group)

    # Append our hook group
    cleaned.append({
        'hooks': [{
            'type': 'command',
            'command': hook_command,
            'timeout': hook_command.endswith('amp-hook.sh') and 45 or 45,
        }]
    })
    hooks[event_name] = cleaned

settings['hooks'] = hooks

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print(f"Updated {settings_path} ({len(events)} hook events)")
PY

echo ""
echo "Claude Code hooks installed:"
echo "  Hook script : $HOOK_TARGET"
echo "  Settings    : $SETTINGS_FILE"
echo "  Events      : UserPromptSubmit PreToolUse PostToolUse Notification Stop"
echo "  Target      : http://127.0.0.1:9527/api/hooks/claude-code"
