'use client';

import { Brain } from 'lucide-react';

/**
 * The model's reasoning, shown apart from the reply so the two can't be
 * confused: dashed box, monospace, muted. Display-only — this text is never
 * part of the message, never persisted, and never handed to TTS. Open while
 * it streams, collapsed once the turn is over.
 */
export function ThinkingBox({ text, live = false }: { text: string; live?: boolean }) {
  if (!text.trim()) return null;
  return (
    <details
      open={live}
      className="mb-2 max-w-full rounded-lg border border-dashed border-border/70 bg-muted/30 text-muted-foreground"
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-xs font-medium">
        <Brain className="h-3.5 w-3.5" />
        {live ? 'Thinking…' : 'Thinking'}
        <span className="font-normal opacity-70">(not spoken)</span>
      </summary>
      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-xs">{text}</pre>
    </details>
  );
}
