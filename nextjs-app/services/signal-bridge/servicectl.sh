#!/bin/bash
# Cross-platform service control for the Signal Bridge.
#
# Linux hosts run it as a systemd system unit (signal-bridge.service); macOS
# runs it as a launchd user agent (com.choom.signal-bridge). The commands are
# spelled completely differently, so wrap them rather than scattering
# `systemctl` through package.json and start.sh.
#
#   ./servicectl.sh {start|stop|restart|status|logs|is-active} [service]
#
# service defaults to "signal-bridge"; "signal-cli-daemon", "ngrok" and "dev"
# also work.

set -uo pipefail

ACTION="${1:-status}"
SERVICE="${2:-signal-bridge}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../../data/logs"

if [ "$(uname -s)" = "Darwin" ]; then
    case "$SERVICE" in
        dev) LABEL="com.choom.dev"; LOG="$LOG_DIR/choom-dev.log" ;;
        *)   LABEL="com.choom.$SERVICE"; LOG="$LOG_DIR/$SERVICE.log" ;;
    esac
    DOMAIN="gui/$(id -u)"

    case "$ACTION" in
        start)     launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$LABEL.plist" ;;
        stop)      launchctl bootout "$DOMAIN/$LABEL" ;;
        restart)   launchctl kickstart -k "$DOMAIN/$LABEL" ;;
        status)    launchctl print "$DOMAIN/$LABEL" 2>&1 | head -20 ;;
        logs)      tail -f "$LOG" ;;
        is-active) launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 &&
                   launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running" ;;
        *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
    esac
else
    case "$SERVICE" in
        dev)
            # The dev server is a *user* unit on Linux; the rest are system units.
            case "$ACTION" in
                start|stop|restart) systemctl --user "$ACTION" choom-dev ;;
                status)             systemctl --user status choom-dev ;;
                logs)               journalctl --user -u choom-dev -f ;;
                is-active)          systemctl --user is-active --quiet choom-dev ;;
                *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
            esac
            ;;
        *)
            case "$ACTION" in
                start|stop|restart) sudo systemctl "$ACTION" "$SERVICE" ;;
                status)             systemctl status "$SERVICE" ;;
                logs)               journalctl -u "$SERVICE" -f ;;
                is-active)          systemctl is-active --quiet "$SERVICE" ;;
                *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
            esac
            ;;
    esac
fi
