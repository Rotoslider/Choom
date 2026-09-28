"""Loading and judging benchmark cases (see cases.json)."""
import json
import re
from datetime import datetime
from pathlib import Path

CASES = Path(__file__).with_name("cases.json")


def load_cases():
    cases = json.loads(CASES.read_text())["cases"]
    for c in cases:
        c["_topic"] = re.compile(c["topic"], re.I)
        c["_truth"] = re.compile(c["truth"], re.I)
        c["_stale"] = re.compile(c["stale"], re.I) if c.get("stale") else None
    return cases


def probes(cases):
    for c in cases:
        for p in c["probes"]:
            yield c, p, datetime.fromisoformat(p["as_of"].replace("Z", "+00:00")).timestamp()


def judge(case, text: str) -> str:
    """'truth', 'stale' or '' for one retrieved item."""
    if not case["_topic"].search(text):
        return ""
    if case["_truth"].search(text):
        return "truth"
    if case["_stale"] and case["_stale"].search(text):
        return "stale"
    return ""
