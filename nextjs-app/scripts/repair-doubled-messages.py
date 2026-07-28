#!/usr/bin/env python3
"""One-off repair for C-43 damage: three assistant messages in the Genesis
chat carry a leaked '</think>' tag, two of them with the entire reply
doubled (the tag defeated exact-match dedup, so both copies were saved).
Doubled content in the context window teaches the model to keep repeating.

Idempotent and self-verifying: backs up the originals, hash-diffs the whole
Message table afterwards, and aborts if anything besides the three target
rows would change. Run from nextjs-app/:  python3 scripts/repair-doubled-messages.py
"""
import hashlib
import json
import os
import re
import sqlite3
import sys

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
db = sqlite3.connect('prisma/dev.db')

TARGETS = [
    'cmrwzkvop049bxhutzjtm15ru',  # 2026-07-23, </think> residue only
    'cms3huzhz00lwmbt138bboe3x',  # 2026-07-27, doubled + residue
    'cms4p4kzh00424ux443kr3l6z',  # 2026-07-28, doubled + residue (the reported one)
]
BACKUP = 'data/message_backups/pre-dedup-repair-20260728.json'


def all_hashes():
    return {r[0]: hashlib.sha256((r[1] or '').encode()).hexdigest()
            for r in db.execute('SELECT id, content FROM Message').fetchall()}


def repair(text: str) -> str:
    t = re.sub(r'</?think>', '', text)
    probe = t.strip()[:60]
    second = t.find(probe, len(probe))
    if second > len(t) * 0.3:  # split point plausibly near the middle
        first, rest = t[:second], t[second:]
        norm = lambda s: re.sub(r'\s+', ' ', s).strip()
        if norm(first) == norm(rest):
            t = first
    return t.rstrip()


before = all_hashes()
backup = {}
for mid in TARGETS:
    row = db.execute('SELECT content FROM Message WHERE id=?', (mid,)).fetchone()
    if row is None:
        sys.exit(f'ABORT: message {mid} not found — DB does not match expectations')
    backup[mid] = row[0]

already = [m for m in TARGETS if '</think>' not in backup[m]]
if len(already) == len(TARGETS):
    print('Nothing to do — all three messages already repaired.')
    sys.exit(0)

os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
if not os.path.exists(BACKUP):
    json.dump(backup, open(BACKUP, 'w'), indent=1)
    print(f'Originals backed up to {BACKUP}')

for mid in TARGETS:
    fixed = repair(backup[mid])
    print(f'{mid}: {len(backup[mid])} -> {len(fixed)} chars')
    db.execute('UPDATE Message SET content=? WHERE id=?', (fixed, mid))
db.commit()

after = all_hashes()
changed = sorted(k for k in before if before[k] != after.get(k))
assert set(changed) <= set(TARGETS), f'UNEXPECTED ROWS CHANGED: {changed}'
for mid in TARGETS:
    (c,) = db.execute('SELECT content FROM Message WHERE id=?', (mid,)).fetchone()
    assert '</think>' not in c
print(f'Repaired {len(changed)} rows; hash-diff confirms no other row changed.')
