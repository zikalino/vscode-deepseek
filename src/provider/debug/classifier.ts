import type * as vscode from 'vscode';
import type { RequestKind } from '../../types';

/**
 * Classify a request into a known kind based on system prompt content and tools.
 */
export function classifyRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): RequestKind {
  // Find system message
  const systemMsg = messages.find((m) => (m as any).role === 'system') as any;
  const systemText = systemMsg?.content?.[0]?.value ?? '';

  // Find latest user message
  const userMsgs = messages.filter((m) => (m as any).role === 'user');
  const latestUserText = userMsgs.length > 0
    ? extractText(userMsgs[userMsgs.length - 1])
    : '';

  // Terminal steering
  if (/^\[Terminal\s+\S+\s+notification:/i.test(latestUserText)) {
    return 'terminal-steering';
  }

  // Todo tracker
  const toolNames = (tools ?? []).map((t: any) => t.definition?.name ?? t.name ?? '');
  if (toolNames.length === 1 && toolNames[0] === 'manage_todo_list') {
    return 'todo-tracker';
  }
  if (/^You are a background task tracker/i.test(systemText)) {
    return 'todo-tracker';
  }

  // Settings resolver
  if (/^You are a Visual Studio Code assistant/i.test(systemText)) {
    return 'settings-resolver';
  }

  // Main agent
  if (
    /^You are an expert AI programming assistant/i.test(systemText) ||
    systemText.includes('<skills>') ||
    systemText.includes('<agents>')
  ) {
    return 'main-agent';
  }

  // Background
  if ((tools && tools.length > 0) || latestUserText.length > 0) {
    return 'background';
  }

  return 'unknown';
}

function extractText(msg: vscode.LanguageModelChatRequestMessage): string {
  const parts = (msg as any).content ?? [];
  return parts
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.value ?? '')
    .join(' ');
}
