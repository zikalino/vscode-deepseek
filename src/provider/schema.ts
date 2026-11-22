import type * as vscode from 'vscode';
import { MODELS, VENDOR_ID } from '../consts';
import type { ModelDefinition, ThinkingEffort, TemperaturePreset, DebugMode } from '../types';

/** Re-export model definitions */
export { MODELS } from '../consts';

export function getModelById(id: string): ModelDefinition | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Build the configuration schema object for VS Code model picker gear-icon dropdowns. */
export function getDebugMode(): string {
  const vscode = require('vscode');
  const cfg = vscode.workspace.getConfiguration('deepseek-copilot');
  return cfg.get('debugMode', 'minimal');
}
