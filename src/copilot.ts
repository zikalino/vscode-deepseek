import * as vscode from 'vscode';
import { Logger } from './logger';
import { AuthManager } from './auth';
import { DeepSeekChatProvider } from './provider/index';
import { VENDOR_ID } from './consts';

function formatError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || error);
  }
  return String(error || 'unknown');
}

function registerChatParticipant(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
    log.appendLine('DeepSeek diagnostics: Chat participant API unavailable in this VS Code build.');
    return;
  }

  try {
    const participant = vscode.chat.createChatParticipant('smartercode.deepseekParticipant', async (request, _chatContext, stream, _token) => {
      const prompt = String(request?.prompt || '').trim();
      log.appendLine(
        `DeepSeek chat participant request: prompt="${prompt}" command="${String(request?.command || '')}" references=${request?.references?.length || 0}`
      );

      if (!prompt || prompt.toLowerCase() === 'open' || prompt.toLowerCase() === 'view') {
        await vscode.commands.executeCommand('workbench.action.chat.open');
        stream.markdown('Opened the VS Code chat panel.');
        return;
      }

      stream.markdown([
        'DeepSeek chat participant is active.',
        '',
        'For full DeepSeek features (context tags, note writeback, and diagnostics), run `DeepSeek: Open Chat`.',
        'I also logged this request to the `DeepSeek` output channel.'
      ].join('\n'));
    });

    participant.iconPath = new vscode.ThemeIcon('comment-discussion');
    context.subscriptions.push(participant);
    log.appendLine('DeepSeek diagnostics: chat participant registered as @deepseek (id: smartercode.deepseekParticipant).');
  } catch (err) {
    log.appendLine(`DeepSeek diagnostics: failed to register chat participant: ${formatError(err)}`);
  }
}

/**
 * Register DeepSeek Copilot features:
 * - Chat participant (@deepseek in VS Code Chat)
 * - LanguageModelChatProvider for Copilot integration
 */
export function registerCopilotFeatures(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  registerChatParticipant(context, log);

  // ─── Register DeepSeek as a Copilot LanguageModelChatProvider ──────
  if (!vscode.lm || typeof (vscode.lm as any).registerLanguageModelChatProvider !== 'function') {
    log.appendLine(
      'DeepSeek: LanguageModelChatProvider API is unavailable in this VS Code build; DeepSeek models will not appear in the chat model picker.',
    );
    return;
  }

  const dsLogger = new Logger('DeepSeek Copilot');
  try {
    const authManager = new AuthManager(context.secrets, dsLogger);
    const copilotProvider = new DeepSeekChatProvider(context, authManager, dsLogger);

    const disposable = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, copilotProvider);
    context.subscriptions.push(disposable);
    dsLogger.info('DeepSeek Copilot provider registered.');

    // VS Code snapshots the model list when a chat session starts. If that happened
    // before this window activated us, re-announcing gives it a chance to refresh
    // instead of staying stuck on "Auto".
    setTimeout(() => copilotProvider.notifyModelsChanged(), 0);
  } catch (err) {
    dsLogger.warn('Failed to register DeepSeek Copilot provider:', err);
    log.appendLine(`DeepSeek: Copilot provider registration failed: ${formatError(err)}`);
  }
}
