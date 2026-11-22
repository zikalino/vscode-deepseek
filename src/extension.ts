import * as vscode from 'vscode';
import { ContextSelector } from './contextSelector';
import { DeepSeekClient } from './deepseekClient';
import { registerSubmitToDeepSeekCommand } from './submitToDeepSeek';
import { parseUnifiedDiffPatches } from './writebackEngine';
import {
  initializeVault,
  registerLogBrowserCommand,
  registerIterativeWorkflowCommands,
  commonActivate,
} from '../vendor/vscode-components/dist/objective-workflow';
// objectiveWorkflow removed — all iteration flow now uses createPrompt (Prompt Webview)
import { registerCopilotFeatures } from './copilot';
import { SETTINGS_NS } from './consts';
import { PromptWebviewHandle } from '../vendor/vscode-components/dist/prompt';
import { sendMessageToAgent } from './agentInteractions';
import { defaultModel, modelOptions, onSend } from './agentConfig';

function makeClientOptions() {
  const cfg = vscode.workspace.getConfiguration('deepseek');
  return {
    mode: cfg.get<'api' | 'local'>('mode', 'api'),
    apiKey: cfg.get<string>('apiKey', ''),
    apiEndpoint: cfg.get<string>('apiEndpoint', 'https://api.deepseek.com/chat/completions'),
    model: cfg.get<string>('model', 'deepseek-v4-flash') || 'deepseek-v4-flash'
  };
}

// ─── Activation ─────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  try {
  // Active prompt webview instance (tracked for send/add operations)
  let activePromptWebview: PromptWebviewHandle | undefined;

  const { log, effectiveVaultRoot } = commonActivate(context, 'DeepSeek', 'deepseek', 'DeepSeek', 'vaultPath', () => activePromptWebview);
  registerCopilotFeatures(context, log);

  const cfg = vscode.workspace.getConfiguration('deepseek');
  const defaultTags = cfg.get<string[]>('defaultContextTags', []);
  // Always include @base tag so interaction-rules.md is always injected into context
  if (!defaultTags.includes('base')) {
    defaultTags.push('base');
  }

  const globalVaultPath = cfg.get<string>('globalVaultPath', '').trim();
  const effectiveGlobalVaultRoot = globalVaultPath || undefined;
  const { vaultManager, indexRef } = await initializeVault(effectiveVaultRoot, log, context, { globalVaultRoot: effectiveGlobalVaultRoot });
  const contextSelector = new ContextSelector(defaultTags);
  const client = new DeepSeekClient(makeClientOptions(), log);

  // Shared state for API commands
  let pendingRequestText = '';
  // Will be assigned by registerSavedPromptCommands later
  let savePromptTextToVault: (text: string, name: string) => Promise<void> = async () => {};

  // Reload client config on settings change
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('deepseek')) {
      client.updateOptions(makeClientOptions());
    }
  }, null, context.subscriptions);

  registerLogBrowserCommand(context, log, 'deepseek');

  // Vault operations use sidebarProvider from registerIterativeWorkflowCommands

  registerSubmitToDeepSeekCommand(context, { contextSelector, indexRef, vaultManager, client });

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.api.addRequestText', (text?: unknown) => {
      const t = typeof text === 'string' ? text : '';
      if (!t) {
        vscode.window.showWarningMessage('deepseek.api.addRequestText: text argument is required.');
        return;
      }
      pendingRequestText += (pendingRequestText ? '\n' : '') + t;
    })
  );

  // --- End External API commands ---

  // ─── Iterative Workflow Commands (creates sidebar, registers common commands) ─
  const { savePromptTextToVault: updatedSavePrompt, sidebarProvider } = registerIterativeWorkflowCommands(context, {
    vaultManager: vaultManager as any,
    indexRef,
    allTags: indexRef.index.allTags,
    effectiveVaultRoot,
    getActivePromptWebview: () => activePromptWebview,
    checkWorkspaceFolder: true,
    sendMessageToAgent,
    defaultModel,
    modelOptions,
    parseUnifiedDiffPatches,
    log,
    onSend,
  }, 'deepseek');
  savePromptTextToVault = updatedSavePrompt;


  context.subscriptions.push(vaultManager);
  } catch (err) {
    vscode.window.showErrorMessage(`DeepSeek extension activation failed: ${String(err)}`);
  }
}

export function deactivate() {
  // cleanup handled by subscriptions
}
