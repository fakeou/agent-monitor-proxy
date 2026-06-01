#!/bin/bash
# Agent Monitor Proxy — Claude Code Hook Script
#
# This script is called by Claude Code when statistical analysis events occur.
# It forwards the event data to the stats-cli for processing.
#
# Installation:
#   1. Copy this file to ~/.claude/hooks/amp-hook.sh
#   2. Make it executable: chmod +x ~/.claude/hooks/amp-hook.sh
#   3. Configure Claude Code to use this hook
#
# Usage:
#   Claude Code will automatically call this script when needed.
#   You can also call it manually:
#   echo '{"event":"test","data":{}}' | ./amp-hook.sh

set -e

# Read input from stdin
INPUT=$(cat)

# Parse event type
EVENT_TYPE=$(echo "$INPUT" | grep -o '"event":"[^"]*"' | cut -d'"' -f4)

# Log event (optional)
# echo "[$(date)] Received event: $EVENT_TYPE" >> ~/.claude/hooks/amp-hook.log

# Forward to stats-cli
case "$EVENT_TYPE" in
    "descriptive")
        # Extract data and call stats-cli
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli descriptive -f - 2>/dev/null || true
        ;;
    "normality")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli normality -f - 2>/dev/null || true
        ;;
    "capability")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli capability -f - 2>/dev/null || true
        ;;
    "control-chart")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli control-chart imr -f - 2>/dev/null || true
        ;;
    "ttest")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli ttest one_sample -f - 2>/dev/null || true
        ;;
    "anova")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli anova one_way -f - 2>/dev/null || true
        ;;
    "regression")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli regression -f - 2>/dev/null || true
        ;;
    "correlation")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli correlation -f - 2>/dev/null || true
        ;;
    "outlier")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli outlier -f - 2>/dev/null || true
        ;;
    "trend")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli trend -f - 2>/dev/null || true
        ;;
    "doe")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli doe full_factorial -f - 2>/dev/null || true
        ;;
    "report")
        DATA=$(echo "$INPUT" | grep -o '"data":{[^}]*}')
        echo "$DATA" | stats-cli report -f - 2>/dev/null || true
        ;;
    *)
        # Unknown event type
        echo "Unknown event type: $EVENT_TYPE" >&2
        exit 1
        ;;
esac
