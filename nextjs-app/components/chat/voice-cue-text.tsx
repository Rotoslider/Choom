'use client';

import { splitVoiceCues } from '@/lib/voice-cues';

/** Plain text with its delivery cues ("[warm]") drawn dimmed, for places that don't render markdown. */
export function VoiceCueText({ text }: { text: string }) {
  return (
    <>
      {splitVoiceCues(text).map((piece, i) =>
        piece.cue ? (
          <span key={i} className="voice-cue text-[0.85em] italic text-muted-foreground/70 select-none" title="How her voice says the next words">
            [{piece.text}]
          </span>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}
