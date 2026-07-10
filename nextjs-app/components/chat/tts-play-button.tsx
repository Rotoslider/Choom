'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Volume2, Square } from 'lucide-react';
import { cn } from '@/lib/utils';

// Only one message plays at a time — starting a new one stops the current.
let activeStop: (() => void) | null = null;

// Play/stop button for one saved message's TTS audio. First click fetches
// /api/tts/message/<id> (server generates + caches the WAV in the author's
// voice); replays hit the disk cache and start instantly.
export function TtsPlayButton({ src, className }: { src: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      // Unmount: stop our audio and release the global slot if we held it
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.src = '';
      }
    };
  }, []);

  const stop = () => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setState(s => (s === 'error' ? s : 'idle'));
    activeStop = null;
  };

  const play = async () => {
    // Stop whichever message is currently playing
    activeStop?.();
    activeStop = stop;
    try {
      let audio = audioRef.current;
      if (!audio) {
        setState('loading');
        audio = new Audio(src);
        audio.preload = 'auto';
        audioRef.current = audio;
        audio.onended = () => {
          if (activeStop === stop) activeStop = null;
          setState('idle');
        };
        audio.onerror = () => {
          if (activeStop === stop) activeStop = null;
          setState('error');
        };
      }
      setState(audio.readyState >= 3 ? 'playing' : 'loading');
      await audio.play();
      setState('playing');
    } catch {
      setState('error');
      if (activeStop === stop) activeStop = null;
    }
  };

  const onClick = () => {
    if (state === 'playing') {
      stop();
    } else if (state !== 'loading') {
      if (state === 'error') {
        // Retry from scratch — the server may have been busy or the TTS
        // service briefly down; a fresh request usually succeeds.
        audioRef.current = null;
        setState('idle');
      }
      void play();
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={state === 'playing' ? 'Stop' : state === 'error' ? 'TTS failed — click to retry' : state === 'loading' ? 'Generating audio…' : 'Listen to this response'}
      className={cn(
        'inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors align-middle',
        state === 'error' && 'text-destructive',
        className,
      )}
    >
      {state === 'loading' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === 'playing' ? (
        <Square className="h-3.5 w-3.5" />
      ) : (
        <Volume2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
