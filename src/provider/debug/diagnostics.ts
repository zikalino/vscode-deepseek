import type * as vscode from 'vscode';
import type { CacheDiagnostics, VisionProxyStats } from '../../types';

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

/**
 * Compute prefix overlap ratio between two consecutive requests.
 * 1.0 = identical prefix, 0.0 = no overlap.
 */
export function computePrefixOverlapRatio(
  prevMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined,
  currentMessages: readonly vscode.LanguageModelChatRequestMessage[],
): number | undefined {
  if (!prevMessages || prevMessages.length === 0) return undefined;

  let overlap = 0;
  const maxLen = Math.min(prevMessages.length, currentMessages.length);

  for (let i = 0; i < maxLen; i++) {
    const prev = extractText(prevMessages[i]);
    const curr = extractText(currentMessages[i]);
    if (prev === curr) {
      overlap++;
    } else {
      break;
    }
  }

  return maxLen > 0 ? overlap / maxLen : undefined;
}

function extractText(msg: vscode.LanguageModelChatRequestMessage): string {
  const parts = (msg as any).content ?? [];
  return parts
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.value ?? '')
    .join(' ');
}
