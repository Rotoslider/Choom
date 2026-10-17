#!/bin/bash
# Relaunch the hologram page only when no Choom is mid-turn (her mood idle, nothing queued to say) and no
# conversation at the tower is under way (it waits through his reply window too), so a rebuild never cuts
# anyone off. Waits up to 10 minutes. Exit codes:
#   0  relaunched: the new page reported in
#   1  still busy after 10 minutes; not relaunched
#   2  the launch failed: launch.sh failed (no Portrait at 1536x2048, say) or no new page within 40 s
H="$(cd "$(dirname "$0")/.." && pwd -P)"  # the real folder (see launch.sh)
status() { curl -s -m 3 127.0.0.1:8765/status; }
quiet() {  # 0 when nothing would be cut off (no server answering counts as quiet)
  status | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
s = d.get("status") or {}
busy = s.get("mood") not in (None, "idle") or (s.get("queued") or 0) > 0 or (d.get("tower_conversation") or {}).get("open")
sys.exit(1 if busy else 0)'
}
started() {  # when the running page started ("" before one reports in)
  status | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin).get("start") or {}).get("time", ""))
except Exception:
    print("")'
}
for _ in $(seq 1 300); do
  if quiet; then
    before=$(started)
    if ! (cd "$H" && ./launch.sh living > /dev/null 2>&1); then
      echo "launch failed (see launch.sh living)"; exit 2
    fi
    for _ in $(seq 1 40); do
      now=$(started)
      if [[ -n "$now" && "$now" != "$before" ]]; then echo "relaunched"; exit 0; fi
      sleep 1
    done
    echo "launch failed: no new page reported in within 40 s"; exit 2
  fi
  sleep 2
done
echo "still busy after 10 min; not relaunched"; exit 1
