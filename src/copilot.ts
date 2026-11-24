import * as vscode from 'vscode';
import { Logger } from './logger';
import { AuthManager } from './auth';
import { DeepSeekChatProvider } from './provider/index';
import { MODELS, VENDOR_ID } from './consts';

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
  const providerApiAvailable =
    !!vscode.lm && typeof (vscode.lm as any).registerLanguageModelChatProvider === 'function';

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
    vscode.commands.registerCommand('deepseek.useAsDefaultModel', async () => {
      if (!providerApiAvailable) {
        void vscode.window.showWarningMessage(
          'DeepSeek: this VS Code version does not support language model chat providers.',
        );
        return;
      }
      const chatConfiguration = vscode.workspace.getConfiguration('chat');
      // `policyValue` exists at runtime but is newer than the bundled typings.
      const inspected = chatConfiguration.inspect<string>('defaultModel') as
        | { readonly policyValue?: string }
        | undefined;
      if (inspected === undefined) {
        void vscode.window.showWarningMessage(
          'DeepSeek: this VS Code version does not support the chat.defaultModel setting.',
        );
        return;
      }
      if (inspected.policyValue) {
        void vscode.window.showWarningMessage(
          'DeepSeek: chat.defaultModel is managed by your organization and cannot be changed here.',
        );
        return;
      }
      const current = chatConfiguration.get<string>('defaultModel');
      const pick = await vscode.window.showQuickPick(
        MODELS.map((model) => ({
          label: model.name,
          description: model.id === current ? `${model.id} (current default)` : model.id,
          id: model.id,
        })),
        {
          title: 'DeepSeek: Use as Default Chat Model',
          placeHolder: 'Model used for new chat conversations',
        },
      );
      if (pick === undefined) {
        return;
      }
      try {
        await chatConfiguration.update('defaultModel', pick.id, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(
          `DeepSeek: new chat conversations will start with ${pick.label}.`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `DeepSeek: could not update chat.defaultModel: ${formatError(err)}`,
        );
      }
    }),
  );

  // ─── Register DeepSeek as a Copilot LanguageModelChatProvider ──────
  if (!providerApiAvailable) {
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
