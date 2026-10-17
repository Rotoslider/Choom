#!/bin/bash
# Started at login by ~/.config/autostart/choom-hologram.desktop: brings the glass up once the Portrait is
# connected at 1536x2048, trying every 10 s for up to 10 minutes (after a boot the Portrait can come up
# late, and launch.sh gives up at once without it). Does nothing when the glass is already running, so
# running it by hand is harmless. Appends to autostart.log beside launch.sh.
H="$(cd "$(dirname "$0")/.." && pwd -P)"
exec >> "$H/autostart.log" 2>&1
echo "== $(date '+%F %T') autostart"
if pgrep -f -- "$H/server.py" > /dev/null; then
  echo "the glass is already running; nothing to do"
  exit 0
fi
for try in $(seq 1 60); do
  if xrandr --query 2>/dev/null | grep " connected" | grep -q "1536x2048+"; then
    if "$H/launch.sh" living; then
      echo "launched (try $try)"
      exit 0
    fi
  fi
  sleep 10
done
echo "gave up after 10 minutes: no Portrait running at 1536x2048"
exit 1
