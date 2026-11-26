import type { ReasoningEntry } from '../types';

/**
 * Reasoning cache keys.
 *
 * DeepSeek requires `reasoning_content` to be echoed back on every assistant
 * turn when the request carries `tools`; a missing value is a 400 ("Request
 * body format error"). Assistant turns are matched only by content-addressed
 * keys: a tool-call id first, then the response text.
 *
 * Mutating an assistant message after it has been sent breaks DeepSeek's
 * prefix cache: the cache dies where the change is and everything after it is
 * re-billed. The lookup used to fall back to a positional key, but that entry is
 * pruned while the conversation grows and is not persisted, so an old turn could
 * silently flip from real reasoning to the placeholder (`MISSING_REASONING_CONTENT`)
 * — rewriting hundreds of thousands of tokens of prefix. Positional entries are
 * still kept for inspection, but they never influence the serialized request.
 */

export function reasoningToolCallKey(toolCallId: string): string {
  return `tc:${toolCallId}`;
}

export function reasoningTextKey(text: string): string {
  return `txt:${hashText(text.trim())}`;
}

/** Positional fallback key, scoped to the conversation that produced the turn. */
export function reasoningIndexKey(conversationId: string, index: number): string {
  return `idx:${conversationId}:${index}`;
}

/** FNV-1a. Also used to fingerprint a conversation. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export interface ReasoningLookup {
  toolCallIds: readonly string[];
  text: string;
  conversationId: string;
  turnIndex: number;
  hasTextKeys: boolean;
}

export function lookupReasoning(
  reasoningCache: ReadonlyMap<string, ReasoningEntry>,
  lookup: ReasoningLookup,
): ReasoningEntry | undefined {
  for (const id of lookup.toolCallIds) {
    const entry = reasoningCache.get(reasoningToolCallKey(id));
    if (entry) return entry;
  }

  if (lookup.hasTextKeys) {
    const trimmed = lookup.text.trim();
    if (trimmed) {
      const entry = reasoningCache.get(reasoningTextKey(trimmed));
      if (entry) return entry;
    }
  }

  // Positional entries are deliberately not consulted: they are pruned as the
  // conversation grows, so using them would rewrite earlier assistant turns.
  return undefined;
}

/**
 * Positional entries kept. Content-addressed entries are never pruned: they are
 * persisted anyway, and evicting one re-serializes an old assistant turn
 * without `reasoning_content`, which drops the prompt cache from that turn on.
 */
export const MAX_POSITIONAL_REASONING_ENTRIES = 200;

export function pruneReasoningCache(
  reasoningCache: Map<string, ReasoningEntry>,
  maxPositional = MAX_POSITIONAL_REASONING_ENTRIES,
): void {
  const positional = Array.from(reasoningCache.entries())
    .filter(([key]) => isPositionalReasoningKey(key))
    .sort((a, b) => a[1].timestamp - b[1].timestamp);

  const overflow = positional.length - maxPositional;
  for (let i = 0; i < overflow; i++) {
    reasoningCache.delete(positional[i][0]);
  }
}

export function isPositionalReasoningKey(key: string): boolean {
  return key.startsWith('idx:');
}
