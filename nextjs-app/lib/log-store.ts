import { create } from 'zustand';
import type { LogEntry, LogLevel, LogCategory } from './types';

const MAX_LOGS = 500; // Keep last 500 entries

// Batch persist buffer - collects logs and POSTs in batches
let _persistBuffer: Array<{
  level: string; category: string; title: string; message: string;
  details?: string; duration?: number; choomId?: string; chatId?: string;
}> = [];
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function flushLogBuffer() {
  if (_persistBuffer.length === 0) return;
  const batch = _persistBuffer.splice(0);
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => { /* silent fail for log persistence */ });
}

function queueLogPersist(entry: {
  level: string; category: string; title: string; message: string;
  details?: unknown; duration?: number; choomId?: string; chatId?: string;
}) {
  _persistBuffer.push({
    ...entry,
    details: entry.details ? JSON.stringify(entry.details) : undefined,
  });
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(flushLogBuffer, 3000);
}

interface LogState {
  logs: LogEntry[];
  isOpen: boolean;
  currentChoomId: string | null;
  currentChatId: string | null;
  filter: {
    categories: LogCategory[];
    levels: LogLevel[];
    search: string;
  };
}

interface LogActions {
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setFilter: (filter: Partial<LogState['filter']>) => void;
  resetFilter: () => void;
  setContext: (choomId: string | null, chatId: string | null) => void;
  loadLogs: (choomId?: string, chatId?: string) => Promise<void>;
}

type LogStore = LogState & LogActions;

const defaultFilter: LogState['filter'] = {
  categories: [],
  levels: [],
  search: '',
};

export const useLogStore = create<LogStore>((set, get) => ({
  logs: [],
  isOpen: false,
  currentChoomId: null,
  currentChatId: null,
  filter: { ...defaultFilter },

  addLog: (entry) => {
    const newEntry: LogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };

    set((state) => ({
      logs: [newEntry, ...state.logs].slice(0, MAX_LOGS),
    }));

    // Persist to server
    const { currentChoomId, currentChatId } = get();
    queueLogPersist({
      level: entry.level,
      category: entry.category,
      title: entry.title,
      message: entry.message,
      details: entry.details,
      duration: entry.duration,
      choomId: currentChoomId || undefined,
      chatId: currentChatId || undefined,
    });

    // Also log to console for debugging
    const prefix = `[${entry.category.toUpperCase()}]`;
    const style = {
      info: 'color: #3b82f6',
      success: 'color: #22c55e',
      warning: 'color: #eab308',
      error: 'color: #ef4444',
    }[entry.level];

    console.log(`%c${prefix} ${entry.title}`, style, entry.message, entry.details || '');
  },

  clearLogs: () => {
    const { currentChoomId, currentChatId } = get();
    set({ logs: [] });

    // Delete from database
    const params = new URLSearchParams();
    if (currentChatId) {
      params.set('chatId', currentChatId);
    } else if (currentChoomId) {
      params.set('choomId', currentChoomId);
    } else {
      params.set('all', 'true');
    }
    fetch(`/api/logs?${params}`, { method: 'DELETE' }).catch(() => {});
  },

  setOpen: (open) => set({ isOpen: open }),

  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),

  setFilter: (filter) =>
    set((state) => ({
      filter: { ...state.filter, ...filter },
    })),

  resetFilter: () => set({ filter: { ...defaultFilter } }),

  setContext: (choomId, chatId) => set({ currentChoomId: choomId, currentChatId: chatId }),

  loadLogs: async (choomId, chatId) => {
    try {
      const params = new URLSearchParams();
      if (choomId) params.set('choomId', choomId);
      if (chatId) params.set('chatId', chatId);
      params.set('limit', '200');

      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) return;
      const serverLogs = await res.json();

      // Convert server logs to LogEntry format
      const entries: LogEntry[] = serverLogs.map((log: {
        id: string; level: string; category: string; title: string;
        message: string; details?: string; duration?: number; createdAt: string;
      }) => {
        let parsedDetails: Record<string, unknown> | undefined;
        if (log.details) {
          try {
            const parsed = JSON.parse(log.details);
            // Ensure it's an object with keys (not a bare string/number/array)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedDetails = parsed;
            } else {
              parsedDetails = { raw: parsed };
            }
          } catch {
            // JSON.parse failed — wrap the raw string so expand arrow still shows
            parsedDetails = { raw: log.details };
          }
        }
        return {
          id: log.id,
          level: log.level as LogLevel,
          category: log.category as LogCategory,
          title: log.title,
          message: log.message,
          details: parsedDetails,
          duration: log.duration || undefined,
          timestamp: new Date(log.createdAt),
        };
      });

      set({ logs: entries });
    } catch {
      // Keep existing logs on failure
    }
  },
}));

// Helper functions for common log operations
export const log = {
  // LLM logs
  llmRequest: (model: string, userMessage?: string) => {
    const preview = userMessage
      ? `"${userMessage.slice(0, 60)}${userMessage.length > 60 ? '...' : ''}"`
      : 'Sending request';
    useLogStore.getState().addLog({
      level: 'info',
      category: 'llm',
      title: 'LLM Request',
      message: preview,
      details: userMessage ? { model, userMessage } : { model },
    });
  },

  llmResponse: (model: string, charCount: number, duration: number, fullResponse?: string) => {
    const preview = fullResponse
      ? `"${fullResponse.slice(0, 80)}${fullResponse.length > 80 ? '...' : ''}"`
      : `${charCount} characters`;
    useLogStore.getState().addLog({
      level: 'success',
      category: 'llm',
      title: 'LLM Response',
      message: `${preview} in ${(duration / 1000).toFixed(2)}s`,
      details: fullResponse
        ? { model, charCount, fullResponse }
        : { model, charCount },
      duration,
    });
  },

  llmError: (error: string, details?: Record<string, unknown>) => {
    useLogStore.getState().addLog({
      level: 'error',
      category: 'llm',
      title: 'LLM Error',
      message: error,
      details,
    });
  },

  llmStreaming: (tokenCount: number) => {
    // Lightweight log for streaming progress (optional, not always needed)
    useLogStore.getState().addLog({
      level: 'info',
      category: 'llm',
      title: 'LLM Streaming',
      message: `Streaming... ${tokenCount} tokens received`,
    });
  },

  // TTS logs
  ttsRequest: (text: string, voice: string) => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'tts',
      title: 'TTS Request',
      message: `"${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
      details: { voice, textLength: text.length, fullText: text },
    });
  },

  ttsResponse: (bytes: number, duration: number, text?: string) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'tts',
      title: 'TTS Response',
      message: `${(bytes / 1024).toFixed(1)}KB audio in ${(duration / 1000).toFixed(2)}s`,
      details: text ? { bytes, fullText: text } : { bytes },
      duration,
    });
  },

  ttsError: (error: string) => {
    useLogStore.getState().addLog({
      level: 'error',
      category: 'tts',
      title: 'TTS Error',
      message: error,
    });
  },

  ttsSkipped: (reason: string) => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'tts',
      title: 'TTS Skipped',
      message: reason,
    });
  },

  // STT logs
  sttStart: () => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'stt',
      title: 'STT Recording',
      message: 'Started recording audio',
    });
  },

  sttResult: (text: string, duration: number) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'stt',
      title: 'STT Result',
      message: `"${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
      details: { textLength: text.length, fullText: text },
      duration,
    });
  },

  sttError: (error: string) => {
    useLogStore.getState().addLog({
      level: 'error',
      category: 'stt',
      title: 'STT Error',
      message: error,
    });
  },

  // Image generation logs
  imageRequest: (prompt: string, settings?: Record<string, unknown>) => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'image',
      title: 'Image Request',
      message: `"${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`,
      details: { fullPrompt: prompt, ...settings },
    });
  },

  imageGenerated: (prompt: string, duration?: number) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'image',
      title: 'Image Generated',
      message: `"${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`,
      details: { fullPrompt: prompt },
      duration,
    });
  },

  imageError: (error: string) => {
    useLogStore.getState().addLog({
      level: 'error',
      category: 'image',
      title: 'Image Error',
      message: error,
    });
  },

  // Tool/Function call logs
  toolCall: (toolName: string, args?: Record<string, unknown>) => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'llm',
      title: 'Tool Call',
      message: `Calling ${toolName}`,
      details: args ? { toolName, arguments: args } : { toolName },
    });
  },

  toolResult: (toolName: string, success: boolean, result?: unknown) => {
    useLogStore.getState().addLog({
      level: success ? 'success' : 'error',
      category: 'llm',
      title: 'Tool Result',
      message: `${toolName}: ${success ? 'Success' : 'Failed'}`,
      details: result ? { toolName, result } : { toolName },
    });
  },

  // Memory logs
  memoryRecall: (query: string, count: number, duration: number) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'memory',
      title: 'Memory Recall',
      message: `Found ${count} memories for "${query.slice(0, 40)}..."`,
      details: { query, count },
      duration,
    });
  },

  memoryStore: (title: string) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'memory',
      title: 'Memory Stored',
      message: title,
    });
  },

  memoryError: (error: string) => {
    useLogStore.getState().addLog({
      level: 'error',
      category: 'memory',
      title: 'Memory Error',
      message: error,
    });
  },

  // Agent logs (for future agentic capabilities)
  agentTaskStart: (taskName: string, details?: Record<string, unknown>) => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'agent',
      title: 'Task Started',
      message: taskName,
      details,
    });
  },

  agentTaskProgress: (taskName: string, progress: string) => {
    useLogStore.getState().addLog({
      level: 'info',
      category: 'agent',
      title: 'Task Progress',
      message: `${taskName}: ${progress}`,
    });
  },

  agentTaskComplete: (taskName: string, duration: number) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'agent',
      title: 'Task Complete',
      message: taskName,
      duration,
    });
  },

  agentTaskError: (taskName: string, error: string) => {
    useLogStore.getState().addLog({
      level: 'error',
      category: 'agent',
      title: 'Task Failed',
      message: `${taskName}: ${error}`,
    });
  },

  // System logs
  system: (message: string, level: LogLevel = 'info') => {
    useLogStore.getState().addLog({
      level,
      category: 'system',
      title: 'System',
      message,
    });
  },

  serviceConnected: (service: string) => {
    useLogStore.getState().addLog({
      level: 'success',
      category: 'system',
      title: 'Service Connected',
      message: service,
    });
  },

  serviceDisconnected: (service: string) => {
    useLogStore.getState().addLog({
      level: 'warning',
      category: 'system',
      title: 'Service Disconnected',
      message: service,
    });
  },
};

// Selector for filtered logs
export const useFilteredLogs = () => {
  const { logs, filter } = useLogStore();

  return logs.filter((log) => {
    // Category filter
    if (filter.categories.length > 0 && !filter.categories.includes(log.category)) {
      return false;
    }

    // Level filter
    if (filter.levels.length > 0 && !filter.levels.includes(log.level)) {
      return false;
    }

    // Search filter
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      return (
        log.title.toLowerCase().includes(searchLower) ||
        log.message.toLowerCase().includes(searchLower)
      );
    }

    return true;
  });
};
