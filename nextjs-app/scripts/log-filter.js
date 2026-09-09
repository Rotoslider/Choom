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

// LOCAL time with a UTC offset, matching `journalctl -o short-iso` on the Linux
// side. toISOString() would be simpler but stamps UTC, and the Agent Console
// renders the clock portion — six hours off for a US mountain-time host reads
// as "the log stopped this morning" rather than "these are UTC".
const stamp = () => {
  if (!STAMP) return '';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${p2(Math.floor(abs / 60))}${p2(abs % 60)} `
  );
};

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
