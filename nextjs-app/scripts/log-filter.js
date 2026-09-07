#!/usr/bin/env node
// Filters noisy polling routes from Next.js dev server output.
// Keeps: LLM logs, tool calls, errors, warnings, TTS, image gen, etc.
// Suppresses: GET/POST for notifications, health, chats, images, logs, memory stats

const SUPPRESS = /^\s*(GET|POST|DELETE) \/api\/(notifications|health|chats|images|logs|chooms|token-usage|settings\/defaults)\b|^\s*GET \/(usage)\b|INFO:\s+\d+\.\d+\.\d+\.\d+:\d+ - "GET \/memory\/stats/;

// On Linux the dev server runs under systemd and the journal supplies each
// line's timestamp. macOS launchd just redirects stdout to a plain file, so
// there is nothing to supply one — set CHOOM_LOG_TIMESTAMPS=1 there and we
// prefix an ISO timestamp ourselves. /api/server-log parses both shapes.
const STAMP = process.env.CHOOM_LOG_TIMESTAMPS === '1';
const stamp = () => (STAMP ? new Date().toISOString() + ' ' : '');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // keep incomplete last line in buffer
  for (const line of lines) {
    if (!SUPPRESS.test(line)) {
      process.stdout.write(stamp() + line + '\n');
    }
  }
});
process.stdin.on('end', () => {
  if (buffer && !SUPPRESS.test(buffer)) {
    process.stdout.write(stamp() + buffer + '\n');
  }
});
