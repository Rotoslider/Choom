#!/usr/bin/env python3
"""Drive one real Choom turn through the running dev server, the way the Signal
bridge does, and report what happened (tool calls, tokens, trace fields).

  choomrun.py --choom Genesis --model qwen/qwen3.8-27b --fresh --heartbeat \
      --message "..." --label baseline-qwen

Models: a local LM Studio id (provider _local) or 'deepseek' (OpenRouter).
"""
import argparse, glob, json, os, sys, time, urllib.request

import pathlib
ROOT = str(pathlib.Path(__file__).resolve().parents[2])  # nextjs-app
BASE = 'http://localhost:3000'
DEEPSEEK = ('deepseek/deepseek-v4-flash-0731', 'openrouter_1785276850272')

def http(method, path, body=None, stream=False, timeout=1800):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    resp = urllib.request.urlopen(req, timeout=timeout)
    return resp if stream else json.loads(resp.read().decode())

def shared_settings():
    cfg = json.load(open(f'{ROOT}/services/signal-bridge/bridge-config.json'))
    llm = cfg.get('llm', {})
    s = {
        'llm': {
            'endpoint': llm.get('endpoint', 'http://localhost:1234/v1'),
            'model': llm.get('model', ''),
            'temperature': 0.7, 'maxTokens': 4096,
            'simpleTasksModel': llm.get('simpleTasksModel'),
            'simpleTasksProviderId': llm.get('simpleTasksProviderId'),
            'simpleTasksEnabled': llm.get('simpleTasksEnabled', False),
            'compressToolOutputs': llm.get('compressToolOutputs', False),
            'contextLength': llm.get('contextLength', 262144),
        },
        'memory': {'endpoint': cfg.get('memory', {}).get('endpoint', 'http://localhost:8000')},
    }
    for k in ('weather', 'search', 'imageGen', 'vision', 'providers', 'modelProfiles', 'visionProfiles', 'homeAssistant'):
        if cfg.get(k) is not None:
            s[k] = cfg[k]
    return s

def find_choom(name):
    for c in http('GET', '/api/chooms'):
        if c['name'].lower() == name.lower():
            return c
    sys.exit(f'no choom named {name}')

def find_or_create_chat(choom_id, title):
    for c in http('GET', f'/api/chats?choomId={choom_id}'):
        if c.get('title') == title:
            return c['id']
    return http('POST', '/api/chats', {'choomId': choom_id, 'title': title})['id']

def newest_trace(chat_id, after_ts):
    files = [f for f in glob.glob(f'{ROOT}/data/traces/*/chat-{chat_id}-*.json') if os.path.getmtime(f) >= after_ts - 2]
    return max(files, key=os.path.getmtime) if files else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--choom', default='Genesis')
    ap.add_argument('--model', required=True)
    ap.add_argument('--message', required=True)
    ap.add_argument('--chat-title', default='[Test] Phase 1')
    ap.add_argument('--fresh', action='store_true')
    ap.add_argument('--heartbeat', action='store_true')
    ap.add_argument('--max-iterations', type=int)
    ap.add_argument('--label', default='run')
    ap.add_argument('--out', default=None, help='append JSON summary line to this file')
    ap.add_argument('--context', type=int, default=None, help='override settings.llm.contextLength (forces compaction on a local model)')
    ap.add_argument('--exposure', choices=['full','skills'], default=None, help='override tool exposure for this run')
    ap.add_argument('--ha-exposed-only', action='store_true', help='set homeAssistant.assistExposedOnly for this run')
    a = ap.parse_args()

    choom = find_choom(a.choom)
    chat_id = find_or_create_chat(choom['id'], a.chat_title)
    if a.model == 'deepseek':
        override = {'model': DEEPSEEK[0], 'provider_id': DEEPSEEK[1]}
    else:
        override = {'model': a.model, 'provider_id': '_local', 'endpoint': 'http://localhost:1234/v1'}
    payload = {
        'choomId': choom['id'], 'chatId': chat_id, 'message': a.message,
        'settings': shared_settings(), 'suppressNotifications': True,
        'taskModelOverride': override,
    }
    if a.context: payload['settings']['llm']['contextLength'] = a.context
    if a.exposure: payload['settings']['llm']['toolExposure'] = a.exposure
    if a.ha_exposed_only: payload['settings'].setdefault('homeAssistant', {})['assistExposedOnly'] = True
    if a.fresh: payload['freshContext'] = True
    if a.heartbeat: payload['isHeartbeat'] = True
    if a.max_iterations: payload['maxIterationsOverride'] = a.max_iterations

    print(f'▶ {a.label}: {a.choom} on {override["model"]} chat={chat_id}', flush=True)
    t0 = time.time()
    tool_calls, tool_results, content, done, err, status_msgs = [], [], [], None, None, []
    first_token = None
    try:
        resp = http('POST', '/api/chat', payload, stream=True)
        for raw in resp:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data:'): continue
            try: ev = json.loads(line[5:].strip())
            except Exception: continue
            t = ev.get('type')
            if t == 'content':
                if first_token is None: first_token = time.time() - t0
                content.append(ev.get('content', ''))
            elif t == 'tool_call':
                tc = ev['toolCall']; tool_calls.append(tc['name'])
                print(f'  🔧 {tc["name"]}({json.dumps(tc.get("arguments", {}))[:90]})', flush=True)
            elif t == 'tool_result':
                tr = ev['toolResult']; size = len(json.dumps(tr.get('result'))) if tr.get('result') is not None else 0
                tool_results.append((tr['name'], size, bool(tr.get('error'))))
                print(f'     ↳ {tr["name"]}: {size:,} chars{" ERROR: " + str(tr.get("error"))[:80] if tr.get("error") else ""}', flush=True)
            elif t == 'status':
                status_msgs.append(ev.get('content')); print(f'  ℹ️  {ev.get("content")}', flush=True)
            elif t == 'agent_iteration':
                print(f'  🔄 iteration {ev.get("iteration")}/{ev.get("maxIterations")}', flush=True)
            elif t == 'done':
                done = ev
            elif t == 'error':
                err = ev.get('error'); print(f'  ❌ {err}', flush=True)
    except Exception as e:
        err = f'transport: {e}'; print(f'  ❌ {err}', flush=True)
    elapsed = time.time() - t0
    text = ''.join(content)
    # Buffered iteration text is delivered in the done event, not as content events.
    if done and done.get('content') and len(done['content']) > len(text): text = done['content']
    print(f'  💬 {text[:400]}{"…" if len(text) > 400 else ""}')
    time.sleep(1.5)
    tf = newest_trace(chat_id, t0)
    tr = json.load(open(tf)) if tf else {}
    summary = {
        'label': a.label, 'choom': a.choom, 'model': override['model'], 'elapsed_s': round(elapsed, 1),
        'first_token_s': round(first_token, 1) if first_token else None,
        'iterations': tr.get('iterations', done.get('iteration') if done else None),
        'status': tr.get('status', done.get('status') if done else 'error'),
        'maxPromptTokens': tr.get('maxPromptTokens'), 'promptTokens': tr.get('promptTokens'),
        'completionTokens': tr.get('completionTokens'),
        'toolCallCount': len(tool_calls), 'tools': tool_calls,
        'toolResultChars': sum(s for _, s, _ in tool_results),
        'toolFailures': tr.get('toolFailureCount', sum(1 for _, _, e in tool_results if e)),
        'nudgeTypes': tr.get('nudgeTypes'), 'fallbackActivated': tr.get('fallbackActivated'),
        'fallbackModel': tr.get('fallbackModel'), 'resolvedModel': done.get('resolvedModel') if done else None,
        'responseChars': len(text), 'error': err, 'trace': os.path.basename(tf) if tf else None,
    }
    print('  📊 ' + json.dumps({k: v for k, v in summary.items() if k not in ('tools', 'label', 'choom')}), flush=True)
    if a.out:
        with open(a.out, 'a') as f: f.write(json.dumps(summary) + '\n')

if __name__ == '__main__':
    main()
