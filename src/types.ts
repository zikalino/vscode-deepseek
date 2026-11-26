import type * as vscode from 'vscode';

// ─── Model definitions ─────────────────────────────────────────

export interface ModelDefinition {
  id: string;                    // vendor-specific ID (e.g. 'deepseek-v4-flash')
  apiModel: string;              // API model string (e.g. 'deepseek-v4-flash')
  name: string;                  // Display name
  maxInputTokens: number;
  maxOutputTokens: number;
  requiresThinkingParam: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;       // true = proxied via another Copilot model
  supportsImageInput: boolean;   // true = native vision
}

// ─── Configuration types ──────────────────────────────────────

export type ThinkingEffort = 'none' | 'high' | 'max';
export type TemperaturePreset = 'balanced' | 'precise' | 'creative' | 'max';
export type DebugMode = 'minimal' | 'metadata' | 'verbose';

export interface ModelConfiguration {
  reasoningEffort?: ThinkingEffort;
  temperature?: TemperaturePreset;
}

export const TEMPERATURE_VALUES: Record<TemperaturePreset, number> = {
  balanced: 1.0,
  precise: 0.2,
  creative: 1.3,
  max: 1.5,
};

// ─── DeepSeek API types ───────────────────────────────────────

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Injected from cache on multi-turn reasoning */
  reasoning_content?: string;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekRequest {
  model: string;
  messages: DeepSeekMessage[];
  stream: true;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'high' | 'max';
  temperature?: number;
  tools?: DeepSeekTool[];
  tool_choice?: 'none' | 'auto' | 'required';
  max_tokens?: number;
  stream_options: { include_usage: true };
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/**
 * `reasoning_content` sent for an earlier assistant turn whose thinking VS Code
 * does not replay. DeepSeek requires the field on every previous assistant turn
 * when the request carries `tools`, so a fixed value is sent instead of letting
 * the API reject the request. The value is constant on purpose: a turn that
 * alternates between real reasoning and this marker rewrites the wire history
 * and invalidates DeepSeek's prefix cache from that turn on.
 */
export const MISSING_REASONING_CONTENT = '(no reasoning recorded for this turn)';

// ─── Streaming types ──────────────────────────────────────────

export interface DeepSeekStreamChunk {
  choices?: {
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }[];
    };
    finish_reason?: 'stop' | 'tool_calls' | null;
  }[];
  usage?: DeepSeekUsage;
}

export interface StreamCallbacks {
  onContent: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCall: (toolCall: DeepSeekToolCall) => void;
  onSseData?: (line: string) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  onUsage?: (usage: DeepSeekUsage) => void;
}

// ─── Reasoning persistence ────────────────────────────────────

export interface ReasoningEntry {
  text: string;
  timestamp: number;
}

export interface ReasoningHistoryState {
  nextReasoningTurnIndex: number;
  entries: [string, ReasoningEntry][];
}

// ─── Replay markers ───────────────────────────────────────────

export interface ReplayMarkerPayload {
  segmentId: string;
  vision?: { text: string };
  reasoning?: { text: string };
}

// ─── Vision proxy stats ───────────────────────────────────────

export interface VisionProxyStats {
  inputImageParts: number;
  inputImageMessages: number;
  currentImageMessages: number;
  replayedImageMessages: number;
  omittedHistoricalMessages: number;
  failedMessages: number;
  unavailableMessages: number;
  droppedImageParts: number;
}

// ─── Request classification ───────────────────────────────────

export type RequestKind =
  | 'main-agent'
  | 'terminal-steering'
  | 'todo-tracker'
  | 'settings-resolver'
  | 'background'
  | 'unknown';

// ─── Cache diagnostics ────────────────────────────────────────

/** How the sent tool list differs from the previous request's list. */
export interface ToolListChange {
  added: string[];
  removed: string[];
  /** Same names, different order. */
  reordered: boolean;
  changed: boolean;
}

/**
 * The first serialized message that differs between two requests. Unlike
 * `prefixOverlap`, which compares raw VS Code text parts, this compares the
 * messages actually sent to DeepSeek — `reasoning_content`, `tool_calls` and
 * `tool_call_id` included.
 */
export interface WireDivergence {
  index: number;
  previousRole: string;
  currentRole: string;
  reason: 'role' | 'content' | 'reasoning' | 'toolCalls' | 'toolCallId';
}

export interface CacheDiagnostics {
  segmentId: string;
  segmentSource: 'markerFound' | 'markerMissing' | 'markerInvalid';
  messageCountByRole: Record<string, number>;
  toolCallArgChars: number;
  reasoningContentChars: number;
  messageContentSections: Record<string, number>;
  toolSchemaHashes: string[];
  prefixOverlapRatio?: number;
  /** Share of the serialized wire messages shared with the previous request. */
  wirePrefixOverlapRatio?: number;
  /** First wire message that differs from the previous request's. */
  wireDivergedAt?: WireDivergence;
  /** Assistant turns whose `reasoning_content` was replayed from the cache. */
  reasoningInjectedTurns?: number;
  /** Assistant turns serialized with `MISSING_REASONING_CONTENT`. */
  reasoningMarkerTurns?: number;
  visionStats?: VisionProxyStats;
  replayMarkerReported: boolean;
  /** Number of tool definitions in the serialized request. */
  toolCount?: number;
  /** Characters in the serialized tool block (the largest prefix contributor). */
  toolsChars?: number;
  /** Fingerprint of the serialized tool block, after sorting and truncation. */
  toolsHash?: string;
  /** Characters in the normalized system message. */
  systemChars?: number;
  /** Fingerprint of the normalized system message. */
  systemHash?: string;
  /** Characters in the serialized message block. */
  messageChars?: number;
  /** How the tool list differs from the previous request's. */
  toolListChange?: ToolListChange;
  /** True when the normalized system message differs from the previous request's. */
  systemChanged?: boolean;
}
