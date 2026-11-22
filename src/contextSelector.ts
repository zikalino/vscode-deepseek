import * as vscode from 'vscode';

export type ContextTag = string;

export class ContextSelector {
  private currentContext: Set<ContextTag>;
  private onChangeEmitter = new vscode.EventEmitter<Set<ContextTag>>();
  readonly onContextChanged = this.onChangeEmitter.event;

  constructor(defaultTags: string[] = []) {
    this.currentContext = new Set(defaultTags);
  }

  getTags(): string[] {
    return Array.from(this.currentContext);
  }

  setTags(tags: string[]): void {
    this.currentContext = new Set(tags);
    this.onChangeEmitter.fire(new Set(this.currentContext));
  }

  addTags(tags: string[]): void {
    for (const t of tags) {
      this.currentContext.add(t);
    }
    this.onChangeEmitter.fire(new Set(this.currentContext));
  }

  removeTags(tags: string[]): void {
    for (const t of tags) {
      this.currentContext.delete(t);
    }
    this.onChangeEmitter.fire(new Set(this.currentContext));
  }

  clearTags(defaultTags: string[] = []): void {
    this.currentContext = new Set(defaultTags);
    this.onChangeEmitter.fire(new Set(this.currentContext));
  }

  hasTags(): boolean {
    return this.currentContext.size > 0;
  }

  getSummary(): string {
    if (this.currentContext.size === 0) {
      return 'No active context';
    }
    return Array.from(this.currentContext).map(t => `@${t}`).join(', ');
  }

  /**
   * Parse a user message for context intents and return an action object.
   */
  parseIntent(message: string): ContextIntent | null {
    const lower = message.toLowerCase().trim();

    // Clear / reset
    if (/^(clear|reset)\s+context/.test(lower) || lower === 'clear context' || lower === 'reset context') {
      return { action: 'clear', tags: [] };
    }

    // Query
    if (/what('s| is| are)?\s+(my\s+)?(current\s+)?context|which tags are active/i.test(message)) {
      return { action: 'query', tags: [] };
    }

    // Extract @tags from message
    const mentioned = extractTags(message);
    if (mentioned.length === 0) {
      return null;
    }

    // Remove / exclude
    if (/\b(exclude|stop using|remove)\b/.test(lower)) {
      return { action: 'remove', tags: mentioned };
    }

    // Add / include
    if (/\b(also include|add|include)\b/.test(lower)) {
      return { action: 'add', tags: mentioned };
    }

    // Focus / set
    if (/\b(focus on|i want to work|work on|set context|focus)\b/.test(lower)) {
      return { action: 'set', tags: mentioned };
    }

    return null;
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}

export interface ContextIntent {
  action: 'set' | 'add' | 'remove' | 'clear' | 'query';
  tags: string[];
}

export function extractTags(message: string): string[] {
  const matches = message.match(/@([\w-]+)/g);
  if (!matches) {
    return [];
  }
  return matches.map(m => m.slice(1));
}

/**
 * Extract inline workspace file references from a message.
 * Detects @path/to/file patterns (tokens containing at least one '/').
 * These are distinct from vault context tags, which are plain words.
 * Backslash path separators (Windows) are normalized to forward slashes.
 *
 * Examples:
 *   "@src/extension.ts" → ["src/extension.ts"]
 *   "@vscode-extensions/vscode-deepseek/src/chatWebview.ts" → ["vscode-extensions/vscode-deepseek/src/chatWebview.ts"]
 */
export function extractFileRefs(message: string): string[] {
  // Match @token where token contains at least one '/' (forward slash), indicating a file path.
  // Backslashes are also accepted before normalization to support Windows-style paths.
  const matches = message.match(/@([\w./\\-]+\/[\w./\\-]+)/g);
  if (!matches) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    // Normalize path separators to forward slashes for cross-platform consistency.
    const filePath = m.slice(1).replace(/\\/g, '/');
    if (!seen.has(filePath)) {
      seen.add(filePath);
      result.push(filePath);
    }
  }
  return result;
}
