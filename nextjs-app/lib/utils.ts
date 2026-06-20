import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ============================================================================
// Class name utility
// ============================================================================

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ============================================================================
// String utilities
// ============================================================================

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// Date/Time utilities
// ============================================================================

export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return then.toLocaleDateString();
}

export function formatDateTime(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatTime(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Like formatTime, but prefixed with zero-padded month-day (e.g. "06-17 3:21 PM").
// Used on chat transcripts (1:1 + group rooms) where the date matters across days.
export function formatDayTime(date: Date | string): string {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${month}-${day} ${time}`;
}

// ============================================================================
// ID generation
// ============================================================================

export function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// ============================================================================
// Async utilities
// ============================================================================

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await delay(delayMs * attempt);
      }
    }
  }

  throw lastError;
}

// ============================================================================
// URL utilities
// ============================================================================

export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

export function ensureEndpoint(base: string, path: string): string {
  const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
  const pathUrl = path.startsWith('/') ? path : '/' + path;
  return baseUrl + pathUrl;
}

// ============================================================================
// Text processing utilities
// ============================================================================

// Detect sentence boundaries for TTS streaming
export function isSentenceEnd(text: string): boolean {
  return /[.!?\n]$/.test(text.trim());
}

// Split text into sentences
export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Spell clock times as words so chatterbox doesn't read "6:26 AM" as a number
// ("six thousand twenty-six"). "6:26 AM" → "six twenty six AM",
// "6:00 AM" → "six o'clock AM", "6:05 AM" → "six oh five AM".
const TTS_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TTS_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
function twoDigitWords(n: number): string {
  if (n < 20) return TTS_ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o === 0 ? TTS_TENS[t] : `${TTS_TENS[t]} ${TTS_ONES[o]}`;
}
export function normalizeTimesForSpeech(text: string): string {
  // HH:MM with optional AM/PM. Lookarounds reject mid-number / HH:MM:SS so ratios,
  // scores, and second-precision timestamps are left alone.
  return (text || '').replace(
    /(?<![\d:])(\d{1,2}):([0-5]\d)(?:\s*([ap]\.?\s?m\.?))?(?![\d:])/gi,
    (full: string, h: string, m: string, ampm?: string) => {
      const hour = parseInt(h, 10), minute = parseInt(m, 10);
      if (hour > 23 || minute > 59) return full;
      const hourWord = ampm ? (hour % 12 === 0 ? 'twelve' : twoDigitWords(hour % 12)) : twoDigitWords(hour);
      let spoken = minute === 0 ? `${hourWord} o'clock`
        : minute < 10 ? `${hourWord} oh ${TTS_ONES[minute]}`
        : `${hourWord} ${twoDigitWords(minute)}`;
      if (ampm) spoken += ' ' + ampm.replace(/[.\s]/g, '').toUpperCase();
      return spoken;
    },
  );
}

// Strip content that shouldn't be spoken (URLs, code blocks, think tags)
export function stripForTTS(text: string): string {
  return normalizeTimesForSpeech(text
    // Remove JSON tool-call arrays: [{"name":"...","parameters":{...}}]
    // Safety net for blocks that slip past the streaming filter
    .replace(/\[\s*\{[^}]*"name"\s*:\s*"[^"]+"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{[\s\S]*?\}\s*\}\s*\]/g, '')
    // Remove the group-room [PASS] marker (incl. *[PASS]* / [pass.]) — it's a
    // control signal, the user doesn't need to hear "pass" spoken every turn.
    .replace(/\*{0,2}\s*\[\s*pass\s*[.!]*\s*\]\s*\*{0,2}/gi, '')
    // Remove Mistral tool-call text that leaked past the parser ([TOOL_CALLS]…)
    // so it isn't read aloud — the actual call is salvaged & executed server-side.
    .replace(/\[TOOL_CALLS\][\s\S]*/i, '')
    // Remove [think]...[/think] blocks (case insensitive)
    .replace(/\[think\][\s\S]*?\[\/think\]/gi, '')
    // Remove <think>...</think> blocks (case insensitive)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Remove parenthesized HA entity IDs like (sensor.kitchen_temp_kitchen_temperature)
    .replace(/\s*\(\w+\.\w[\w.]*\)/g, '')
    // Remove URLs
    .replace(/https?:\/\/[^\s]+/g, '')
    // Remove HTML tags (in case LLM outputs raw HTML)
    .replace(/<[^>]+>/g, '')
    // Remove fenced code blocks (with or without newline after opening fence)
    .replace(/```\w*[\s\S]*?```/g, '')
    // Remove indented code blocks (4+ spaces or tab at start of line — common code pattern)
    .replace(/^(?:[ ]{4,}|\t).+$/gm, '')
    // Remove inline code
    .replace(/`[^`]+`/g, '')
    // Remove lines that look like code (common programming patterns)
    .replace(/^[\s]*(?:import |from |def |class |function |const |let |var |return |if \(|for \(|while \(|print\(|console\.).+$/gm, '')
    // Remove markdown image refs ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove markdown links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove entire markdown tables (lines starting/ending with pipes, including separator rows)
    .replace(/^[\s]*\|.*\|[\s]*$/gm, '')
    // Remove any remaining table pipes
    .replace(/\|/g, '')
    // Remove horizontal rules (---, ***, ___)
    .replace(/^[\s]*([-*_]){3,}[\s]*$/gm, '')
    // Remove markdown headers (### Header text → Header text)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove markdown list bullets and numbered lists (- item, 1. item)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove markdown formatting
    .replace(/[*_~]+/g, '')
    // Remove emojis (constructed at runtime for TS compatibility)
    .replace(new RegExp('[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}\\u{1F900}-\\u{1F9FF}\\u{1FA00}-\\u{1FA6F}\\u{1FA70}-\\u{1FAFF}\\u{200D}\\u{20E3}\\u{E0020}-\\u{E007F}]', 'gu'), '')
    // Clean up extra whitespace
    .replace(/\s+/g, ' ')
    .trim());
}

// ============================================================================
// Color utilities
// ============================================================================

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

// ============================================================================
// Storage utilities
// ============================================================================

export function getLocalStorage<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;

  try {
    const item = window.localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setLocalStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error('Failed to save to localStorage:', error);
  }
}

// ============================================================================
// Error handling utilities
// ============================================================================

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unknown error occurred';
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('fetch') ||
      error.message.includes('network') ||
      error.message.includes('ECONNREFUSED') ||
      error.name === 'TypeError'
    );
  }
  return false;
}

// ============================================================================
// Debounce/Throttle utilities
// ============================================================================

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// ============================================================================
// Array utilities
// ============================================================================

export function groupBy<T, K extends string | number | symbol>(
  array: T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyFn(item);
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    },
    {} as Record<K, T[]>
  );
}

export function sortByDate<T>(
  array: T[],
  dateKey: keyof T,
  order: 'asc' | 'desc' = 'desc'
): T[] {
  return [...array].sort((a, b) => {
    const dateA = new Date(a[dateKey] as string | Date).getTime();
    const dateB = new Date(b[dateKey] as string | Date).getTime();
    return order === 'desc' ? dateB - dateA : dateA - dateB;
  });
}
