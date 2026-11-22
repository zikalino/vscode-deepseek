import type * as vscode from 'vscode';
import type { DeepSeekTool } from '../../types';
import { MAX_TOOLS, MAX_PREFLIGHT_ROUNDS } from './consts';
import { Logger } from '../../logger';

/**
 * Enforce DeepSeek API tool limits: the API rejects duplicate function names and
 * accepts at most MAX_TOOLS functions per request.
 *
 * This must never throw. `provideLanguageModelChatResponse` rejecting on its own
 * makes Copilot silently fall back to another model ("Auto"), so we trim instead.
 */
export function enforceToolLimit(tools: DeepSeekTool[], log?: Logger): DeepSeekTool[] {
  const seen = new Set<string>();
  const unique: DeepSeekTool[] = [];

  for (const tool of tools) {
    const name = tool.function?.name;
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    unique.push(tool);
  }

  if (unique.length !== tools.length) {
    log?.warn(`Dropped ${tools.length - unique.length} duplicate or unnamed tool definition(s).`);
  }

  if (unique.length > MAX_TOOLS) {
    log?.warn(`DeepSeek API accepts at most ${MAX_TOOLS} tools; dropping ${unique.length - MAX_TOOLS}.`);
    return unique.slice(0, MAX_TOOLS);
  }

  return unique;
}

/**
 * Tool list stabilization (experimental):
 * - Inspects conversation for activate_* preflight tool calls
 * - Emits missing LanguageModelToolCallParts for activators not yet called
 * - Limits to MAX_PREFLIGHT_ROUNDS per user request
 * - Reports drift notices if enablement changed
 */
export class ToolStabilizer {
  private log: Logger;
  private previousToolNames: string[] = [];

  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Process the conversation history for tool stabilization.
   * Returns: { preflightToolCalls, driftNotice, remainingTools }
   */
  process(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    tools: DeepSeekTool[],
    stabilizeEnabled: boolean,
  ): { preflightCalls: Array<{ id: string; name: string; args: string }>; driftNotice: string | null } {
    if (!stabilizeEnabled) {
      this.previousToolNames = tools.map((t) => t.function.name);
      return { preflightCalls: [], driftNotice: null };
    }

    // Find which activate_* tools have been called
    const calledActivators = new Set<string>();
    let preflightRounds = 0;

    for (const msg of messages) {
      if ((msg as any).role === 'assistant') {
        const parts = (msg as any).content ?? [];
        for (const part of parts) {
          if (part.type === 'tool_calls' || part.type === 'toolCall') {
            const calls = part.toolCalls ?? part.calls ?? [];
            for (const tc of calls) {
              if (typeof tc.name === 'string' && tc.name.startsWith('activate_')) {
                calledActivators.add(tc.name);
              }
            }
            preflightRounds++;
          }
        }
      }
    }

    // Emit missing activators
    const preflightCalls: Array<{ id: string; name: string; args: string }> = [];
    for (const tool of tools) {
      const name = tool.function.name;
      if (name.startsWith('activate_') && !calledActivators.has(name) && preflightRounds < MAX_PREFLIGHT_ROUNDS) {
        preflightCalls.push({
          id: `preflight_${name}`,
          name,
          args: '{}',
        });
      }
    }

    // Drift detection
    const currentNames = tools.map((t) => t.function.name);
    let driftNotice: string | null = null;
    if (this.previousToolNames.length > 0) {
      const added = currentNames.filter((n) => !this.previousToolNames.includes(n));
      const removed = this.previousToolNames.filter((n) => !currentNames.includes(n));
      if (added.length > 0 || removed.length > 0) {
        driftNotice = `[Tool Drift Notice: ${added.length} tools added, ${removed.length} tools removed]`;
        this.log.info('Tool drift detected:', driftNotice);
      }
    }
    this.previousToolNames = currentNames;

    return { preflightCalls, driftNotice };
  }
}
