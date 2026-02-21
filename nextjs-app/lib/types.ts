// Core type definitions for Choom AI Companion

// ============================================================================
// Entity Types (matching Prisma schema)
// ============================================================================

export interface Choom {
  id: string;
  companionId: string | null; // Custom memory ID - if null, uses id for memory isolation
  name: string;
  description: string | null;
  avatarUrl: string | null;
  systemPrompt: string;
  imageSettings: ImageSettings | null;
  voiceId: string | null;
  llmModel: string | null;
  llmEndpoint: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Chat {
  id: string;
  title: string | null;
  choomId: string;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  messages?: Message[];
}

export interface Message {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCall[] | null;
  toolResults: ToolResult[] | null;
  createdAt: Date;
}

export interface GeneratedImage {
  id: string;
  choomId: string;
  prompt: string;
  imageUrl: string;
  settings: ImageGenerationSettings | null;
  createdAt: Date;
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
}

// ============================================================================
// Settings Types
// ============================================================================

export interface VisionSettings {
  endpoint: string;    // default: same as LLM endpoint
  model: string;       // vision model name
  maxTokens: number;   // default: 1024
  temperature: number; // default: 0.3
}

export interface LLMProviderConfig {
  id: string;              // 'local' | 'anthropic' | 'openai' | custom UUID
  name: string;            // Display name
  type: 'openai' | 'anthropic'; // API format
  endpoint: string;        // API base URL
  apiKey?: string;         // API key
  models: string[];        // Available model names
}

export interface AppSettings {
  llm: LLMSettings;
  tts: TTSSettings;
  stt: STTSettings;
  imageGen: ImageGenSettings;
  weather: WeatherSettings;
  search: SearchSettings;
  memory: MemorySettings;
  appearance: AppearanceSettings;
  vision: VisionSettings;
  homeAssistant: HomeAssistantSettings;
  providers?: LLMProviderConfig[];
}

export interface LLMSettings {
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

export interface TTSSettings {
  endpoint: string;
  defaultVoice: string;
  autoPlay: boolean;
  speed: number;
}

export interface STTSettings {
  endpoint: string;
  language: string;
  inputMode: STTInputMode;
  vadSensitivity: number;
}

export type STTInputMode = 'push-to-talk' | 'toggle' | 'vad';

export interface ImageGenSettings {
  endpoint: string;
  // General defaults
  defaultCheckpoint: string;
  defaultSampler: string;
  defaultScheduler: string;
  defaultSteps: number;
  defaultCfgScale: number;
  defaultDistilledCfg: number; // For Flux models
  defaultWidth: number;
  defaultHeight: number;
  defaultNegativePrompt: string;
  // Self-portrait specific settings
  selfPortrait: SelfPortraitSettings;
}

export interface SelfPortraitSettings {
  enabled: boolean;
  checkpoint: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfgScale: number;
  distilledCfg: number;
  width: number;
  height: number;
  negativePrompt: string;
  loras: LoraConfig[];
  promptPrefix: string; // Added before the generated prompt
  promptSuffix: string; // Added after the generated prompt
}

// Complete settings for one image generation mode
export interface ImageModeSettings {
  checkpoint?: string;
  checkpointType?: 'pony' | 'flux' | 'other';
  loras?: LoraConfig[];
  negativePrompt?: string;
  promptPrefix?: string; // Added before the prompt
  promptSuffix?: string; // Added after the prompt
  sampler?: string;
  scheduler?: string;
  steps?: number;
  cfgScale?: number;
  distilledCfg?: number;
  width?: number;
  height?: number;
  seed?: number; // -1 for random
  size?: ImageSize;
  aspect?: ImageAspect;
  upscale?: boolean;
  choomDecides?: boolean; // Let LLM pick size/aspect
}

export interface ImageSettings {
  // General image generation settings (for regular image requests)
  general?: ImageModeSettings;
  // Self-portrait settings (for generating images of the Choom itself)
  selfPortrait?: ImageModeSettings & {
    characterPrompt?: string; // Base prompt describing what the character looks like
  };
}

export interface LoraConfig {
  name: string;
  weight: number;
  triggerWords?: string;
}

export interface ImageGenerationSettings {
  prompt: string;
  negativePrompt?: string;
  checkpoint?: string;
  sampler?: string;
  scheduler?: string;
  steps?: number;
  cfgScale?: number;
  distilledCfg?: number; // For Flux models
  width?: number;
  height?: number;
  seed?: number;
  loras?: LoraConfig[];
  // Mode indicators
  isSelfPortrait?: boolean;
}

// Aspect ratio presets
export type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | 'custom';

export interface AspectRatioPreset {
  ratio: AspectRatio;
  label: string;
  width: number;
  height: number;
}

export const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { ratio: '1:1', label: 'Square (1:1)', width: 1024, height: 1024 },
  { ratio: '4:3', label: 'Landscape (4:3)', width: 1152, height: 896 },
  { ratio: '3:4', label: 'Portrait (3:4)', width: 896, height: 1152 },
  { ratio: '16:9', label: 'Wide (16:9)', width: 1344, height: 768 },
  { ratio: '9:16', label: 'Tall (9:16)', width: 768, height: 1344 },
  { ratio: '3:2', label: 'Photo (3:2)', width: 1216, height: 832 },
  { ratio: '2:3', label: 'Photo Portrait (2:3)', width: 832, height: 1216 },
];

// ============================================================================
// New Image Size/Aspect System
// ============================================================================

export type ImageSize = 'small' | 'medium' | 'large' | 'x-large';
export type ImageAspect = 'portrait' | 'portrait-tall' | 'square' | 'landscape' | 'wide';

export const IMAGE_SIZES: Record<ImageSize, number> = {
  small: 768,
  medium: 1024,
  large: 1536,
  'x-large': 1856,
};

export const IMAGE_ASPECTS: Record<ImageAspect, { ratio: string; label: string; w: number; h: number }> = {
  portrait: { ratio: '3:4', label: 'Portrait (3:4)', w: 3, h: 4 },
  'portrait-tall': { ratio: '9:16', label: 'Portrait Tall (9:16)', w: 9, h: 16 },
  square: { ratio: '1:1', label: 'Square (1:1)', w: 1, h: 1 },
  landscape: { ratio: '16:9', label: 'Landscape (16:9)', w: 16, h: 9 },
  wide: { ratio: '21:9', label: 'Wide (21:9)', w: 21, h: 9 },
};

/** Round to nearest multiple of 32 */
function roundTo32(n: number): number {
  return Math.round(n / 32) * 32;
}

/**
 * Compute image dimensions from size + aspect.
 * Size = longest side, aspect determines the ratio.
 */
export function computeImageDimensions(
  size: ImageSize,
  aspect: ImageAspect
): { width: number; height: number } {
  const longestSide = IMAGE_SIZES[size];
  const { w, h } = IMAGE_ASPECTS[aspect];

  if (w >= h) {
    // Landscape or square - width is the longest side
    const width = roundTo32(longestSide);
    const height = roundTo32(longestSide * (h / w));
    return { width, height };
  } else {
    // Portrait - height is the longest side
    const height = roundTo32(longestSide);
    const width = roundTo32(longestSide * (w / h));
    return { width, height };
  }
}

export interface WeatherSettings {
  apiKey: string;
  provider: 'openweathermap' | 'weatherapi';
  location: string;
  latitude?: number;
  longitude?: number;
  useCoordinates?: boolean;
  units: 'metric' | 'imperial';
  cacheMinutes: number;
}

export interface SearchSettings {
  provider: 'brave' | 'searxng';
  braveApiKey?: string;
  searxngEndpoint?: string;
  maxResults: number;
}

export interface MemorySettings {
  endpoint: string;
  autoRecall: boolean;
  recallLimit: number;
}

export interface HomeAssistantSettings {
  baseUrl: string;
  accessToken: string;
  entityFilter?: string;
  injectIntoPrompt: boolean;
  promptEntities?: string;
  cacheSeconds: number;
}

export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  fontSize: 'small' | 'medium' | 'large';
  animationsEnabled: boolean;
}

// ============================================================================
// Service Status Types
// ============================================================================

export type ServiceStatus = 'connected' | 'disconnected' | 'checking';

export interface ServiceHealth {
  llm: ServiceStatus;
  tts: ServiceStatus;
  stt: ServiceStatus;
  imageGen: ServiceStatus;
  memory: ServiceStatus;
  weather: ServiceStatus;
  search: ServiceStatus;
}

export interface HealthCheckResult {
  service: keyof ServiceHealth;
  status: ServiceStatus;
  latency?: number;
  error?: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ChatRequest {
  choomId: string;
  chatId: string;
  message: string;
  includeContext?: boolean;
}

export interface ChatResponse {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface StreamingChatChunk {
  type: 'content' | 'tool_call' | 'tool_result' | 'image_generated' | 'agent_iteration' | 'file_created' | 'compaction' | 'plan_created' | 'plan_step_update' | 'plan_completed' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  imageUrl?: string;
  imageId?: string;
  prompt?: string;
  error?: string;
  resolvedModel?: string;
  iteration?: number;
  maxIterations?: number;
  path?: string;
  messagesDropped?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  // Plan events (Phase 2)
  goal?: string;
  steps?: Array<{ id: string; description: string; toolName: string; status: string }>;
  stepId?: string;
  status?: string;      // Step status for plan_step_update events
  summary?: string;
  succeeded?: number;
  failed?: number;
  total?: number;
  description?: string;
  result?: string;
}

export interface TTSRequest {
  text: string;
  voiceId?: string;
  speed?: number;
}

export interface STTResult {
  text: string;
  confidence: number;
  language?: string;
}

export interface ImageGenRequest {
  prompt: string;
  choomId?: string;
  settings?: Partial<ImageGenerationSettings>;
}

export interface ImageGenResponse {
  imageUrl: string;
  seed: number;
  settings: ImageGenerationSettings;
}

// ============================================================================
// Memory Types (matching memory server API)
// ============================================================================

export interface Memory {
  id: string;
  title: string;
  content: string;
  timestamp: string;
  tags: string[];
  importance: number;
  memory_type: MemoryType;
  metadata: Record<string, unknown>;
  relevance_score?: number;
  match_type?: 'semantic' | 'semantic_fallback' | 'structured';
}

export type MemoryType = 'conversation' | 'fact' | 'preference' | 'event' | 'task' | 'ephemeral';

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  companion_id?: string;
}

export interface MemoryStoreRequest {
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  memory_type?: MemoryType;
  companion_id?: string;
}

export interface MemoryStats {
  total_memories: number;
  memory_types: number;
  avg_importance: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  type_breakdown: Record<string, number>;
  storage_size_mb: number;
  sqlite_size_mb: number;
  chroma_size_mb: number;
}

// ============================================================================
// Weather Types
// ============================================================================

export interface WeatherData {
  location: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  description: string;
  icon: string;
  windSpeed: number;
  windDirection: string;
  visibility: number;
  pressure: number;
  sunrise: string;
  sunset: string;
  updatedAt: string;
}

export interface ForecastEntry {
  datetime: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  description: string;
  icon: string;
  pop: number; // probability of precipitation (0-1)
  windSpeed: number;
  windDirection: string;
  rain?: number; // mm in 3h
  snow?: number; // mm in 3h
}

export interface ForecastData {
  location: string;
  entries: ForecastEntry[];
  updatedAt: string;
}

export interface WorkspaceSettings {
  rootPath: string;
  maxFilesPerSession: number;
  maxFileSizeKB: number;
  allowedExtensions: string[];
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
}

// ============================================================================
// Time Context Types
// ============================================================================

export interface TimeContext {
  currentTime: string;
  currentDate: string;
  dayOfWeek: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  season: 'spring' | 'summer' | 'fall' | 'winter';
  timezone: string;
  formattedDateTime: string;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterDefinition>;
    required?: string[];
  };
}

export interface ToolParameterDefinition {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: string; items?: { type: string }; properties?: Record<string, ToolParameterDefinition>; required?: string[] };
  default?: unknown;
}

// ============================================================================
// UI State Types
// ============================================================================

export interface UIState {
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isRecording: boolean;
  isMuted: boolean;
  isGeneratingImage: boolean;
  activeSettingsTab: SettingsTab;
}

export type SettingsTab = 'llm' | 'audio' | 'image' | 'memory' | 'search' | 'weather' | 'appearance' | 'scheduled' | 'heartbeat' | 'vision' | 'projects';

// ============================================================================
// Form Types
// ============================================================================

export interface ChoomFormData {
  name: string;
  description: string;
  avatarUrl: string;
  systemPrompt: string;
  voiceId: string;
  llmModel: string;
  llmEndpoint: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface APIError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ChoomError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ChoomError';
  }
}

// ============================================================================
// Log Types
// ============================================================================

export type LogLevel = 'info' | 'success' | 'warning' | 'error';
export type LogCategory = 'llm' | 'tts' | 'stt' | 'image' | 'memory' | 'agent' | 'system';

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  title: string;
  message: string;
  details?: Record<string, unknown>;
  duration?: number; // milliseconds
}

// ============================================================================
// Utility Types
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };
