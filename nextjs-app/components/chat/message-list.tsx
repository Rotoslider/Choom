'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble } from './message-bubble';
import { ToolProgress } from './tool-progress';
import { PlanDisplay } from './plan-display';
import type { PlanProgress } from './plan-display';
import { TypingIndicator } from './typing-indicator';
import { useAppStore } from '@/lib/store';
import type { Message } from '@/lib/types';

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
  streamingImage?: { url: string; prompt: string } | null;
  agentProgress?: {
    iteration: number;
    maxIterations: number;
    steps: Array<{
      toolCall: { id: string; name: string; arguments: Record<string, unknown> };
      result?: unknown;
      status: 'running' | 'success' | 'error';
    }>;
    isActive: boolean;
  } | null;
  planProgress?: PlanProgress | null;
}

export function MessageList({ messages, isLoading = false, streamingImage, agentProgress, planProgress }: MessageListProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const isProgrammaticScroll = useRef(false);
  const lastMessageCount = useRef(messages.length);
  const { isStreaming, streamingContent, currentChoom } = useAppStore();

  // Helper: scroll to bottom without triggering the "user scrolled up" detection
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    isProgrammaticScroll.current = true;
    bottomRef.current?.scrollIntoView({ behavior });
    // Reset flag after scroll event has fired
    setTimeout(() => { isProgrammaticScroll.current = false; }, 50);
  }, []);

  // Detect when user scrolls up in the Radix ScrollArea viewport
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (!viewport) return;

    const handleScroll = () => {
      // Ignore scroll events caused by our own scrollIntoView calls
      if (isProgrammaticScroll.current) return;

      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      userScrolledUp.current = distanceFromBottom > 150;
    };

    viewport.addEventListener('scroll', handleScroll);
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // Effect 1: Always scroll to bottom when new messages arrive (user sent or received)
  useEffect(() => {
    const newMessageArrived = messages.length !== lastMessageCount.current;
    lastMessageCount.current = messages.length;

    if (newMessageArrived) {
      userScrolledUp.current = false;
      scrollToBottom();
    }
  }, [messages.length, scrollToBottom]);

  // Effect 2: During streaming, keep scrolling only if user hasn't scrolled up
  useEffect(() => {
    if (streamingContent && !userScrolledUp.current) {
      scrollToBottom();
    }
  }, [streamingContent, scrollToBottom]);

  // Effect 3: Scroll when loading starts (typing indicator) or streaming image arrives
  useEffect(() => {
    if ((isLoading || streamingImage) && !userScrolledUp.current) {
      scrollToBottom();
    }
  }, [isLoading, streamingImage, scrollToBottom]);

  return (
    <ScrollArea className="flex-1 px-4" ref={scrollAreaRef}>
      <div className="py-4 space-y-4 chat-scroll">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-gradient-primary opacity-20 mb-4 animate-pulse-slow" />
            <h3 className="text-lg font-medium text-muted-foreground mb-2">
              Start a conversation
            </h3>
            <p className="text-sm text-muted-foreground/70 max-w-xs">
              Send a message to begin chatting with your AI companion
            </p>
          </div>
        )}

        {messages.map((message, index) => {
          // Check if this is the last assistant message and we're streaming
          const isLastAssistant =
            message.role === 'assistant' &&
            index === messages.length - 1 &&
            isStreaming;

          return (
            <MessageBubble
              key={message.id}
              message={message}
              isStreaming={isLastAssistant}
              streamingContent={isLastAssistant ? streamingContent : undefined}
              choomName={currentChoom?.name}
            />
          );
        })}

        {/* Show plan progress during streaming */}
        {planProgress && planProgress.steps.length > 0 && (
          <div className="px-11">
            <PlanDisplay plan={planProgress} />
          </div>
        )}

        {/* Show agent tool progress during streaming */}
        {agentProgress && agentProgress.steps.length > 0 && (
          <div className="px-11">
            <ToolProgress
              iteration={agentProgress.iteration}
              maxIterations={agentProgress.maxIterations}
              steps={agentProgress.steps}
              isActive={agentProgress.isActive}
            />
          </div>
        )}

        {/* Show generated image during streaming */}
        {streamingImage && (
          <div className="flex gap-3 animate-slide-up">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <div className="flex flex-col max-w-[75%] space-y-1">
              <div className="px-4 py-2.5 shadow-sm bg-card border border-border rounded-2xl rounded-bl-md">
                <p className="text-xs text-muted-foreground mb-2">Generated image:</p>
                <img
                  src={streamingImage.url}
                  alt={streamingImage.prompt}
                  className="max-w-full rounded-lg shadow-md"
                  style={{ maxHeight: '400px' }}
                />
                <p className="text-xs text-muted-foreground mt-2 italic">{streamingImage.prompt}</p>
              </div>
            </div>
          </div>
        )}

        {/* Show typing indicator when loading but not streaming yet */}
        {isLoading && !isStreaming && <TypingIndicator />}

        {/* Invisible marker for auto-scroll */}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
