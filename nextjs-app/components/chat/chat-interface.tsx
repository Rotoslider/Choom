'use client';

import React, { useCallback, useState, useRef } from 'react';
import { MessageList } from './message-list';
import { InputArea, ImageAttachment } from './input-area';
import { AvatarDisplay } from '../common/avatar-display';
import { LiveAvatarView, LiveAvatarHandle } from '../avatar/live-avatar-view';
import { useAppStore } from '@/lib/store';
import type { Message } from '@/lib/types';
import { MessageSquare, Video } from 'lucide-react';

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
  isSpeaking?: boolean;
  liveAvatarRef?: React.RefObject<LiveAvatarHandle | null>;
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
  isSpeaking = false,
  liveAvatarRef,
}: ChatInterfaceProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { currentChoom, services, ui, isStreaming, setActiveLiveChoomId, settings } = useAppStore();
  const avatarEnabled = settings.avatar?.enabled ?? true;
  const choomAvatarMode = (currentChoom?.avatarMode as 'off' | 'live' | 'desktop' | null) || 'off';
  const showLiveTab = avatarEnabled && choomAvatarMode === 'live';

  const [activeTab, setActiveTab] = useState<'chat' | 'live'>('chat');

  // Reset to Chat tab when switching Chooms + release any Live lock
  React.useEffect(() => {
    setActiveTab('chat');
    setActiveLiveChoomId(null);
  }, [currentChoom?.id, setActiveLiveChoomId]);

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
  const hasAvatar = !!currentChoom?.avatarUrl;
  const avatarServiceUp = services.avatar === 'connected';
  // Only block if ANOTHER choom has the live tab (not this one, not null)
  const isLiveBlocked =
    ui.activeLiveChoomId !== null && ui.activeLiveChoomId !== currentChoom?.id;
  // Can only go live if mode is 'live' and has photo
  const canGoLive = showLiveTab && hasAvatar && !isLiveBlocked;

  // Auto-switch to Chat if live mode is turned off
  React.useEffect(() => {
    if (activeTab === 'live' && !showLiveTab) {
      setActiveTab('chat');
      if (ui.activeLiveChoomId === currentChoom?.id) {
        setActiveLiveChoomId(null);
      }
    }
  }, [showLiveTab, activeTab, currentChoom?.id, ui.activeLiveChoomId, setActiveLiveChoomId]);

  const handleTabChange = (tab: 'chat' | 'live') => {
    if (tab === 'live' && !canGoLive) return;

    setActiveTab(tab);

    if (tab === 'live') {
      setActiveLiveChoomId(currentChoom?.id || null);
    } else {
      if (ui.activeLiveChoomId === currentChoom?.id) {
        setActiveLiveChoomId(null);
      }
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
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

            {/* Tab switcher — only show when Choom is in 'live' avatar mode */}
            {currentChoom && showLiveTab && (
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
                <button
                  onClick={() => handleTabChange('chat')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    activeTab === 'chat'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Chat
                </button>
                <button
                  onClick={() => handleTabChange('live')}
                  disabled={!canGoLive}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    activeTab === 'live'
                      ? 'bg-card text-foreground shadow-sm'
                      : !canGoLive
                        ? 'text-muted-foreground/40 cursor-not-allowed'
                        : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={
                    !hasAvatar
                      ? 'Upload a photo to use Live mode'
                      : !avatarServiceUp
                        ? 'Avatar service not connected'
                        : isLiveBlocked
                          ? 'Another Choom has the Live tab open'
                          : 'Live avatar mode'
                  }
                >
                  <Video className="w-3.5 h-3.5" />
                  Live
                </button>
              </div>
            )}

            {/* Connection status */}
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

      {/* Tab content */}
      {activeTab === 'live' && hasAvatar && currentChoom ? (
        <LiveAvatarView
          ref={liveAvatarRef}
          choomId={currentChoom.id}
          avatarUrl={currentChoom.avatarUrl}
          messages={messages}
          isSpeaking={isSpeaking}
          isStreaming={isStreaming}
        />
      ) : (
        <MessageList
          messages={messages}
          isLoading={isLoading}
          streamingImage={streamingImage}
          agentProgress={agentProgress}
          planProgress={planProgress}
        />
      )}


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
