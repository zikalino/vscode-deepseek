import type * as vscode from 'vscode';
import type { ReplayMarkerPayload, ReasoningEntry } from '../../types';
import { Logger } from '../../logger';
import { VENDOR_ID } from '../../consts';

const MIME_TYPE = 'stateful_marker';
const ENCODER = 'deepseek-copilot';

/**
 * Parse replay markers from assistant messages to recover
 * cross-turn state (vision descriptions, reasoning content).
 */
export class ReplayEngine {
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Scan VS Code messages for replay markers and return the first found payload.
   */
  extractMarker(messages: readonly vscode.LanguageModelChatRequestMessage[]): ReplayMarkerPayload | null {
    for (const msg of messages) {
      if ((msg as any).role !== 'assistant') continue;
      const parts = (msg as any).content ?? [];
      for (const part of parts) {
        if (part.type === 'data' && part.mimeType === MIME_TYPE && part.encoder === ENCODER) {
          try {
            const decoded = base64UrlDecode(part.value);
            const parsed = JSON.parse(decoded) as ReplayMarkerPayload;
            // Legacy support: raw UUID as segmentId
            if (typeof parsed === 'string') {
              return { segmentId: parsed };
            }
            return parsed;
          } catch {
            this.log.warn('Failed to parse replay marker');
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Extract vision description text from a replay marker bound to a user message.
   */
  extractVisionText(marker: ReplayMarkerPayload | null): string | undefined {
    return marker?.vision?.text;
  }

  /**
   * Extract reasoning content from a replay marker (preferred over LanguageModelThinkingPart).
   */
  extractReasoningText(marker: ReplayMarkerPayload | null): string | undefined {
    return marker?.reasoning?.text;
  }
}

function base64UrlDecode(input: string): string {
  // Base64URL to standard Base64
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}
