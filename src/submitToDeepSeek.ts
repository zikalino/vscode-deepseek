import * as vscode from 'vscode';
import * as path from 'path';
import { resolveTagsToNotes, VaultIndex } from './indexEngine';
import { ContextSelector } from './contextSelector';
import { DeepSeekClient, TokenUsage } from './deepseekClient';
import { writeHistoryEntry } from './deepseekLogBrowser';
import { VaultManager } from './vaultManager';

export function registerSubmitToDeepSeekCommand(
  context: vscode.ExtensionContext,
  deps: {
    contextSelector: ContextSelector;
    indexRef: { index: VaultIndex };
    vaultManager: VaultManager;
    client: DeepSeekClient;
  }
): void {
  const { contextSelector, indexRef, vaultManager, client } = deps;

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.api.submitToDeepSeek', async (requestText?: unknown, filePaths?: unknown, modelOverride?: unknown) => {
      const text = typeof requestText === 'string' ? requestText : '';
      const selectedModel = typeof modelOverride === 'string' && modelOverride.trim()
        ? modelOverride.trim()
        : undefined;
      if (!text) {
        vscode.window.showWarningMessage('deepseek.api.submitToDeepSeek: requestText argument is required.');
        return '';
      }

      // Load attached files (explicit list from caller)
      const attachedFiles: string[] = [];
      if (Array.isArray(filePaths)) {
        for (const fp of filePaths) {
          if (typeof fp === 'string' && fp.trim()) {
            attachedFiles.push(fp.trim());
          }
        }
      }
      // Also load workspace files referenced in the text via @paths
      const refPattern = /@((?:[a-zA-Z]:[\\/]|[\\/])[^\s<>"']+\.[a-zA-Z0-9]+)/g;
      let refMatch: RegExpExecArray | null;
      while ((refMatch = refPattern.exec(text)) !== null) {
        const refPath = refMatch[1];
        if (!attachedFiles.includes(refPath)) {
          attachedFiles.push(refPath);
        }
      }

      // Normalize helper for path comparison
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();

      // Deduplicate attachedFiles (same file could come from both fileList and @-reference)
      const attachedFilesDeduped: string[] = [];
      const seenAttached = new Set<string>();
      for (const fp of attachedFiles) {
        const key = normalize(fp);
        if (!seenAttached.has(key)) { seenAttached.add(key); attachedFilesDeduped.push(fp); }
      }

      // Resolve vault notes from active tags, but skip paths already provided in fileList
      // (the workflow may have already resolved them — this avoids double-inclusion).
      const activeTags = contextSelector.getTags();
      const cfg = vscode.workspace.getConfiguration('deepseek');
      const maxNotes = cfg.get<number>('maxContextNotes', 10);
      const maxNoteLength = cfg.get<number>('maxNoteLength', 4000);
      let vaultNotes = resolveTagsToNotes(activeTags, indexRef.index, vaultManager, maxNotes, maxNoteLength);
      // Remember original vault note paths so we don't re-load them as workspace files
      const vaultNoteNormalizedPaths = new Set(vaultNotes.map(n => normalize(n.filePath)));
      vaultNotes = vaultNotes.filter(n => !seenAttached.has(normalize(n.filePath)));

      // Load workspace files — skip paths that are already vault notes
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      // Resolve ${variable} prefixes (e.g. ${patches}) using user-configured path map
      const variableFolders = vscode.workspace.getConfiguration('deepseek').get<Record<string, string>>('variableFolders', {});
      for (const fp of attachedFilesDeduped) {
        let resolvedFp = fp;
        if (variableFolders && Object.keys(variableFolders).length > 0) {
          for (const [key, value] of Object.entries(variableFolders)) {
            const resolvedValue = value.replace(/\\/g, '/').replace(/\/+$/, '');
            resolvedFp = resolvedFp.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), resolvedValue);
          }
        }
        if (vaultNoteNormalizedPaths.has(normalize(resolvedFp))) continue;

        // Resolve absolute path for vault root lookup
        const absFp = path.isAbsolute(resolvedFp)
          ? path.normalize(resolvedFp)
          : root
            ? path.join(root.fsPath, ...resolvedFp.replace(/\\/g, '/').split('/').filter(Boolean))
            : '';
        if (absFp) {
          const vaultNote = vaultManager.getNoteByPath(absFp);
          if (vaultNote) {
            vaultNotes.push(vaultNote);
            continue;
          }
        }

        try {
          let uri: vscode.Uri;
          if (path.isAbsolute(fp)) {
            uri = vscode.Uri.file(fp);
          } else if (root) {
            uri = vscode.Uri.joinPath(root, fp.replace(/\\/g, '/'));
          } else {
            continue;
          }
          const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          vaultNotes = [...vaultNotes, {
            id: fp.replace(/[^a-zA-Z0-9_-]/g, '_'),
            filePath: fp.replace(/\\/g, '/'),
            tags: [],
            type: 'workspace' as const,
            related: [],
            rawFrontmatter: {},
            content
          }];
        } catch { /* skip unreadable files */ }
      }

      // Build context bundle
      const contextBundle = { activeTags, notes: client.notesToContextNotes(vaultNotes) };

      // Send to DeepSeek directly
      const result = await client.chatOnce(contextBundle, [], text, undefined, selectedModel);
      // Log to history
      try {
        const ts = new Date();
        const pad = (n: number, w = 2) => String(n).padStart(w, '0');
        const timestamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
        const model = selectedModel || vscode.workspace.getConfiguration('deepseek').get<string>('model', 'deepseek-v4-flash');
        const pricing = ({ 'deepseek-v4-flash': { input: 0.14, inputCacheHit: 0.0028, output: 0.28 }, 'deepseek-v4-pro': { input: 0.435, inputCacheHit: 0.003625, output: 0.87 } } as Record<string, { input: number; inputCacheHit: number; output: number }>)[model] || { input: 0.435, inputCacheHit: 0.003625, output: 0.87 };
        const pt = result.usage?.prompt_tokens ?? 0;
        const ct = result.usage?.completion_tokens ?? 0;
        const ch = result.usage?.prompt_cache_hit_tokens ?? 0;
        const cm = result.usage?.prompt_cache_miss_tokens ?? 0;
        writeHistoryEntry({
          timestamp,
          model,
          source: 'api',
          requestSummary: text.slice(0, 500),
          requestBody: text,
          responseBody: result.rawBody ?? result.text,
          requestSizeBytes: result.querySizeBytes ?? 0,
          responseSizeBytes: Buffer.byteLength(result.text || '', 'utf8'),
          totalTokens: pt + ct,
          promptTokens: pt,
          completionTokens: ct,
          cacheHitTokens: ch,
          cacheMissTokens: cm,
          costUsd: (cm / 1_000_000) * pricing.input + (ch / 1_000_000) * pricing.inputCacheHit + (ct / 1_000_000) * pricing.output,
          hadError: !!result.error,
          correlationId: timestamp,
        });
      } catch { /* log silently */ }
      if (result.error) {
        vscode.window.showErrorMessage(`DeepSeek API error: ${result.error}`);
        return { text: '', usage: undefined as TokenUsage | undefined, querySizeBytes: result.querySizeBytes ?? 0 };
      }
      return { text: result.text, usage: result.usage, querySizeBytes: result.querySizeBytes ?? 0 };
    })
  );
}
