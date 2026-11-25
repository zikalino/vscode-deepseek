import * as vscode from 'vscode';
import { registerAccountCommands } from './account/commands';
import { registerCopilotFeatures } from './copilot';
import { registerAdvancePanel } from './advance/panel';
import { registerWorkflowCommand } from './advance/workflowTabs';
import { registerLogBrowserCommand } from './deepseekLogBrowser';
import { registerUsageGraphCommand } from './usageGraph';
import { initializeUsageStorage } from './usage';

// ─── Activation ─────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  try {
    const log = vscode.window.createOutputChannel('DeepSeek');
    context.subscriptions.push(log);
    log.appendLine('DeepSeek extension activating...');

    initializeUsageStorage(context.globalStorageUri.fsPath);

    registerCopilotFeatures(context, log);
    registerAdvancePanel(context);
    registerWorkflowCommand(context);
    context.subscriptions.push(...registerAccountCommands(context));
    registerLogBrowserCommand(context, log, 'deepseek.showLogs');
    registerUsageGraphCommand(context);
  } catch (err) {
    vscode.window.showErrorMessage(`DeepSeek extension activation failed: ${String(err)}`);
  }
}

export function deactivate() {
  // cleanup handled by subscriptions
}
