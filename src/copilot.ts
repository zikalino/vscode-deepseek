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
  const dsLogger = new Logger('DeepSeek Copilot');
  const authManager = new AuthManager(context.secrets, dsLogger);

  // The public key commands. The Zero panel's key button runs the same flow, so there is one prompt
  // and one secret behind both. Registered before the provider check: a build without the
  // LanguageModelChatProvider API still needs a way to set the key.
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.setApiKey', async () => {
      const key = await authManager.promptForApiKey();
      if (key === undefined) {
        return;
      }
      if (key.length > 0) {
        void vscode.window.showInformationMessage('DeepSeek: API key saved.');
        return;
      }
      // Clearing removes the secret; the settings fallback may still hold a key, so say so rather
      // than claiming the key is gone when the next request would still find one.
      const remaining = await authManager.getApiKey();
      void vscode.window.showInformationMessage(
        remaining !== undefined
          ? 'DeepSeek: stored key cleared, but deepseek.apiKey is still set in settings.'
          : 'DeepSeek: API key cleared.',
      );
    }),
    vscode.commands.registerCommand('deepseek.clearApiKey', async () => {
      await authManager.deleteApiKey();
      void vscode.window.showInformationMessage('DeepSeek: API key cleared.');
    }),
  );

  // ─── Register DeepSeek as a Copilot LanguageModelChatProvider ──────
  if (!vscode.lm || typeof (vscode.lm as any).registerLanguageModelChatProvider !== 'function') {
    log.appendLine(
      'DeepSeek: LanguageModelChatProvider API is unavailable in this VS Code build; DeepSeek models will not appear in the chat model picker.',
    );
    return;
  }

  try {
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
