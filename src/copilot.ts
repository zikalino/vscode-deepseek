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

/**
 * Register DeepSeek Copilot features through the LanguageModelChatProvider API
 * so the DeepSeek models appear in the chat model picker.
 */
export function registerCopilotFeatures(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
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
