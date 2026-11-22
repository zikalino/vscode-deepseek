import type * as vscode from 'vscode';
import {
  type DeepSeekMessage,
  type DeepSeekTool,
  type DeepSeekToolCall,
  type ThinkingEffort,
  type TemperaturePreset,
  type ReasoningEntry,
  TEMPERATURE_VALUES,
} from '../types';
import { VENDOR_ID, SETTINGS_NS } from '../consts';

// ─── Reasoning cache keys ─────────────────────────────────────

/**
 * Reasoning cache keys. DeepSeek requires `reasoning_content` to be echoed back
 * on every assistant turn when the request carries `tools`; a missing value is a
 * 400 ("Request body format error"). Assistant turns are matched by tool-call id
 * first (stable across requests), then by response text, then by position.
 */
export function reasoningToolCallKey(toolCallId: string): string {
  return `tc:${toolCallId}`;
}

export function reasoningTextKey(text: string): string {
  return `txt:${hashText(text.trim())}`;
}

export function reasoningIndexKey(index: number): string {
  return `idx:${index}`;
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function lookupReasoning(
  reasoningCache: Map<string, ReasoningEntry>,
  toolCallIds: string[],
  text: string,
  turnIndex: number,
  hasTextKeys: boolean,
): ReasoningEntry | undefined {
  for (const id of toolCallIds) {
    const entry = reasoningCache.get(reasoningToolCallKey(id));
    if (entry) return entry;
  }

  if (hasTextKeys) {
    const trimmed = text.trim();
    if (trimmed) {
      const entry = reasoningCache.get(reasoningTextKey(trimmed));
      if (entry) return entry;
    }
  }

  return reasoningCache.get(reasoningIndexKey(turnIndex));
}

// ─── Message conversion ───────────────────────────────────────

/**
 * Convert VS Code chat request messages to DeepSeek API message format.
 * Injects reasoning_content from the reasoning cache for assistant messages.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  reasoningCache: Map<string, ReasoningEntry>,
): DeepSeekMessage[] {
  const result: DeepSeekMessage[] = [];
  let assistantTurnIndex = 0;
  const pendingToolCallIds: string[] = [];
  let hasTextReasoningKeys = false;
  for (const key of reasoningCache.keys()) {
    if (key.startsWith('txt:')) {
      hasTextReasoningKeys = true;
      break;
    }
  }

  for (const msg of messages) {
    const role = normalizeRole((msg as any).role);
    if (!role) {
      continue;
    }

    if (role === 'system' || role === 'user') {
      const toolResultPart = findToolResultPart(msg);
      if (toolResultPart) {
        const toolCallId = consumePendingToolCallId(pendingToolCallIds, toolResultPart.toolCallId);
        if (!toolCallId) {
          continue;
        }
        result.push({
          role: 'tool',
          content: toolResultPart.content ?? '',
          tool_call_id: toolCallId,
        });
        continue;
      }

      // New VS Code payloads may drift and emit tool results as user text turns.
      // If a tool result is expected, coerce the next non-system message into a tool role.
      if (role === 'user' && pendingToolCallIds.length > 0) {
        const toolCallId = consumePendingToolCallId(pendingToolCallIds);
        if (toolCallId) {
          result.push({
            role: 'tool',
            content: getMessageText(msg),
            tool_call_id: toolCallId,
          });
          continue;
        }
      }

      const text = getMessageText(msg);
      if (!text) {
        continue;
      }
      result.push({
        role,
        content: text,
      });
    } else if (role === 'assistant') {
      const assistant: DeepSeekMessage = {
        role: 'assistant',
        content: '',
      };

      // Extract parts: text, tool_calls, thinking
      const contents: string[] = [];
      const toolCalls: DeepSeekToolCall[] = [];
      let partReasoning = '';

      // content may be a plain string (VS Code API shape drift)
      const rawContent = (msg as any).content;
      const contentParts: any[] = typeof rawContent === 'string'
        ? [{ type: 'text', value: rawContent }]
        : (Array.isArray(rawContent) ? rawContent : []);

      for (const part of contentParts) {
        if (isTextPart(part)) {
          contents.push(getPartText(part));
        } else if (isDirectToolCallObject(part)) {
          const args = normalizeToolCallArgs(part.input);
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: args,
            },
          });
        } else if (isToolCallPart(part)) {
          const calls = part.toolCalls ?? part.calls ?? [];
          for (const tc of calls) {
            const toolCallId = typeof tc?.id === 'string' ? tc.id : '';
            const toolCallName = typeof (tc?.name ?? tc?.function?.name) === 'string'
              ? (tc.name ?? tc.function?.name)
              : '';
            if (!toolCallId || !toolCallName) {
              continue;
            }
            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: toolCallName,
                arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
              },
            });
          }
        } else if (isThinkingPart(part)) {
          const thinkingText = getPartText(part);
          if (!partReasoning) {
            partReasoning = thinkingText;
          }
        } else {
          const fallbackText = getPartText(part);
          if (fallbackText.trim()) {
            contents.push(fallbackText);
          }
        }
      }

      const assistantContent = contents.join('\n');
      const hasAssistantText = assistantContent.trim().length > 0;
      if (!hasAssistantText && toolCalls.length === 0) {
        continue;
      }

      // Thinking parts are authoritative; fall back to the reasoning cache for
      // turns where VS Code does not replay thinking back to the provider.
      const cached = lookupReasoning(
        reasoningCache,
        toolCalls.map((tc) => tc.id),
        assistantContent,
        assistantTurnIndex,
        hasTextReasoningKeys,
      );
      const reasoning = partReasoning || cached?.text || '';
      if (reasoning.trim().length > 0) {
        assistant.reasoning_content = reasoning;
      }

      assistant.content = hasAssistantText ? assistantContent : '';
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls;
        pendingToolCallIds.push(...toolCalls.map((tc) => tc.id));
      }

      result.push(assistant);
      assistantTurnIndex++;
    } else if (role === 'tool') {
      const toolResultPart = findToolResultPart(msg);
      const explicitToolCallId = toolResultPart?.toolCallId ?? getToolCallIdFromMessage(msg);
      const toolCallId = consumePendingToolCallId(pendingToolCallIds, explicitToolCallId);
      if (!toolCallId) {
        continue;
      }
      result.push({
        role: 'tool',
        content: toolResultPart?.content ?? getMessageText(msg),
        tool_call_id: toolCallId,
      });
    }
  }

  return result;
}

function getToolCallIdFromMessage(msg: vscode.LanguageModelChatRequestMessage): string {
  const m = msg as any;
  const candidates = [m?.toolCallId, m?.tool_call_id, m?.callId, m?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

function consumePendingToolCallId(pendingToolCallIds: string[], preferredId?: string): string {
  if (typeof preferredId === 'string' && preferredId.length > 0) {
    const idx = pendingToolCallIds.indexOf(preferredId);
    if (idx >= 0) {
      pendingToolCallIds.splice(idx, 1);
      return preferredId;
    }
    // The matching assistant tool_calls message was dropped during conversion.
    // Emitting the tool result anyway produces an orphan tool_call_id, which
    // DeepSeek rejects with "Request body format error".
    return '';
  }

  const next = pendingToolCallIds.shift();
  return typeof next === 'string' ? next : '';
}

function getMessageText(msg: vscode.LanguageModelChatRequestMessage): string {
  const rawContent = (msg as any).content;
  if (typeof rawContent === 'string') {
    return rawContent;
  }

  const parts = Array.isArray(rawContent) ? rawContent : [];
  const textParts: string[] = [];

  for (const part of parts) {
    if (!isTextPart(part)) {
      continue;
    }
    const text = getPartText(part).trim();
    if (text) {
      textParts.push(text);
    }
  }

  if (textParts.length > 0) {
    return textParts.join('\n');
  }

  // Fallback for API shape drift: recover textual values from any non-data part.
  const fallbackTexts: string[] = [];
  for (const part of parts) {
    if (isDataPart(part) || isToolCallPart(part) || isToolResultPart(part)) {
      continue;
    }
    const text = getPartText(part).trim();
    if (text) {
      fallbackTexts.push(text);
    }
  }
  return fallbackTexts.join('\n');
}

function normalizeRole(role: unknown): DeepSeekMessage['role'] | undefined {
  if (typeof role === 'string') {
    const lowered = role.toLowerCase();
    if (lowered === 'system' || lowered === 'user' || lowered === 'assistant' || lowered === 'tool') {
      return lowered;
    }
    return undefined;
  }

  if (typeof role === 'number') {
    // VS Code enum values: User=1, Assistant=2, System=3, Tool=4.
    if (role === 1) return 'user';
    if (role === 2) return 'assistant';
    if (role === 3) return 'system';
    if (role === 4) return 'tool';
  }

  return undefined;
}

function resolvePartType(part: any): string {
  if (typeof part?.type === 'string' && part.type) {
    return part.type.toLowerCase();
  }
  if (typeof part?.kind === 'string' && part.kind) {
    return part.kind.toLowerCase();
  }
  const ctorName = typeof part?.constructor?.name === 'string'
    ? part.constructor.name.toLowerCase()
    : '';
  if (ctorName.includes('textpart')) return 'text';
  if (ctorName.includes('thinkingpart')) return 'thinking';
  if (ctorName.includes('toolcallpart')) return 'toolcall';
  if (ctorName.includes('toolresultpart')) return 'toolresult';
  if (ctorName.includes('datapart')) return 'data';
  return '';
}

function isTextPart(part: any): boolean {
  const t = resolvePartType(part);
  return t === 'text' || t === 'prompt' || t === 'markdown';
}

function isThinkingPart(part: any): boolean {
  return resolvePartType(part) === 'thinking';
}

function isToolCallPart(part: any): boolean {
  const t = resolvePartType(part);
  return t === 'tool_calls' || t === 'toolcall';
}

function isDirectToolCallObject(part: any): part is { callId: string; name: string; input?: unknown } {
  return !!part &&
    typeof part === 'object' &&
    typeof part.callId === 'string' &&
    part.callId.length > 0 &&
    typeof part.name === 'string' &&
    part.name.length > 0;
}

function isToolResultPart(part: any): boolean {
  const t = resolvePartType(part);
  return t === 'tool_result' || t === 'toolresult';
}

function isDataPart(part: any): boolean {
  return resolvePartType(part) === 'data';
}

function getPartText(part: any): string {
  if (!part || typeof part !== 'object') {
    return '';
  }

  if (typeof part?.value === 'string') {
    return part.value;
  }
  if (typeof part?.value?.value === 'string') {
    return part.value.value;
  }
  if (typeof part?.value?.text === 'string') {
    return part.value.text;
  }
  if (Array.isArray(part?.value)) {
    return part.value
      .map((v: unknown) => {
        if (typeof v === 'string') {
          return v;
        }
        if (v && typeof v === 'object') {
          const vv = v as any;
          if (typeof vv.value === 'string') return vv.value;
          if (typeof vv.text === 'string') return vv.text;
        }
        return '';
      })
      .join('');
  }
  if (typeof part?.text === 'string') {
    return part.text;
  }
  if (typeof part?.markdown === 'string') {
    return part.markdown;
  }
  if (typeof part?.message === 'string') {
    return part.message;
  }
  if (typeof part?.content === 'string') {
    return part.content;
  }

  // Extract text from nested payloads used by some VS Code chat message shapes.
  if (Array.isArray(part?.content)) {
    const nested = part.content
      .map((p: unknown) => getPartText(p as any))
      .filter((t: string) => t.trim().length > 0);
    if (nested.length > 0) {
      return nested.join('\n');
    }
  }

  const deepTexts = collectTextValues(part);
  if (deepTexts.length > 0) {
    return deepTexts.join('\n');
  }

  return '';
}

function collectTextValues(value: unknown, depth: number = 0): string[] {
  if (depth > 4 || value == null) {
    return [];
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextValues(item, depth + 1));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const obj = value as Record<string, unknown>;
  const keys = ['value', 'text', 'markdown', 'message', 'content'];
  const out: string[] = [];

  for (const key of keys) {
    if (key in obj) {
      out.push(...collectTextValues(obj[key], depth + 1));
    }
  }

  return out;
}

function normalizeToolCallArgs(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}

function findToolResultPart(msg: vscode.LanguageModelChatRequestMessage): { content: string; toolCallId: string } | undefined {
  const parts = (msg as any).content ?? [];
  for (const p of parts) {
    if (isToolResultPart(p)) {
      return {
        content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? ''),
        toolCallId: p.toolCallId ?? p.tool_call_id ?? p.callId ?? p.id ?? '',
      };
    }

    if (p && typeof p === 'object' && typeof (p as any).callId === 'string') {
      const content = getPartText(p);
      if (content.trim()) {
        return {
          content,
          toolCallId: (p as any).callId,
        };
      }
    }
  }
  return undefined;
}

function normalizeToolParametersSchema(schema: unknown): Record<string, unknown> {
  const fallback: Record<string, unknown> = {
    type: 'object',
    properties: {},
  };

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return fallback;
  }

  const normalized = { ...(schema as Record<string, unknown>) };
  const typeValue = normalized.type;

  if (typeValue !== undefined && typeValue !== 'object') {
    return fallback;
  }

  normalized.type = 'object';

  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }

  return normalized;
}

// ─── Tool conversion ──────────────────────────────────────────

/** Map VS Code LanguageModelChatTool to DeepSeek tool format. */
export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): DeepSeekTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools
    .filter((t) => {
      const def = (t as any).definition ?? t;
      return def?.name;
    })
    .map((t) => {
      const def = (t as any).definition ?? t;
      return {
        type: 'function' as const,
        function: {
          name: def.name,
          description: def.description ?? '',
          parameters: normalizeToolParametersSchema(def.inputSchema ?? def.parameters),
        },
      };
    });
}

// ─── Configuration helpers ────────────────────────────────────

/** Extract thinking effort from VS Code options bag. */
export function getConfiguredThinkingEffort(options: any): ThinkingEffort {
  const effort = options?.modelConfiguration?.reasoningEffort ??
    options?.configuration?.reasoningEffort ??
    'high';
  if (effort === 'none' || effort === 'high' || effort === 'max') return effort;
  return 'high';
}

/** Extract temperature value from VS Code options bag. Three-tier resolution. */
export function getConfiguredTemperature(options: any): number | undefined {
  const preset: string = options?.modelConfiguration?.temperature ??
    options?.configuration?.temperature ??
    'balanced';

  return normalizeTemperatureValue(preset);
}

/** Resolve a temperature preset/keyword/value to a number. */
export function normalizeTemperatureValue(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Math.max(0, Math.min(2, value));
  }
  if (typeof value !== 'string') return undefined;

  const lower = value.toLowerCase();
  if (lower === 'custom') {
    const cfg = require('vscode').workspace.getConfiguration(SETTINGS_NS);
    const customTemp: number = cfg.get('temperature', 1.0);
    return Math.max(0, Math.min(2, customTemp));
  }

  if (lower in TEMPERATURE_VALUES) {
    return TEMPERATURE_VALUES[lower as TemperaturePreset];
  }

  // Try parsing as a numeric string
  const num = parseFloat(lower);
  if (!isNaN(num)) {
    return Math.max(0, Math.min(2, num));
  }

  return undefined;
}

/** Count approximate characters in messages (used for chars/token calibration). */
export function countMessageChars(messages: DeepSeekMessage[]): number {
  return messages.reduce((sum, m) => {
    let chars = (m.content ?? '').length;
    if (m.reasoning_content) chars += m.reasoning_content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
    return sum + chars;
  }, 0);
}
