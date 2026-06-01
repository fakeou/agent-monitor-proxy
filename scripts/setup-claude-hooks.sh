#!/bin/bash
# Agent Monitor Proxy — Claude Code Hook Setup
#
# This script configures Claude Code to send events to AMP.
#
# Usage:
#   ./scripts/setup-claude-hooks.sh
#
# What it does:
#   1. Creates ~/.claude/hooks/ directory
#   2. Copies amp-hook.sh to ~/.claude/hooks/
#   3. Makes it executable
#   4. Updates ~/.claude/settings.json to configure hooks
#
# After running this, Claude Code will automatically send events to AMP.

set -e

CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SOURCE="$SCRIPT_DIR/amp-hook.sh"
HOOK_TARGET="$HOOKS_DIR/amp-hook.sh"
AMP_URL="${AMP_URL:-http://127.0.0.1:9527/api/hooks/claude-code}"

# 1. Create hooks directory
mkdir -p "$HOOKS_DIR"

# 2. Copy and make executable
cp "$HOOK_SOURCE" "$HOOK_TARGET"
chmod +x "$HOOK_TARGET"

# 3. Update settings.json
if [ -f "$SETTINGS_FILE" ]; then
    # Merge with existing settings
    python3 -c "
import json
import sys

with open('$SETTINGS_FILE', 'r') as f:
    settings = json.load(f)

# Add hook configuration
if 'hooks' not in settings:
    settings['hooks'] = {}

hook_config = [
    {
        'type': 'command',
        'command': '$HOOK_TARGET'
    }
]

settings['hooks']['PreToolUse'] = hook_config
settings['hooks']['PostToolUse'] = hook_config
settings['hooks']['Notification'] = hook_config
settings['hooks']['Stop'] = hook_config
settings['hooks']['SubagentStop'] = hook_config

with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)

print('Updated settings.json with hook configuration')
"
else
    # Create new settings file
    cat > "$SETTINGS_FILE" << EOF
{
    "hooks": {
        "PreToolUse": [
            {
                "type": "command",
                "command": "$HOOK_TARGET"
            }
        ],
        "PostToolUse": [
            {
                "type": "command",
                "command": "$HOOK_TARGET"
            }
        ],
        "Notification": [
            {
                "type": "command",
                "command": "$HOOK_TARGET"
            }
        ],
        "Stop": [
            {
                "type": "command",
                "command": "$HOOK_TARGET"
            }
        ],
        "SubagentStop": [
            {
                "type": "command",
                "command": "$HOOK_TARGET"
            }
        ]
    }
}
EOF
    echo "Created settings.json with hook configuration"
fi

echo ""
echo "✅ Claude Code hooks configured!"
echo ""
echo "Hook script: $HOOK_TARGET"
echo "Settings: $SETTINGS_FILE"
echo ""
echo "Claude Code will now send events to AMP when:"
echo "  - PreToolUse: Before using a tool"
echo "  - PostToolUse: After using a tool"
echo "  - Notification: When a notification occurs"
echo "  - Stop: When the session stops"
echo "  - SubagentStop: When a subagent stops"
echo "Forward target: $AMP_URL"
