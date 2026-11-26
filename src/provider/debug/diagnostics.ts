import type * as vscode from 'vscode';
import type { CacheDiagnostics, DeepSeekMessage, DeepSeekRequest, VisionProxyStats, WireDivergence } from '../../types';
import { MISSING_REASONING_CONTENT } from '../../types';
import { normalizeSessionContext } from '../convert';

/**
 * Builds a CacheDiagnostics snapshot from the incoming request.
 */
export function buildCacheDiagnostics(
  segmentId: string,
  segmentSource: 'markerFound' | 'markerMissing' | 'markerInvalid',
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  visionStats?: VisionProxyStats,
): CacheDiagnostics {
  const messageCountByRole: Record<string, number> = {};
  let toolCallArgChars = 0;
  let reasoningContentChars = 0;
  const messageContentSections: Record<string, number> = {};
  const toolSchemaHashes: string[] = [];

  // Count messages by role
  for (const msg of messages) {
    messageCountByRole[msg.role] = (messageCountByRole[msg.role] ?? 0) + 1;

    const parts = (msg as any).content ?? [];
    for (const part of parts) {
      if (part.type === 'text') {
        const text = part.value ?? '';
        // Detect system prompt sections
        const sectionMatch = text.match(/^## ([^\n]+)/gm);
        if (sectionMatch) {
          for (const s of sectionMatch) {
            const key = s.replace(/^## /, '');
            messageContentSections[key] = (messageContentSections[key] ?? 0) + 1;
          }
        }
      }
      if (part.type === 'tool_calls' || part.type === 'toolCall') {
        const calls = part.toolCalls ?? part.calls ?? [];
        for (const tc of calls) {
          const args = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {});
          toolCallArgChars += args.length;
          // Hash the tool schema
          const hash = simpleHash(`${tc.name ?? ''}:${args.slice(0, 100)}`);
          if (!toolSchemaHashes.includes(hash)) {
            toolSchemaHashes.push(hash);
          }
        }
      }
      if (part.type === 'thinking') {
        const text = Array.isArray(part.value) ? part.value.join('') : (part.value ?? '');
        reasoningContentChars += text.length;
      }
    }
  }

  return {
    segmentId,
    segmentSource,
    messageCountByRole,
    toolCallArgChars,
    reasoningContentChars,
    messageContentSections,
    toolSchemaHashes,
    visionStats,
    replayMarkerReported: segmentSource === 'markerFound',
  };
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

export interface RequestSectionStats {
  toolNames: string[];
  toolsChars: number;
  toolsHash: string;
  systemChars: number;
  systemHash: string;
  messageChars: number;
}

/**
 * Measure the request sections in the order they contribute to the cached
 * prefix. The tool block dominates a Copilot request, so a cache miss is only
 * attributable once its size and fingerprint are recorded next to the system
 * and message blocks — `prefixOverlap` alone compares messages and reports a
 * perfect 1.00 while every tool token is being re-billed.
 */
export function summarizeRequestSections(request: DeepSeekRequest): RequestSectionStats {
  const tools = request.tools ?? [];
  const toolsJson = JSON.stringify(tools);
  const systemText = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  return {
    toolNames: tools.map((tool) => tool.function.name),
    toolsChars: toolsJson.length,
    toolsHash: simpleHash(toolsJson),
    systemChars: systemText.length,
    systemHash: simpleHash(systemText),
    messageChars: JSON.stringify(request.messages).length,
  };
}

/**
 * Compare the message list of two consecutive requests.
 * `ratio` is 1.0 when the previous request is a prefix of the current one
 * (nothing was dropped or rewritten).
 */
export interface MessagePrefixComparison {
  /** Matched share of the shorter list, 0..1. */
  ratio: number;
  /** Number of leading messages that are identical. */
  matched: number;
  /** Message count of the previous request. */
  previousCount: number;
  /** Message count of the current request. */
  currentCount: number;
  /** First message that differs inside the compared range. */
  divergedAt?: {
    index: number;
    previousRole: string;
    currentRole: string;
    previousChars?: number;
    currentChars?: number;
    /** Which serialized field differs (set by `compareWireMessages`). */
    reason?: WireDivergence['reason'];
  };
}

export interface PrefixComparisonOptions {
  /** Compare system messages after session-identifier normalization (matches the wire payload). */
  normalizeSessionContext?: boolean;
}

export function compareMessagePrefix(
  prevMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined,
  currentMessages: readonly vscode.LanguageModelChatRequestMessage[],
  options?: PrefixComparisonOptions,
): MessagePrefixComparison | undefined {
  if (!prevMessages || prevMessages.length === 0) return undefined;

  const compared = Math.min(prevMessages.length, currentMessages.length);
  if (compared === 0) return undefined;

  let matched = 0;
  let divergedAt: MessagePrefixComparison['divergedAt'];

  for (let i = 0; i < compared; i++) {
    const prev = extractText(prevMessages[i], options?.normalizeSessionContext === true);
    const curr = extractText(currentMessages[i], options?.normalizeSessionContext === true);
    if (prev === curr) {
      matched++;
      continue;
    }
    divergedAt = {
      index: i,
      previousRole: String((prevMessages[i] as any)?.role ?? 'unknown'),
      currentRole: String((currentMessages[i] as any)?.role ?? 'unknown'),
      previousChars: prev.length,
      currentChars: curr.length,
    };
    break;
  }

  return {
    ratio: matched / compared,
    matched,
    previousCount: prevMessages.length,
    currentCount: currentMessages.length,
    divergedAt,
  };
}

function extractText(msg: vscode.LanguageModelChatRequestMessage, normalizeSystem: boolean): string {
  const parts = (msg as any).content ?? [];
  const text = parts
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.value ?? '')
    .join(' ');
  if (normalizeSystem && String((msg as any)?.role) === 'system') {
    return normalizeSessionContext(text);
  }
  return text;
}

interface WireMessageSignature {
  role: string;
  content: string;
  reasoning: string;
  toolCallId: string;
  toolCalls: string;
}

function wireSignature(message: DeepSeekMessage): WireMessageSignature {
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .map((call) => `${call.id}\u0000${call.function?.name ?? ''}\u0000${call.function?.arguments ?? ''}`)
        .join('\u0001')
    : '';
  return {
    role: String(message.role),
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
    toolCalls,
  };
}

/**
 * Compare the serialized messages of two consecutive requests.
 *
 * `compareMessagePrefix` only looks at raw `text` parts, so it reports a perfect
 * overlap while `reasoning_content`, `tool_calls` or tool results are being
 * rewritten — a condition that re-bills the entire conversation because
 * DeepSeek caches an exact prompt prefix. This is the view that can see that.
 */
export function compareWireMessages(
  previous: readonly DeepSeekMessage[] | undefined,
  current: readonly DeepSeekMessage[],
): MessagePrefixComparison | undefined {
  if (!previous || previous.length === 0 || current.length === 0) {
    return undefined;
  }

  const compared = Math.min(previous.length, current.length);
  let matched = 0;
  let divergedAt: MessagePrefixComparison['divergedAt'];

  for (let i = 0; i < compared; i++) {
    const before = wireSignature(previous[i]);
    const after = wireSignature(current[i]);
    const reason: WireDivergence['reason'] | undefined =
      before.role !== after.role
        ? 'role'
        : before.content !== after.content
          ? 'content'
          : before.reasoning !== after.reasoning
            ? 'reasoning'
            : before.toolCallId !== after.toolCallId
              ? 'toolCallId'
              : before.toolCalls !== after.toolCalls
                ? 'toolCalls'
                : undefined;
    if (reason === undefined) {
      matched++;
      continue;
    }
    divergedAt = {
      index: i,
      previousRole: before.role,
      currentRole: after.role,
      previousChars: before.content.length + before.reasoning.length,
      currentChars: after.content.length + after.reasoning.length,
      reason,
    };
    break;
  }

  return {
    ratio: matched / compared,
    matched,
    previousCount: previous.length,
    currentCount: current.length,
    divergedAt,
  };
}

/** How the assistant turns in a serialized request got their `reasoning_content`. */
export function countSerializedReasoning(
  messages: readonly DeepSeekMessage[],
  requireReasoningContent = false,
): {
  injected: number;
  marker: number;
} {
  let injected = 0;
  let marker = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    if (reasoning.length === 0) {
      // `normalizeMessages` fills this in whenever the request carries tools.
      if (requireReasoningContent) marker++;
      continue;
    }
    if (reasoning === MISSING_REASONING_CONTENT) marker++;
    else injected++;
  }
  return { injected, marker };
}
