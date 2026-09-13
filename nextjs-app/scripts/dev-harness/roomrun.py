#!/usr/bin/env python3
"""Drive a real group room through the dev server and report every speaker's
turn: tool calls, passes, errors, timing, and the round structure.

  roomrun.py create --title "[Test] room" --chooms Genesis Aloy
  roomrun.py say --room <id> --message "..." [--rounds 2]
  roomrun.py continue --room <id> --rounds 1
  roomrun.py delete --room <id>
"""
import argparse, json, sys, time, urllib.request
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from choomrun import http, shared_settings, find_choom

def create(a):
    parts = [{'choomId': find_choom(n)['id'], 'order': i} for i, n in enumerate(a.chooms)]
    room = http('POST', '/api/group-chats', {'title': a.title, 'participants': parts, 'autoRounds': a.auto_rounds})
    print('room', room['id'], room.get('title'))
    return room['id']

def run(a, body, label):
    t0 = time.time(); speakers = {}; cur = None; events = []
    try:
        resp = http('POST', '/api/group-chat', body, stream=True)
    except urllib.error.HTTPError as e:
        print(f'  💥 HTTP {e.code}: {e.read().decode()[:200]}', flush=True)
        return
    for raw in resp:
        line = raw.decode('utf-8', 'replace').strip()
        if not line.startswith('data:'): continue
        try: ev = json.loads(line[5:].strip())
        except Exception: continue
        t = ev.get('type'); events.append(t)
        if t == 'speaker_start':
            cur = ev['speakerName']; speakers[cur] = {'content': '', 'tools': [], 'errors': [], 'start': time.time(), 'turn': speakers.get(cur, {}).get('turn', 0) + 1}
            print(f'  ▶ {cur} speaking', flush=True)
        elif t == 'speaker_content' and cur:
            speakers[cur]['content'] += ev.get('content', '')
        elif t == 'speaker_tool_call' and cur:
            name = ev.get('name') or ev.get('toolCall', {}).get('name'); speakers[cur]['tools'].append(name); print(f'     🔧 {cur}: {name}', flush=True)
        elif t == 'speaker_tool_result' and cur:
            err = ev.get('error') or ev.get('toolResult', {}).get('error')
            if err: speakers[cur]['errors'].append(str(err)[:120]); print(f'     ❌ {cur}: {ev.get("name")}: {str(err)[:100]}', flush=True)
        elif t == 'speaker_image' and cur:
            print(f'     🖼️  {cur} shared an image', flush=True)
        elif t == 'speaker_done' and cur:
            d = speakers[cur]; d['secs'] = round(time.time() - d['start'], 1)
            c = ev.get('content') or d['content']
            print(f'  ✅ {cur} ({d["secs"]}s, {len(c)} chars): {c[:220].replace(chr(10), " ")}{"…" if len(c) > 220 else ""}', flush=True)
        elif t == 'speaker_error':
            print(f'  💥 {ev.get("speakerName")}: {ev.get("error")}', flush=True)
        elif t == 'passed':
            print(f'  ⏭️  {ev.get("speakerName")} passed', flush=True)
        elif t == 'round_complete':
            print(f'  — round {ev.get("round")} complete', flush=True)
        elif t == 'error':
            print(f'  💥 room error: {ev.get("error")}', flush=True)
        elif t == 'done':
            print(f'  ✔ done in {round(time.time() - t0, 1)}s', flush=True)
    print('  events:', {e: events.count(e) for e in sorted(set(events))})
    if a.out:
        with open(a.out, 'a') as f: f.write(json.dumps({'label': label, 'elapsed_s': round(time.time() - t0, 1), 'speakers': speakers, 'events': events}) + '\n')

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('create'); c.add_argument('--title', default='[Test] room'); c.add_argument('--chooms', nargs='+', required=True); c.add_argument('--auto-rounds', type=int, default=1)
    s = sub.add_parser('say'); s.add_argument('--room', required=True); s.add_argument('--message', required=True); s.add_argument('--rounds', type=int); s.add_argument('--out'); s.add_argument('--label', default='say')
    k = sub.add_parser('continue'); k.add_argument('--room', required=True); k.add_argument('--rounds', type=int, default=1); k.add_argument('--out'); k.add_argument('--label', default='continue')
    d = sub.add_parser('delete'); d.add_argument('--room', required=True)
    r = sub.add_parser('read'); r.add_argument('--room', required=True)
    a = ap.parse_args()
    if a.cmd == 'create': create(a)
    elif a.cmd == 'say':
        body = {'roomId': a.room, 'message': a.message, 'settings': shared_settings()}
        if a.rounds is not None: body['rounds'] = a.rounds
        run(a, body, a.label)
    elif a.cmd == 'continue':
        run(a, {'roomId': a.room, 'continue': True, 'rounds': a.rounds, 'settings': shared_settings()}, a.label)
    elif a.cmd == 'delete':
        print(http('DELETE', f'/api/group-chats/{a.room}'))
    elif a.cmd == 'read':
        import subprocess
        out = subprocess.run(['sqlite3', '-json', str(pathlib.Path(__file__).resolve().parents[2] / 'prisma' / 'dev.db'),
            f"select authorName, content, toolCalls from GroupMessage where roomId='{a.room}' order by createdAt;"], capture_output=True, text=True).stdout
        msgs = json.loads(out) if out.strip() else []
        print(f'{len(msgs)} messages')
        for m in msgs[-40:]:
            print(f'[{m.get("authorName")}] {str(m.get("content"))[:220].replace(chr(10), " ")}')

if __name__ == '__main__':
    main()
