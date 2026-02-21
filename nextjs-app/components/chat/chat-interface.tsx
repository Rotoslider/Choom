'use client';

import React, { useCallback, useState } from 'react';
import { MessageList } from './message-list';
import { InputArea, ImageAttachment } from './input-area';
import { AvatarDisplay } from '../common/avatar-display';
import { useAppStore } from '@/lib/store';
import type { Message } from '@/lib/types';

interface ChatInterfaceProps {
  messages: Message[];
  onSendMessage: (message: string) => Promise<void>;
  onStop?: () => void;
  onRegenerate?: () => void;
  onImageRequest?: () => void;
  canRegenerate?: boolean;
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
  planProgress?: {
    goal: string;
    steps: Array<{
      id: string;
      description: string;
      toolName: string;
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'rolled_back';
      result?: string;
      statusDescription?: string;
    }>;
    isActive: boolean;
    summary?: string;
    succeeded?: number;
    failed?: number;
    total?: number;
  } | null;
}

export function ChatInterface({
  messages,
  onSendMessage,
  onStop,
  onRegenerate,
  onImageRequest,
  canRegenerate = false,
  streamingImage,
  agentProgress,
  planProgress,
}: ChatInterfaceProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { currentChoom, services } = useAppStore();

  const handleSend = useCallback(
    async (message: string, attachment?: ImageAttachment) => {
      setIsLoading(true);
      try {
        let finalMessage = message;
        if (attachment?.workspacePath) {
          const imageContext = `[User attached image: ${attachment.workspacePath}] Please analyze this image using the analyze_image tool with image_path="${attachment.workspacePath}".`;
          finalMessage = finalMessage
            ? `${imageContext}\n\n${finalMessage}`
            : imageContext;
        }
        await onSendMessage(finalMessage);
      } catch (error) {
        console.error('Failed to send message:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [onSendMessage]
  );

  const isLLMConnected = services.llm === 'connected';

  return (
    <div className="flex flex-col h-full">
      {/* Header with avatar display */}
      <div className="flex-shrink-0 border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <div className="flex items-center gap-4">
            <AvatarDisplay
              name={currentChoom?.name}
              avatarUrl={currentChoom?.avatarUrl || undefined}
              size="md"
              showGlow
            />
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold truncate">
                {currentChoom?.name || 'Select a Choom'}
              </h2>
              {currentChoom?.description && (
                <p className="text-sm text-muted-foreground truncate">
                  {currentChoom.description}
                </p>
              )}
            </div>
            {/* Connection status indicator */}
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  isLLMConnected ? 'status-connected' : 'status-disconnected'
                }`}
              />
              <span className="text-xs text-muted-foreground">
                {isLLMConnected ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Message list */}
      <MessageList messages={messages} isLoading={isLoading} streamingImage={streamingImage} agentProgress={agentProgress} planProgress={planProgress} />

      {/* Input area */}
      <InputArea
        onSend={handleSend}
        onStop={onStop}
        onRegenerate={onRegenerate}
        onImageRequest={onImageRequest}
        disabled={!currentChoom || !isLLMConnected}
        canRegenerate={canRegenerate}
        placeholder={
          !currentChoom
            ? 'Select a Choom to start chatting'
            : !isLLMConnected
              ? 'Waiting for LLM connection...'
              : `Message ${currentChoom.name}...`
        }
      />
    </div>
  );
}
