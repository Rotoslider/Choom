'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { ChatInterface } from '@/components/chat/chat-interface';
import { SettingsPanel } from '@/components/settings/settings-panel';
import { HealthDashboard } from '@/components/health/health-dashboard';
import { ChoomEditPanel } from '@/components/sidebar/choom-edit-panel';
import { ImageGallery } from '@/components/gallery/image-gallery';
import { LogPanel } from '@/components/logs/log-panel';
import { useAppStore } from '@/lib/store';
import { StreamingTTS } from '@/lib/tts-client';
import { log, useLogStore } from '@/lib/log-store';
import type { Message, Choom, Chat, StreamingChatChunk, ServiceHealth } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function Home() {
  const {
    currentChoomId,
    currentChatId,
    currentChoom,
    setCurrentChoom,
    setCurrentChat,
    setCurrentChoomData,
    setCurrentChatData,
    setChooms,
    setChats,
    setMessages,
    addMessage,
    ui,
    setSettingsOpen,
    setIsStreaming,
    setStreamingContent,
    clearStreamingContent,
    updateServiceHealth,
    chooms,
    chats,
    messages,
    settings,
  } = useAppStore();

  const [isLoading, setIsLoading] = useState(true);
  const [healthOpen, setHealthOpen] = useState(false);
  const [editingChoom, setEditingChoom] = useState<Choom | null>(null);
  const [choomEditOpen, setChoomEditOpen] = useState(false);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  const [streamingImage, setStreamingImage] = useState<{ url: string; prompt: string } | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [agentProgress, setAgentProgress] = useState<{
    iteration: number;
    maxIterations: number;
    steps: Array<{
      toolCall: { id: string; name: string; arguments: Record<string, unknown> };
      result?: unknown;
      status: 'running' | 'success' | 'error';
    }>;
    isActive: boolean;
  } | null>(null);
  const [planProgress, setPlanProgress] = useState<{
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
  } | null>(null);

  // TTS instance for streaming audio
  const ttsRef = useRef<StreamingTTS | null>(null);

  // Abort controller for stopping generation
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize TTS when settings or current Choom change
  useEffect(() => {
    if (settings.tts.autoPlay) {
      // Use Choom's voice if set, otherwise use global default
      const ttsSettings = {
        ...settings.tts,
        defaultVoice: currentChoom?.voiceId || settings.tts.defaultVoice,
      };
      ttsRef.current = new StreamingTTS(ttsSettings);
      ttsRef.current.setMuted(ui.isMuted);
    }
    return () => {
      ttsRef.current?.stop();
    };
  }, [settings.tts, currentChoom?.voiceId]);

  // Update TTS muted state
  useEffect(() => {
    ttsRef.current?.setMuted(ui.isMuted);
  }, [ui.isMuted]);

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch chooms
        const choomsRes = await fetch('/api/chooms');
        if (choomsRes.ok) {
          const choomsData = await choomsRes.json();
          setChooms(choomsData);

          // If no current choom selected but we have chooms, select first one
          if (!currentChoomId && choomsData.length > 0) {
            setCurrentChoom(choomsData[0].id);
            setCurrentChoomData(choomsData[0]);
          }
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  // Fetch chats when choom changes, and poll for new Signal-created chats
  useEffect(() => {
    if (!currentChoomId) {
      setChats([]);
      return;
    }

    const fetchChats = async () => {
      try {
        const res = await fetch(`/api/chats?choomId=${currentChoomId}`);
        if (res.ok) {
          const chatsData = await res.json();
          setChats(chatsData);

          // Update current choom data
          const choom = chooms.find((c) => c.id === currentChoomId);
          if (choom) {
            setCurrentChoomData(choom);
          }
        }
      } catch (error) {
        console.error('Failed to fetch chats:', error);
      }
    };

    fetchChats();

    // Poll every 30s to pick up Signal-created chats
    const interval = setInterval(fetchChats, 30000);
    return () => clearInterval(interval);
  }, [currentChoomId, chooms]);

  // Fetch messages when chat changes
  useEffect(() => {
    if (!currentChatId) {
      setMessages([]);
      return;
    }

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/chats/${currentChatId}/messages`);
        if (res.ok) {
          const messagesData = await res.json();
          setMessages(messagesData);

          // Update current chat data
          const chat = chats.find((c) => c.id === currentChatId);
          if (chat) {
            setCurrentChatData(chat);
          }
        }
      } catch (error) {
        console.error('Failed to fetch messages:', error);
      }
    };

    fetchMessages();
  }, [currentChatId, chats]);

  // Update activity log context and load persisted logs when choom/chat changes
  useEffect(() => {
    const { setContext, loadLogs, clearLogs } = useLogStore.getState();
    setContext(currentChoomId || null, currentChatId || null);
    if (currentChatId) {
      loadLogs(currentChoomId || undefined, currentChatId);
    } else if (currentChoomId) {
      loadLogs(currentChoomId);
    } else {
      clearLogs();
    }
  }, [currentChoomId, currentChatId]);

  // Check service health periodically
  useEffect(() => {
    const checkHealth = async () => {
      try {
        // Use POST with configured endpoints from settings
        const res = await fetch('/api/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoints: {
              llm: settings.llm.endpoint,
              memory: settings.memory.endpoint,
              tts: settings.tts.endpoint,
              stt: settings.stt.endpoint,
              imageGen: settings.imageGen.endpoint,
            },
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const serviceKeys: (keyof ServiceHealth)[] = ['llm', 'memory', 'tts', 'stt', 'imageGen', 'weather', 'search'];
          serviceKeys.forEach((service) => {
            const info = data.services[service] as { status: string } | undefined;
            const status = info?.status === 'connected' ? 'connected' : 'disconnected';
            updateServiceHealth(service, status);
          });
        }
      } catch {
        // Update all services as disconnected
        ['llm', 'memory', 'tts', 'stt', 'imageGen'].forEach((s) => {
          updateServiceHealth(s as 'llm' | 'memory' | 'tts' | 'stt' | 'imageGen', 'disconnected');
        });
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [updateServiceHealth, settings]);

  // Handle choom selection
  const handleSelectChoom = useCallback(
    (id: string) => {
      setCurrentChoom(id);
      setCurrentChat(null);
      setMessages([]);
    },
    [setCurrentChoom, setCurrentChat, setMessages]
  );

  // Handle chat selection
  const handleSelectChat = useCallback(
    (id: string) => {
      setCurrentChat(id);
    },
    [setCurrentChat]
  );

  // Handle creating new choom
  const handleCreateChoom = useCallback(async () => {
    try {
      const res = await fetch('/api/chooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Choom',
          description: 'A new AI companion',
          systemPrompt: 'You are a helpful and friendly AI assistant.',
        }),
      });

      if (res.ok) {
        const newChoom = await res.json();
        setChooms([...chooms, newChoom]);
        setCurrentChoom(newChoom.id);
        setCurrentChoomData(newChoom);
      }
    } catch (error) {
      console.error('Failed to create choom:', error);
    }
  }, [chooms, setChooms, setCurrentChoom, setCurrentChoomData]);

  // Handle creating new chat
  const handleCreateChat = useCallback(async () => {
    if (!currentChoomId) return;

    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choomId: currentChoomId }),
      });

      if (res.ok) {
        const newChat = await res.json();
        setChats([newChat, ...chats]);
        setCurrentChat(newChat.id);
        setCurrentChatData(newChat);
        setMessages([]);
      }
    } catch (error) {
      console.error('Failed to create chat:', error);
    }
  }, [currentChoomId, chats, setChats, setCurrentChat, setCurrentChatData, setMessages]);

  // Handle archiving chat
  const handleArchiveChat = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/chats/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: true }),
        });
        setChats(chats.filter((c) => c.id !== id));
        if (currentChatId === id) {
          setCurrentChat(null);
        }
      } catch (error) {
        console.error('Failed to archive chat:', error);
      }
    },
    [chats, currentChatId, setChats, setCurrentChat]
  );

  // Handle deleting chat
  const handleDeleteChat = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/chats/${id}`, { method: 'DELETE' });
        setChats(chats.filter((c) => c.id !== id));
        if (currentChatId === id) {
          setCurrentChat(null);
          setMessages([]);
        }
      } catch (error) {
        console.error('Failed to delete chat:', error);
      }
    },
    [chats, currentChatId, setChats, setCurrentChat, setMessages]
  );

  // Handle renaming chat
  const handleRenameChat = useCallback(
    async (id: string, newTitle: string) => {
      try {
        const res = await fetch(`/api/chats/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        if (res.ok) {
          const updatedChat = await res.json();
          setChats(chats.map((c) => (c.id === id ? { ...c, title: updatedChat.title } : c)));
        }
      } catch (error) {
        console.error('Failed to rename chat:', error);
      }
    },
    [chats, setChats]
  );

  // Handle editing choom
  const handleEditChoom = useCallback((choom: Choom) => {
    setEditingChoom(choom);
    setChoomEditOpen(true);
  }, []);

  // Handle saving choom
  const handleSaveChoom = useCallback(
    async (updates: Partial<Choom>) => {
      if (!updates.id) return;

      try {
        const res = await fetch(`/api/chooms/${updates.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });

        if (res.ok) {
          const updatedChoom = await res.json();
          // Update chooms list
          setChooms(chooms.map((c) => (c.id === updatedChoom.id ? updatedChoom : c)));
          // Update current choom data if it's the one being edited
          if (currentChoomId === updatedChoom.id) {
            setCurrentChoomData(updatedChoom);
          }
        }
      } catch (error) {
        console.error('Failed to update choom:', error);
        throw error;
      }
    },
    [chooms, currentChoomId, setChooms, setCurrentChoomData]
  );

  // Handle sending message
  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!currentChoomId || !currentChatId) {
        // Create a new chat if none selected
        if (currentChoomId && !currentChatId) {
          const res = await fetch('/api/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ choomId: currentChoomId }),
          });

          if (res.ok) {
            const newChat = await res.json();
            setChats([newChat, ...chats]);
            setCurrentChat(newChat.id);
            setCurrentChatData(newChat);
            // Continue with the new chat
            await sendMessageToChat(newChat.id, content);
          }
          return;
        }
        return;
      }

      await sendMessageToChat(currentChatId, content);
    },
    [currentChoomId, currentChatId, chats]
  );

  const sendMessageToChat = async (chatId: string, content: string) => {
    // Save last user message for regenerate
    setLastUserMessage(content);

    // Add optimistic user message
    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      chatId,
      role: 'user',
      content,
      toolCalls: null,
      toolResults: null,
      createdAt: new Date(),
    };
    addMessage(userMessage);

    // Log LLM request with user message
    const requestStartTime = Date.now();
    log.llmRequest(settings.llm.model, content);

    // Start streaming
    setIsStreaming(true);
    clearStreamingContent();
    setAgentProgress(null);
    setPlanProgress(null);
    // Stop any current TTS playback when sending a new message
    ttsRef.current?.stop();

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choomId: currentChoomId,
          chatId,
          message: content,
          settings: {
            llm: settings.llm,
            memory: settings.memory,
            imageGen: settings.imageGen,
            weather: settings.weather,
            search: settings.search,
            vision: settings.vision,
            homeAssistant: settings.homeAssistant,
            providers: settings.providers,
            modelProfiles: settings.modelProfiles,
            visionProfiles: settings.visionProfiles,
          },
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const data: StreamingChatChunk = JSON.parse(line.slice(6));

            switch (data.type) {
              case 'content':
                if (data.content) {
                  fullContent += data.content;
                  setStreamingContent(fullContent);
                  // Feed token to TTS for streaming audio
                  if (settings.tts.autoPlay && !ui.isMuted) {
                    ttsRef.current?.onToken(data.content);
                  }
                }
                break;
              case 'tool_call':
                // Log tool calls to activity log
                if (data.toolCall) {
                  log.toolCall(data.toolCall.name, data.toolCall.arguments as Record<string, unknown>);
                  // Track in agent progress
                  setAgentProgress(prev => {
                    const current = prev || { iteration: 1, maxIterations: 10, steps: [], isActive: true };
                    return {
                      ...current,
                      isActive: true,
                      steps: [...current.steps, {
                        toolCall: data.toolCall!,
                        status: 'running' as const,
                      }],
                    };
                  });
                }
                break;
              case 'tool_result':
                // Log tool results to activity log
                if (data.toolResult) {
                  const success = !data.toolResult.error;
                  log.toolResult(data.toolResult.name, success, data.toolResult.result || data.toolResult.error);
                  // Update agent progress step status
                  setAgentProgress(prev => {
                    if (!prev) return prev;
                    const steps = [...prev.steps];
                    const idx = steps.findLastIndex(s => s.toolCall.id === data.toolResult!.toolCallId);
                    if (idx >= 0) {
                      steps[idx] = { ...steps[idx], result: data.toolResult!.result, status: success ? 'success' : 'error' };
                    }
                    return { ...prev, steps };
                  });
                }
                break;
              case 'compaction':
                log.system(`Context compacted: ${data.messagesDropped} msgs folded into summary (~${data.tokensBefore?.toLocaleString()} → ~${data.tokensAfter?.toLocaleString()} tokens)`, 'info');
                break;
              case 'agent_iteration':
                log.system(`Agent step ${data.iteration}/${data.maxIterations}`, 'info');
                // Reset TTS buffer so previous iteration's preamble text isn't spoken again
                ttsRef.current?.reset();
                setAgentProgress(prev => ({
                  iteration: data.iteration || 1,
                  maxIterations: data.maxIterations || 10,
                  steps: prev?.steps || [],
                  isActive: true,
                }));
                break;
              case 'file_created':
                log.system(`File created: ${data.path}`, 'info');
                break;
              case 'image_generated':
                // Display the generated image immediately
                if (data.imageUrl && data.prompt) {
                  setStreamingImage({ url: data.imageUrl, prompt: data.prompt });
                  log.imageGenerated(data.prompt);
                }
                break;
              case 'done':
                // Log LLM response with full content (use resolved model from server, not settings panel)
                log.llmResponse(
                  data.resolvedModel || settings.llm.model,
                  fullContent.length,
                  Date.now() - requestStartTime,
                  fullContent
                );
                // Flush any remaining TTS buffer
                ttsRef.current?.flush();
                // Mark agent progress as complete
                setAgentProgress(prev => prev ? { ...prev, isActive: false } : null);
                // Refresh messages from server BEFORE clearing streaming state
                // This prevents the flash where content/images disappear then reappear
                {
                  const msgRes = await fetch(`/api/chats/${chatId}/messages`);
                  if (msgRes.ok) {
                    const messagesData = await msgRes.json();
                    setMessages(messagesData);
                  }
                }
                // Now safe to clear streaming state - DB messages are loaded
                setStreamingImage(null);
                setPlanProgress(prev => prev ? { ...prev, isActive: false } : null);
                break;
              case 'plan_created':
                if (data.goal && data.steps) {
                  log.system(`Plan created: "${data.goal}" (${data.steps.length} steps)`, 'info');
                  setPlanProgress({
                    goal: data.goal,
                    steps: data.steps.map(s => ({
                      id: s.id,
                      description: s.description,
                      toolName: s.toolName,
                      status: (s.status as 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'rolled_back') || 'pending',
                    })),
                    isActive: true,
                  });
                }
                break;
              case 'plan_step_update':
                if (data.stepId) {
                  setPlanProgress(prev => {
                    if (!prev) return prev;
                    const steps = prev.steps.map(s =>
                      s.id === data.stepId
                        ? {
                            ...s,
                            status: (data.status || s.status) as typeof s.status,
                            result: data.result ?? s.result,
                            statusDescription: data.description ?? s.statusDescription,
                          }
                        : s
                    );
                    return { ...prev, steps };
                  });
                }
                break;
              case 'plan_completed':
                log.system(data.summary || 'Plan completed', 'info');
                setPlanProgress(prev => prev ? {
                  ...prev,
                  isActive: false,
                  summary: data.summary,
                  succeeded: data.succeeded,
                  failed: data.failed,
                  total: data.total,
                } : null);
                break;
              case 'error':
                console.error('Stream error:', data.error);
                log.llmError(data.error || 'Unknown error');
                // Stop TTS on error
                ttsRef.current?.stop();
                setStreamingImage(null);
                break;
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } catch (error) {
      // Don't log abort errors, but still stop TTS
      if (error instanceof Error && error.name === 'AbortError') {
        ttsRef.current?.stop();
        log.system('Generation stopped by user', 'warning');
      } else {
        console.error('Failed to send message:', error);
        log.llmError(error instanceof Error ? error.message : 'Failed to send message');
        ttsRef.current?.stop();
      }
    } finally {
      setIsStreaming(false);
      clearStreamingContent();
      setStreamingImage(null);
      abortControllerRef.current = null;
    }
  };

  // Handle stopping generation
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    ttsRef.current?.stop();
    setIsStreaming(false);
    clearStreamingContent();
    setStreamingImage(null);
    setAgentProgress(null);
    setPlanProgress(null);
  }, [setIsStreaming, clearStreamingContent]);

  // Handle regenerating the last response
  const handleRegenerate = useCallback(async () => {
    if (!lastUserMessage || !currentChatId || !currentChoomId) return;

    // Remove the last assistant message from the UI
    const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant');
    if (lastAssistantIndex >= 0) {
      const updatedMessages = messages.slice(0, lastAssistantIndex);
      setMessages(updatedMessages);
    }

    // Resend the last user message
    await sendMessageToChat(currentChatId, lastUserMessage);
  }, [lastUserMessage, currentChatId, currentChoomId, messages, setMessages]);

  // Handle image generation request (direct request to generate an image)
  const handleImageRequest = useCallback(async () => {
    if (!currentChoomId) return;

    // Create a new chat if none selected
    let targetChatId: string | null = currentChatId;
    if (!targetChatId) {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choomId: currentChoomId }),
      });
      if (res.ok) {
        const newChat = await res.json();
        setChats([newChat, ...chats]);
        setCurrentChat(newChat.id);
        setCurrentChatData(newChat);
        targetChatId = newChat.id;
      } else {
        return;
      }
    }

    if (!targetChatId) return;

    // Send a request to generate a self-portrait (explicitly ask for selfie)
    const imagePrompt = currentChoom?.name
      ? `Generate a selfie/self-portrait of yourself (${currentChoom.name}). This is an image OF YOU, so use self_portrait mode.`
      : 'Generate a self-portrait image of yourself. This is an image OF YOU, so use self_portrait mode.';
    await sendMessageToChat(targetChatId, imagePrompt);
  }, [currentChoomId, currentChatId, currentChoom?.name, chats, setChats, setCurrentChat, setCurrentChatData]);

  // Filter chats for current choom
  const currentChoomChats = chats.filter(
    (c) => c.choomId === currentChoomId && !c.archived
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-primary animate-pulse" />
          <p className="text-muted-foreground">Loading Choom...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <Sidebar
        chooms={chooms}
        chats={currentChoomChats}
        onSelectChoom={handleSelectChoom}
        onSelectChat={handleSelectChat}
        onCreateChoom={handleCreateChoom}
        onCreateChat={handleCreateChat}
        onEditChoom={handleEditChoom}
        onArchiveChat={handleArchiveChat}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHealth={() => setHealthOpen(true)}
        onOpenGallery={() => setGalleryOpen(true)}
        onOpenLogs={() => setLogsOpen(true)}
      />

      {/* Main content */}
      <main
        className={cn(
          'flex-1 transition-all duration-300',
          ui.isSidebarOpen ? 'ml-[280px]' : 'ml-0'
        )}
      >
        <ChatInterface
          messages={messages}
          onSendMessage={handleSendMessage}
          onStop={handleStop}
          onRegenerate={handleRegenerate}
          onImageRequest={handleImageRequest}
          canRegenerate={!!lastUserMessage && messages.some(m => m.role === 'assistant')}
          streamingImage={streamingImage}
          agentProgress={agentProgress}
          planProgress={planProgress}
        />
      </main>

      {/* Settings Panel */}
      <SettingsPanel
        open={ui.isSettingsOpen}
        onOpenChange={setSettingsOpen}
      />

      {/* Health Dashboard */}
      <HealthDashboard
        open={healthOpen}
        onOpenChange={setHealthOpen}
      />

      {/* Choom Edit Panel */}
      <ChoomEditPanel
        choom={editingChoom}
        open={choomEditOpen}
        onOpenChange={setChoomEditOpen}
        onSave={handleSaveChoom}
      />

      {/* Image Gallery */}
      <ImageGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        choomId={currentChoomId}
        choomName={currentChoom?.name}
      />

      {/* Activity Log Panel */}
      {logsOpen && <LogPanel onClose={() => setLogsOpen(false)} />}
    </div>
  );
}
