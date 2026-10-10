#!/bin/bash
# Relaunch the hologram page only when no Choom is mid-turn (her mood idle, nothing queued to say),
# so a rebuild never cuts her off. Waits up to 10 minutes; exit 1 if she was busy all that time.
H="$(cd "$(dirname "$0")/.." && pwd)"
for i in $(seq 1 300); do
  st=$(grep '"kind": "status"' "$H/telemetry.log" 2>/dev/null | tail -1)
  if [[ -z "$st" ]] || { echo "$st" | grep -q '"mood": "idle"' && echo "$st" | grep -q '"queued": 0'; }; then
    cd "$H" && ./launch.sh living >/dev/null 2>&1
    for j in $(seq 1 20); do curl -s -m 2 127.0.0.1:8765/status | grep -q '"page": "living"' && break; sleep 1; done
    echo "relaunched"; exit 0
  fi
  sleep 2
done
echo "still busy after 10 min; not relaunched"; exit 1
