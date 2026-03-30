#!/usr/bin/env node
// Filters noisy polling routes from Next.js dev server output.
// Keeps: LLM logs, tool calls, errors, warnings, TTS, image gen, etc.
// Suppresses: GET/POST for notifications, health, chats, images, logs, memory stats

const SUPPRESS = /^\s*(GET|POST|DELETE) \/api\/(notifications|health|chats|images|logs|chooms)\b|INFO:\s+\d+\.\d+\.\d+\.\d+:\d+ - "GET \/memory\/stats/;

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // keep incomplete last line in buffer
  for (const line of lines) {
    if (!SUPPRESS.test(line)) {
      process.stdout.write(line + '\n');
    }
  }
});
process.stdin.on('end', () => {
  if (buffer && !SUPPRESS.test(buffer)) {
    process.stdout.write(buffer + '\n');
  }
});
