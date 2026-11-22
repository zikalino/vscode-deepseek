import * as vscode from 'vscode';
import { TokenUsage } from './deepseekClient';
import {
  buildActionableItemsFooter,
  buildCostTable,
  makeDeepSeekCostRow,
} from '../vendor/vscode-components/dist/objective-workflow';
import { computeAttachedFilesInfo } from '../vendor/vscode-components/dist/prompt';
import { parseUnifiedDiffPatches } from './writebackEngine';

export const defaultModel = 'deepseek-v4-flash';

export const modelOptions = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

export async function onSend({ activeWebview: wv, expandedContent, selectedModel, _costHistory, promptContent }: {
  activeWebview: any;
  expandedContent: string;
  selectedModel: string;
  _costHistory: any[];
  promptContent?: string;
}): Promise<void> {
  const result = await vscode.commands.executeCommand('deepseek.api.submitToDeepSeek', expandedContent, undefined, selectedModel);
  const resultObj = result && typeof result === 'object' ? result as any : undefined;
  const text = resultObj ? String(resultObj.text || '') : '';
  const usage: TokenUsage | undefined = resultObj?.usage;
  if (usage) {
    const model = selectedModel || vscode.workspace.getConfiguration('deepseek').get<string>('model', 'deepseek-v4-flash');
    const pricing = ({ 'deepseek-v4-flash': { input: 0.14, inputCacheHit: 0.0028, output: 0.28 }, 'deepseek-v4-pro': { input: 0.435, inputCacheHit: 0.003625, output: 0.87 } } as Record<string, { input: number; inputCacheHit: number; output: number }>)[model] || { input: 0.435, inputCacheHit: 0.003625, output: 0.87 };
    const pt = usage.prompt_tokens ?? 0;
    const ct = usage.completion_tokens ?? 0;
    const ch = usage.prompt_cache_hit_tokens ?? 0;
    const cm = usage.prompt_cache_miss_tokens ?? 0;
    const cost = (cm / 1_000_000) * pricing.input + (ch / 1_000_000) * pricing.inputCacheHit + (ct / 1_000_000) * pricing.output;
    const reqBytes = resultObj?.querySizeBytes ?? 0;
    const respBytes = Buffer.byteLength(text || '', 'utf8');
    const pricingLabel = model === 'deepseek-v4-pro' ? '$0.435/$0.87/M' : '$0.14/$0.28/M';
    _costHistory.push(makeDeepSeekCostRow(pt, ct, ch, reqBytes, respBytes, cost, pricingLabel, model));
  }
  wv.updateCostContent(_costHistory.length > 0 ? buildCostTable(_costHistory) : '');
  wv.updateResponseContent(text || '*No response content received*');
  wv.setRawResponse(text || '*No response*');
  if (text) {
    const attachedFilesInfo = promptContent ? await computeAttachedFilesInfo(promptContent) : undefined;
    const footerHtml = await buildActionableItemsFooter(text, { parseUnifiedDiffPatches, attachedFilesInfo });
    if (footerHtml) wv.setResponseFooter(footerHtml);
    wv.setApplyEnabled(!!footerHtml);
  } else {
    wv.setApplyEnabled(false);
  }
}
