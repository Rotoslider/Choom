import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  AppSettings,
  HomeAssistantSettings,
  AvatarSettings,
  LLMProviderConfig,
  LLMModelProfile,
  VisionModelProfile,
  ServiceHealth,
  ServiceStatus,
  UIState,
  SettingsTab,
  Message,
  Choom,
  Chat,
} from './types';

// ============================================================================
// Default Settings
// ============================================================================

const defaultSettings: AppSettings = {
  llm: {
    endpoint: 'http://localhost:1234/v1',
    model: 'local-model',
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 262144,
    topP: 0.95,
    frequencyPenalty: 0,
    presencePenalty: 0,
  },
  tts: {
    endpoint: 'http://localhost:8004',
    defaultVoice: 'sophie',
    autoPlay: true,
    speed: 1.0,
  },
  stt: {
    endpoint: 'http://localhost:5000',
    language: 'en',
    inputMode: 'push-to-talk',
    vadSensitivity: 0.5,
  },
  imageGen: {
    endpoint: 'http://localhost:7860',
    defaultCheckpoint: '',
    defaultSampler: 'Euler a',
    defaultScheduler: '',
    defaultSteps: 20,
    defaultCfgScale: 7,
    defaultDistilledCfg: 3.5,
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultNegativePrompt: '',
    selfPortrait: {
      enabled: true,
      checkpoint: '',
      sampler: 'Euler a',
      scheduler: '',
      steps: 25,
      cfgScale: 7,
      distilledCfg: 3.5,
      width: 1024,
      height: 1024,
      negativePrompt: '',
      loras: [],
      promptPrefix: '',
      promptSuffix: '',
    },
  },
  weather: {
    apiKey: '',
    provider: 'openweathermap',
    location: '',
    latitude: 0,
    longitude: 0,
    useCoordinates: true,
    units: 'imperial',
    cacheMinutes: 30,
  },
  search: {
    provider: 'brave',
    braveApiKey: '',
    searxngEndpoint: '',
    serpApiKey: '',
    maxResults: 5,
  },
  memory: {
    endpoint: 'http://localhost:8100',
    autoRecall: true,
    recallLimit: 5,
  },
  appearance: {
    theme: 'dark',
    accentColor: 'purple',
    fontSize: 'medium',
    animationsEnabled: true,
  },
  vision: {
    endpoint: 'http://localhost:1234',
    model: '',
    maxTokens: 1024,
    temperature: 0.3,
  },
  homeAssistant: {
    baseUrl: '',
    accessToken: '',
    entityFilter: '',
    injectIntoPrompt: false,
    promptEntities: '',
    cacheSeconds: 30,
  },
  avatar: {
    enabled: true,
    endpoint: 'http://127.0.0.1:8020',
  },
  ownerName: '',
  ownerLocation: '',
};

const defaultServiceHealth: ServiceHealth = {
  llm: 'checking',
  tts: 'checking',
  stt: 'checking',
  imageGen: 'checking',
  memory: 'checking',
  weather: 'checking',
  search: 'checking',
  searxng: 'checking',
  avatar: 'checking',
};

// ============================================================================
// Store Interface
// ============================================================================

interface AppState {
  // Current context
  currentChoomId: string | null;
  currentChatId: string | null;
  currentChoom: Choom | null;
  // Active project pinned per chat (chatId → project folder). Empty/absent =
  // "auto": detect from the message, else default to the Choom's selfies folder.
  activeProjectByChat: Record<string, string>;
  currentChat: Chat | null;

  // Cached data
  chooms: Choom[];
  chats: Chat[];
  messages: Message[];

  // UI state
  ui: UIState;

  // Service health
  services: ServiceHealth;

  // Settings
  settings: AppSettings;

  // Cross-device config safety. Server is the source of truth: on load the
  // device overwrites its own server-owned settings from the server. Off-site
  // (ngrok) writes must be confirmed by the user before they hit the server.
  isLocalConnection: boolean;
  pendingServerSync: { changes: string[]; settings: AppSettings } | null;

  // Streaming state
  streamingContent: string;
  isStreaming: boolean;

  // TTS state
  ttsQueue: string[];
  isSpeaking: boolean;

  // Actions - Context
  setCurrentChoom: (id: string | null) => void;
  setCurrentChat: (id: string | null) => void;
  setActiveProject: (chatId: string, folder: string) => void;
  setCurrentChoomData: (choom: Choom | null) => void;
  setCurrentChatData: (chat: Chat | null) => void;

  // Actions - Data
  setChooms: (chooms: Choom[]) => void;
  addChoom: (choom: Choom) => void;
  updateChoom: (id: string, updates: Partial<Choom>) => void;
  removeChoom: (id: string) => void;

  setChats: (chats: Chat[]) => void;
  addChat: (chat: Chat) => void;
  updateChat: (id: string, updates: Partial<Chat>) => void;
  removeChat: (id: string) => void;

  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  clearMessages: () => void;

  // Actions - UI
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  setRecording: (recording: boolean) => void;
  toggleMute: () => void;
  setMuted: (muted: boolean) => void;
  setGeneratingImage: (generating: boolean) => void;
  setActiveLiveChoomId: (id: string | null) => void;

  // Actions - Services
  updateServiceHealth: (service: keyof ServiceHealth, status: ServiceStatus) => void;
  setAllServicesChecking: () => void;

  // Actions - Settings
  updateSettings: (settings: Partial<AppSettings>) => void;
  updateLLMSettings: (settings: Partial<AppSettings['llm']>) => void;
  updateTTSSettings: (settings: Partial<AppSettings['tts']>) => void;
  updateSTTSettings: (settings: Partial<AppSettings['stt']>) => void;
  updateImageGenSettings: (settings: Partial<AppSettings['imageGen']>) => void;
  updateWeatherSettings: (settings: Partial<AppSettings['weather']>) => void;
  updateSearchSettings: (settings: Partial<AppSettings['search']>) => void;
  updateMemorySettings: (settings: Partial<AppSettings['memory']>) => void;
  updateAppearanceSettings: (settings: Partial<AppSettings['appearance']>) => void;
  updateVisionSettings: (settings: Partial<AppSettings['vision']>) => void;
  updateHomeAssistantSettings: (ha: Partial<HomeAssistantSettings>) => void;
  updateAvatarSettings: (avatar: Partial<AvatarSettings>) => void;
  updateOwnerSettings: (owner: Partial<Pick<AppSettings, 'ownerName' | 'ownerLocation'>>) => void;
  updateProvidersSettings: (providers: LLMProviderConfig[]) => void;
  updateModelProfiles: (profiles: LLMModelProfile[]) => void;
  updateVisionProfiles: (profiles: VisionModelProfile[]) => void;
  resetSettings: () => void;
  // Server is source of truth: overwrite this device's server-owned settings
  // with the server's on load (preserving per-device cosmetics). Sets
  // isLocalConnection from the server's `local` flag.
  applyServerSettings: (server: Record<string, unknown>) => void;
  // Off-site write flow: confirm pushes the pending change to the server with
  // the confirm header; discard drops it (server stays unchanged).
  confirmServerSync: () => Promise<void>;
  discardServerSync: () => void;

  // Actions - Streaming
  setStreamingContent: (content: string) => void;
  appendStreamingContent: (content: string) => void;
  clearStreamingContent: () => void;
  setIsStreaming: (streaming: boolean) => void;

  // Actions - TTS
  addToTTSQueue: (text: string) => void;
  removeFromTTSQueue: () => string | undefined;
  clearTTSQueue: () => void;
  setIsSpeaking: (speaking: boolean) => void;
}

// ============================================================================
// Bridge Config Sync — pushes server-owned settings to bridge-config.json.
// Server is the source of truth: from a LOCAL/LAN browser this writes directly;
// from OFF-SITE (ngrok) it stages a pending change for the user to confirm
// ("yes I'm sure") before it touches the server.
// ============================================================================

let _bridgeSyncTimer: ReturnType<typeof setTimeout> | null = null;

// The server-owned slice of settings that lives in bridge-config.json. Per-
// device cosmetics (appearance, avatar, stt input mode) are NOT here.
function buildBridgePayload(settings: AppSettings): Record<string, unknown> {
  return {
    llm: {
      model: settings.llm.model,
      endpoint: settings.llm.endpoint,
      simpleTasksModel: settings.llm.simpleTasksModel || null,
      simpleTasksProviderId: settings.llm.simpleTasksProviderId || null,
      simpleTasksEnabled: settings.llm.simpleTasksEnabled || false,
      roomCreatorModel: settings.llm.roomCreatorModel || null,
      roomCreatorProviderId: settings.llm.roomCreatorProviderId || null,
    },
    tts: { endpoint: settings.tts.endpoint, defaultVoice: settings.tts.defaultVoice || null },
    stt: { endpoint: settings.stt.endpoint, language: settings.stt.language },
    memory: settings.memory,
    weather: settings.weather,
    search: settings.search,
    imageGen: {
      endpoint: settings.imageGen.endpoint,
      defaultCheckpoint: settings.imageGen.defaultCheckpoint,
      defaultSampler: settings.imageGen.defaultSampler,
      defaultScheduler: settings.imageGen.defaultScheduler,
      defaultSteps: settings.imageGen.defaultSteps,
      defaultCfgScale: settings.imageGen.defaultCfgScale,
      defaultDistilledCfg: settings.imageGen.defaultDistilledCfg,
      defaultWidth: settings.imageGen.defaultWidth,
      defaultHeight: settings.imageGen.defaultHeight,
      defaultNegativePrompt: settings.imageGen.defaultNegativePrompt,
    },
    // Optional fields as null so the server's deepMerge removes stale values
    // (JSON.stringify strips undefined, which deepMerge would preserve).
    vision: {
      ...settings.vision,
      visionProviderId: settings.vision.visionProviderId || null,
      apiKey: settings.vision.apiKey || null,
    },
    visionProfiles: settings.visionProfiles || [],
    modelProfiles: settings.modelProfiles || [],
    homeAssistant: {
      baseUrl: settings.homeAssistant.baseUrl,
      accessToken: settings.homeAssistant.accessToken,
      entityFilter: settings.homeAssistant.entityFilter,
      cacheSeconds: settings.homeAssistant.cacheSeconds,
    },
    providers: settings.providers?.map(p => ({
      id: p.id, name: p.name, type: p.type, endpoint: p.endpoint,
      apiKey: p.apiKey, models: p.models,
    })),
    ownerName: settings.ownerName || null,
    ownerLocation: settings.ownerLocation || null,
  };
}

async function postBridgeConfig(payload: Record<string, unknown>, confirmRemote: boolean) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (confirmRemote) headers['x-confirm-remote-write'] = 'yes';
  return fetch('/api/bridge-config', { method: 'POST', headers, body: JSON.stringify(payload) });
}

// Which server-owned slices this push would actually CHANGE (for the off-site
// confirm dialog), mirroring the server's blank-preserving deepMerge so we don't
// flag a no-op blank as a change.
async function computeServerChanges(payload: Record<string, unknown>): Promise<string[]> {
  try {
    const current = await (await fetch('/api/bridge-config')).json();
    const changed: string[] = [];
    for (const key of Object.keys(payload)) {
      const merged = clientMergePreview(current[key], payload[key]);
      if (JSON.stringify(current[key] ?? null) !== JSON.stringify(merged ?? null)) changed.push(key);
    }
    return changed;
  } catch {
    return Object.keys(payload);
  }
}

// Pure mirror of the server deepMerge rules (no fs) for diff preview only.
function clientMergePreview(cur: unknown, ov: unknown): unknown {
  if (ov === null) return undefined; // deletes
  if (typeof ov === 'string' && ov === '' && typeof cur === 'string' && cur !== '') return cur;
  if (Array.isArray(ov) && ov.length === 0 && Array.isArray(cur) && cur.length > 0) return cur;
  if (cur && typeof cur === 'object' && !Array.isArray(cur) && ov && typeof ov === 'object' && !Array.isArray(ov)) {
    const out: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
    for (const k of Object.keys(ov as Record<string, unknown>)) {
      const m = clientMergePreview((cur as Record<string, unknown>)[k], (ov as Record<string, unknown>)[k]);
      if (m === undefined) delete out[k]; else out[k] = m;
    }
    return out;
  }
  return ov;
}

function syncSettingsToBridgeConfig(settings: AppSettings) {
  // Debounce: wait 2s after last change before syncing
  if (_bridgeSyncTimer) clearTimeout(_bridgeSyncTimer);
  _bridgeSyncTimer = setTimeout(async () => {
    try {
      const payload = buildBridgePayload(settings);
      // Off-site: NEVER write silently. Stage the change and let the user
      // confirm it via the dialog (ServerSyncGuard).
      if (!useAppStore.getState().isLocalConnection) {
        const changes = await computeServerChanges(payload);
        if (changes.length === 0) return; // nothing actually changes server-side
        useAppStore.setState({ pendingServerSync: { changes, settings } });
        return;
      }
      await postBridgeConfig(payload, false);
    } catch (e) {
      console.warn('Failed to sync settings to bridge config:', e);
    }
  }, 2000);
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Initial state
      currentChoomId: null,
      currentChatId: null,
      currentChoom: null,
      activeProjectByChat: {},
      currentChat: null,

      chooms: [],
      chats: [],
      messages: [],

      ui: {
        isSidebarOpen: true,
        isSettingsOpen: false,
        isRecording: false,
        isMuted: false,
        isGeneratingImage: false,
        activeSettingsTab: 'llm',
        activeLiveChoomId: null,
      },

      services: defaultServiceHealth,
      settings: defaultSettings,

      // Assume local until the server's `local` flag says otherwise (set in
      // applyServerSettings on load). Not persisted — re-evaluated each load.
      isLocalConnection: true,
      pendingServerSync: null,

      streamingContent: '',
      isStreaming: false,

      ttsQueue: [],
      isSpeaking: false,

      // Context actions
      setCurrentChoom: (id) => set({ currentChoomId: id }),
      setCurrentChat: (id) => set({ currentChatId: id }),
      setActiveProject: (chatId, folder) =>
        set((state) => ({ activeProjectByChat: { ...state.activeProjectByChat, [chatId]: folder } })),
      setCurrentChoomData: (choom) => set({ currentChoom: choom }),
      setCurrentChatData: (chat) => set({ currentChat: chat }),

      // Data actions - Chooms
      setChooms: (chooms) => set({ chooms }),
      addChoom: (choom) => set((state) => ({ chooms: [...state.chooms, choom] })),
      updateChoom: (id, updates) =>
        set((state) => ({
          chooms: state.chooms.map((c) => (c.id === id ? { ...c, ...updates } : c)),
          currentChoom:
            state.currentChoom?.id === id
              ? { ...state.currentChoom, ...updates }
              : state.currentChoom,
        })),
      removeChoom: (id) =>
        set((state) => ({
          chooms: state.chooms.filter((c) => c.id !== id),
          currentChoomId: state.currentChoomId === id ? null : state.currentChoomId,
          currentChoom: state.currentChoom?.id === id ? null : state.currentChoom,
        })),

      // Data actions - Chats
      setChats: (chats) => set({ chats }),
      addChat: (chat) => set((state) => ({ chats: [chat, ...state.chats] })),
      updateChat: (id, updates) =>
        set((state) => ({
          chats: state.chats.map((c) => (c.id === id ? { ...c, ...updates } : c)),
          currentChat:
            state.currentChat?.id === id
              ? { ...state.currentChat, ...updates }
              : state.currentChat,
        })),
      removeChat: (id) =>
        set((state) => ({
          chats: state.chats.filter((c) => c.id !== id),
          currentChatId: state.currentChatId === id ? null : state.currentChatId,
          currentChat: state.currentChat?.id === id ? null : state.currentChat,
        })),

      // Data actions - Messages
      setMessages: (messages) => set({ messages }),
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      updateMessage: (id, updates) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        })),
      clearMessages: () => set({ messages: [] }),

      // UI actions
      toggleSidebar: () =>
        set((state) => ({ ui: { ...state.ui, isSidebarOpen: !state.ui.isSidebarOpen } })),
      setSidebarOpen: (open) => set((state) => ({ ui: { ...state.ui, isSidebarOpen: open } })),
      toggleSettings: () =>
        set((state) => ({ ui: { ...state.ui, isSettingsOpen: !state.ui.isSettingsOpen } })),
      setSettingsOpen: (open) => set((state) => ({ ui: { ...state.ui, isSettingsOpen: open } })),
      setActiveSettingsTab: (tab) =>
        set((state) => ({ ui: { ...state.ui, activeSettingsTab: tab } })),
      setRecording: (recording) => set((state) => ({ ui: { ...state.ui, isRecording: recording } })),
      toggleMute: () => set((state) => ({ ui: { ...state.ui, isMuted: !state.ui.isMuted } })),
      setMuted: (muted) => set((state) => ({ ui: { ...state.ui, isMuted: muted } })),
      setGeneratingImage: (generating) =>
        set((state) => ({ ui: { ...state.ui, isGeneratingImage: generating } })),
      setActiveLiveChoomId: (id) =>
        set((state) => ({ ui: { ...state.ui, activeLiveChoomId: id } })),

      // Service actions
      updateServiceHealth: (service, status) =>
        set((state) => ({ services: { ...state.services, [service]: status } })),
      setAllServicesChecking: () =>
        set({
          services: {
            llm: 'checking',
            tts: 'checking',
            stt: 'checking',
            imageGen: 'checking',
            memory: 'checking',
            weather: 'checking',
            search: 'checking',
            searxng: 'checking',
            avatar: 'checking',
          },
        }),

      // Settings actions
      updateSettings: (newSettings) =>
        set((state) => ({
          settings: { ...state.settings, ...newSettings },
        })),
      updateLLMSettings: (llm) => {
        set((state) => ({
          settings: { ...state.settings, llm: { ...state.settings.llm, ...llm } },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateTTSSettings: (tts) =>
        set((state) => ({
          settings: { ...state.settings, tts: { ...state.settings.tts, ...tts } },
        })),
      updateSTTSettings: (stt) =>
        set((state) => ({
          settings: { ...state.settings, stt: { ...state.settings.stt, ...stt } },
        })),
      updateImageGenSettings: (imageGen) => {
        set((state) => ({
          settings: { ...state.settings, imageGen: { ...state.settings.imageGen, ...imageGen } },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateWeatherSettings: (weather) => {
        set((state) => ({
          settings: { ...state.settings, weather: { ...state.settings.weather, ...weather } },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateSearchSettings: (search) => {
        set((state) => ({
          settings: { ...state.settings, search: { ...state.settings.search, ...search } },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateMemorySettings: (memory) =>
        set((state) => ({
          settings: { ...state.settings, memory: { ...state.settings.memory, ...memory } },
        })),
      updateAppearanceSettings: (appearance) =>
        set((state) => ({
          settings: {
            ...state.settings,
            appearance: { ...state.settings.appearance, ...appearance },
          },
        })),
      updateVisionSettings: (vision) => {
        set((state) => ({
          settings: { ...state.settings, vision: { ...state.settings.vision, ...vision } },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateHomeAssistantSettings: (ha) => {
        set((state) => ({
          settings: { ...state.settings, homeAssistant: { ...state.settings.homeAssistant, ...ha } },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateAvatarSettings: (avatar) => {
        set((state) => ({
          settings: { ...state.settings, avatar: { ...state.settings.avatar, ...avatar } },
        }));
      },
      updateOwnerSettings: (owner) => {
        set((state) => ({ settings: { ...state.settings, ...owner } }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateProvidersSettings: (providers) => {
        set((state) => ({
          settings: { ...state.settings, providers },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateModelProfiles: (modelProfiles) => {
        set((state) => ({
          settings: { ...state.settings, modelProfiles },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      updateVisionProfiles: (visionProfiles) => {
        set((state) => ({
          settings: { ...state.settings, visionProfiles },
        }));
        syncSettingsToBridgeConfig(get().settings);
      },
      resetSettings: () => set({ settings: defaultSettings }),

      // Server is the source of truth. On load, OVERWRITE this device's server-
      // owned settings with the server's (skipping blank server values via the
      // same blank-preserving merge). Per-device cosmetics (appearance, avatar,
      // STT input mode) are preserved. This is what makes a stale/blank/off-site
      // browser unable to silently win — it's corrected to the server every load.
      applyServerSettings: (server) =>
        set((state) => {
          const s = state.settings;
          // clientMergePreview(device, server): server wins, but a blank/empty
          // server value keeps the device's (so a partially-configured server
          // can't blank the device, and vice-versa). undefined server slice =
          // not tracked server-side → keep device's.
          const merge = (deviceSlice: unknown, serverSlice: unknown) =>
            serverSlice === undefined ? deviceSlice : clientMergePreview(deviceSlice, serverSlice);

          const updated: AppSettings = {
            ...s,
            llm: merge(s.llm, server.llm) as typeof s.llm,
            tts: merge(s.tts, server.tts) as typeof s.tts,
            stt: merge(s.stt, server.stt) as typeof s.stt,
            imageGen: merge(s.imageGen, server.imageGen) as typeof s.imageGen,
            memory: merge(s.memory, server.memory) as typeof s.memory,
            vision: merge(s.vision, server.vision) as typeof s.vision,
            weather: merge(s.weather, server.weather) as typeof s.weather,
            search: merge(s.search, server.search) as typeof s.search,
            homeAssistant: merge(s.homeAssistant, server.homeAssistant) as typeof s.homeAssistant,
            providers: merge(s.providers, server.providers) as typeof s.providers,
            visionProfiles: merge(s.visionProfiles, server.visionProfiles) as typeof s.visionProfiles,
            modelProfiles: merge(s.modelProfiles, server.modelProfiles) as typeof s.modelProfiles,
            ownerName: (merge(s.ownerName || '', server.ownerName) as string) || s.ownerName,
            ownerLocation: (merge(s.ownerLocation || '', server.ownerLocation) as string) || s.ownerLocation,
            // Per-device cosmetics — never server-authoritative.
            appearance: s.appearance,
            avatar: s.avatar,
          };
          // STT interaction prefs stay per-device even though the STT endpoint is shared.
          updated.stt = { ...updated.stt, inputMode: s.stt.inputMode, vadSensitivity: s.stt.vadSensitivity };

          return { settings: updated, isLocalConnection: server.local !== false };
        }),

      // Off-site write flow: push the staged change to the server WITH the
      // confirm header (server requires it for remote writes), then clear.
      confirmServerSync: async () => {
        const pending = get().pendingServerSync;
        if (!pending) return;
        try {
          await postBridgeConfig(buildBridgePayload(pending.settings), true);
        } catch (e) {
          console.warn('Confirm server sync failed:', e);
        }
        set({ pendingServerSync: null });
      },
      // Drop the staged change — the server stays unchanged. On next load this
      // device re-adopts the server's values anyway.
      discardServerSync: () => set({ pendingServerSync: null }),

      // Streaming actions
      setStreamingContent: (content) => set({ streamingContent: content }),
      appendStreamingContent: (content) =>
        set((state) => ({ streamingContent: state.streamingContent + content })),
      clearStreamingContent: () => set({ streamingContent: '' }),
      setIsStreaming: (streaming) => set({ isStreaming: streaming }),

      // TTS actions
      addToTTSQueue: (text) => set((state) => ({ ttsQueue: [...state.ttsQueue, text] })),
      removeFromTTSQueue: () => {
        const queue = get().ttsQueue;
        if (queue.length === 0) return undefined;
        const [first, ...rest] = queue;
        set({ ttsQueue: rest });
        return first;
      },
      clearTTSQueue: () => set({ ttsQueue: [] }),
      setIsSpeaking: (speaking) => set({ isSpeaking: speaking }),
    }),
    {
      name: 'choom-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        currentChoomId: state.currentChoomId,
        currentChatId: state.currentChatId,
        activeProjectByChat: state.activeProjectByChat,
        settings: state.settings,
        ui: {
          isSidebarOpen: state.ui.isSidebarOpen,
          isMuted: state.ui.isMuted,
        },
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState || {}) as Record<string, unknown>;
        const defaultSettings = currentState.settings;
        const persistedSettings = persisted.settings as Partial<AppSettings> | undefined;
        // Deep merge settings: default values are base, persisted values override per-section
        const mergedSettings: AppSettings = { ...defaultSettings };
        if (persistedSettings) {
          // Merge keys that exist in defaults (nested objects get shallow-merged)
          for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
            const dv = defaultSettings[key];
            const pv = persistedSettings[key];
            if (pv && typeof dv === 'object' && !Array.isArray(dv) && typeof pv === 'object' && !Array.isArray(pv)) {
              (mergedSettings as unknown as Record<string, unknown>)[key] = { ...(dv as object), ...(pv as object) };
            } else if (pv !== undefined) {
              (mergedSettings as unknown as Record<string, unknown>)[key] = pv;
            }
          }
          // Preserve optional top-level arrays not in defaults (providers, modelProfiles, visionProfiles)
          if (persistedSettings.providers) mergedSettings.providers = persistedSettings.providers;
          if (persistedSettings.modelProfiles) mergedSettings.modelProfiles = persistedSettings.modelProfiles;
          if (persistedSettings.visionProfiles) mergedSettings.visionProfiles = persistedSettings.visionProfiles;
        }
        // Deep merge UI state
        const persistedUI = persisted.ui as Partial<UIState> | undefined;
        const mergedUI = persistedUI
          ? { ...currentState.ui, ...persistedUI }
          : currentState.ui;
        return {
          ...currentState,
          currentChoomId: (persisted.currentChoomId as string) ?? currentState.currentChoomId,
          currentChatId: (persisted.currentChatId as string) ?? currentState.currentChatId,
          activeProjectByChat: (persisted.activeProjectByChat as Record<string, string>) ?? currentState.activeProjectByChat,
          settings: mergedSettings,
          ui: mergedUI,
        };
      },
    }
  )
);

// ============================================================================
// Selectors (for optimized re-renders)
// ============================================================================

export const selectCurrentChoom = (state: AppState) => state.currentChoom;
export const selectCurrentChat = (state: AppState) => state.currentChat;
export const selectChooms = (state: AppState) => state.chooms;
export const selectChats = (state: AppState) => state.chats;
export const selectMessages = (state: AppState) => state.messages;
export const selectSettings = (state: AppState) => state.settings;
export const selectServices = (state: AppState) => state.services;
export const selectUI = (state: AppState) => state.ui;
export const selectIsStreaming = (state: AppState) => state.isStreaming;
export const selectStreamingContent = (state: AppState) => state.streamingContent;

// Computed selectors
export const selectCurrentChoomChats = (state: AppState) =>
  state.chats.filter((c) => c.choomId === state.currentChoomId && !c.archived);

export const selectArchivedChats = (state: AppState) =>
  state.chats.filter((c) => c.choomId === state.currentChoomId && c.archived);

export const selectAllServicesConnected = (state: AppState) =>
  Object.values(state.services).every((s) => s === 'connected');

export const selectCriticalServicesConnected = (state: AppState) =>
  state.services.llm === 'connected' && state.services.memory === 'connected';
