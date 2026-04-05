'use client';

import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import type { Message } from '@/lib/types';
import { User } from 'lucide-react';

export interface LiveAvatarHandle {
  playFrames: (frames: string[], fps: number, audio?: HTMLAudioElement, idleFrame?: string) => void;
}

interface LiveAvatarViewProps {
  choomId: string;
  avatarUrl: string | null;
  messages: Message[];
  isSpeaking?: boolean;
  isStreaming?: boolean;
}

interface QueuedClip {
  frames: string[];
  fps: number;
  audio?: HTMLAudioElement;
}

export const LiveAvatarView = forwardRef<LiveAvatarHandle, LiveAvatarViewProps>(
  function LiveAvatarView(
    { choomId, avatarUrl, messages, isSpeaking = false, isStreaming = false },
    ref
  ) {
    const [currentFrame, setCurrentFrame] = useState<string | null>(null);
    const [idleFrame, setIdleFrame] = useState<string | null>(null);
    const [isAnimating, setIsAnimating] = useState(false);
    const animationRef = useRef<number | null>(null);
    const currentAudioRef = useRef<HTMLAudioElement | null>(null);
    const clipQueueRef = useRef<QueuedClip[]>([]);
    const isPlayingClipRef = useRef(false);

    // Play the next clip from the queue
    const playNextClip = () => {
      if (clipQueueRef.current.length === 0) {
        isPlayingClipRef.current = false;
        setIsAnimating(false);
        setCurrentFrame(null);
        return;
      }

      isPlayingClipRef.current = true;
      const clip = clipQueueRef.current.shift()!;
      setIsAnimating(true);

      // Stop any previous audio
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.src = '';
        currentAudioRef.current = null;
      }

      // Cancel any running frame animation
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }

      // Play audio
      if (clip.audio) {
        currentAudioRef.current = clip.audio;
        clip.audio.play().catch(() => {});
      }

      // Audio-only clip (no frames) — wait for audio to finish then play next
      if (clip.frames.length === 0) {
        if (clip.audio) {
          clip.audio.onended = () => {
            animationRef.current = null;
            playNextClip();
          };
          // Safety: if audio fails or is very short
          clip.audio.onerror = () => playNextClip();
        } else {
          playNextClip();
        }
        return;
      }

      // Play frames synced with audio
      let frameIndex = 0;
      const interval = 1000 / clip.fps;
      let lastTime = performance.now();

      const animate = (now: number) => {
        if (frameIndex >= clip.frames.length) {
          animationRef.current = null;
          playNextClip();
          return;
        }
        if (now - lastTime >= interval) {
          setCurrentFrame(clip.frames[frameIndex]);
          frameIndex++;
          lastTime = now;
        }
        animationRef.current = requestAnimationFrame(animate);
      };

      animationRef.current = requestAnimationFrame(animate);
    };

    // Expose playFrames to parent — queues clips for sequential playback
    useImperativeHandle(ref, () => ({
      playFrames(frames: string[], fps: number, audio?: HTMLAudioElement, newIdleFrame?: string) {
        if (newIdleFrame) setIdleFrame(newIdleFrame);
        if (frames.length === 0 && !audio) return;

        clipQueueRef.current.push({ frames, fps, audio });

        if (!isPlayingClipRef.current) {
          playNextClip();
        }
      },
    }));

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current.src = '';
        }
        clipQueueRef.current = [];
      };
    }, []);

    // Clear queue when choom changes
    useEffect(() => {
      clipQueueRef.current = [];
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
    }, [choomId]);

    const recentMessages = messages.slice(-4);

    const statusText = isAnimating
      ? 'Speaking...'
      : isStreaming
        ? 'Thinking...'
        : 'Listening...';

    const statusDotClass = isAnimating
      ? 'bg-green-500 animate-pulse'
      : isStreaming
        ? 'bg-purple-500 animate-pulse'
        : 'bg-muted-foreground/50';

    const statusTextClass = isAnimating
      ? 'text-green-400'
      : isStreaming
        ? 'text-purple-400'
        : 'text-muted-foreground';

    if (!avatarUrl) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4">
            <div className="w-24 h-24 mx-auto rounded-full bg-muted flex items-center justify-center">
              <User className="w-12 h-12 text-muted-foreground" />
            </div>
            <p className="text-lg font-medium">No Avatar Photo</p>
            <p className="text-sm text-muted-foreground">
              Upload a photo in the Choom edit panel to use Live mode
            </p>
          </div>
        </div>
      );
    }

    // Use idle frame (256x256 from LivePortrait) if available, else full photo
    const staticSrc = idleFrame
      ? `data:image/jpeg;base64,${idleFrame}`
      : avatarUrl;
    const displaySrc = currentFrame
      ? `data:image/jpeg;base64,${currentFrame}`
      : staticSrc;

    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 relative rounded-xl overflow-hidden border border-border bg-gradient-to-b from-card/80 to-card/40 mx-4 mt-2 flex items-center justify-center">
          <img
            src={displaySrc}
            alt="Avatar"
            className="object-contain rounded-lg shadow-lg"
            style={{ maxHeight: '600px', maxWidth: '600px' }}
          />

          {/* Status indicator */}
          <div className="absolute bottom-3 left-3">
            <div className="glass rounded-full px-3 py-1.5 flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${statusDotClass}`} />
              <span className={`text-xs font-medium ${statusTextClass}`}>
                {statusText}
              </span>
            </div>
          </div>

          {/* Message overlay */}
          {recentMessages.length > 0 && (
            <div className="absolute bottom-3 right-3 left-16 max-h-[30%] overflow-y-auto">
              <div className="space-y-1.5">
                {recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`glass rounded-lg px-3 py-1.5 text-xs ${
                      msg.role === 'user'
                        ? 'ml-auto max-w-[70%] text-right bg-primary/20'
                        : 'mr-auto max-w-[85%] bg-card/60'
                    }`}
                  >
                    <p className="line-clamp-2 text-foreground/80">
                      {msg.content.slice(0, 200)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);
