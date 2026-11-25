import type * as vscode from 'vscode';
import type { CacheDiagnostics, DeepSeekRequest, VisionProxyStats } from '../../types';
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
    previousChars: number;
    currentChars: number;
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
