import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  getManagedTableStyles,
  getManagedTableHtml,
  getManagedTableScript,
  ManagedTableRow,
} from '../vendor/vscode-components/dist/common-webviews';
import { getFailuresDir, type FailureDump } from './deepseekFailures';

interface FailureFile {
  filePath: string;
  filename: string;
  mtime: Date;
  sizeBytes: number;
  entry?: FailureDump;
}

function listFailureFiles(): FailureFile[] {
  let dir: string;
  try {
    dir = getFailuresDir(false);
  } catch {
    return [];
  }
  if (!fs.existsSync(dir)) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      let parsed: FailureDump | undefined;
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as FailureDump;
      } catch {
        // A half-written or hand-edited file is still listed; its JSON is missing.
      }
      return {
        filePath: fullPath,
        filename: entry.name,
        mtime: stat.mtime,
        sizeBytes: stat.size,
        entry: parsed,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayTime(file: FailureFile): string {
  const when = file.entry?.timestamp ? new Date(file.entry.timestamp) : file.mtime;
  if (Number.isNaN(when.getTime())) {
    return file.mtime.toLocaleTimeString();
  }
  return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function sourceLabel(source: FailureDump['source'] | undefined): string {
  return source === 'api' ? '☁️' : '🤖';
}

function shortError(message: string | undefined): string {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 80) {
    return text;
  }
  return `${text.slice(0, 79)}…`;
}

function rowsFor(files: FailureFile[]): ManagedTableRow[] {
  return files.map((file, index) => {
    const entry = file.entry;
    return {
      id: String(index),
      cells: {
        time: displayTime(file),
        source: sourceLabel(entry?.source),
        model: entry?.model ?? '-',
        status: entry?.status === undefined ? 'network' : String(entry.status),
        reqSize: formatSize(entry?.requestSizeBytes ?? 0),
        respSize: formatSize(entry?.responseSizeBytes ?? 0),
        error: shortError(entry?.error),
      },
      meta: { filePath: file.filePath },
      className: 'clickable',
    };
  });
}

function totalsFor(files: FailureFile[]): string {
  const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return `${files.length} failure dump${files.length === 1 ? '' : 's'} · ${formatSize(bytes)}`;
}

function postTable(panel: vscode.WebviewPanel, files: FailureFile[]): void {
  panel.webview.postMessage({ type: 'logData', rows: rowsFor(files) });
  panel.webview.postMessage({ type: 'totals', text: totalsFor(files) });
}

async function revealFailuresDir(): Promise<void> {
  const dir = getFailuresDir();
  try {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  } catch {
    await vscode.env.openExternal(vscode.Uri.file(dir));
  }
}

async function showText(title: string, content: string, language: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function showFailurePart(filePath: string, part: 'request' | 'response' | 'full'): Promise<void> {
  const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString('utf8');
  if (part === 'full') {
    await showText('Failure Dump', raw, 'json');
    return;
  }
  let parsed: FailureDump;
  try {
    parsed = JSON.parse(raw) as FailureDump;
  } catch {
    await showText('Failure Dump', raw, 'plaintext');
    return;
  }
  if (part === 'request') {
    await showText('Failed Request Body', parsed.requestBody || '<empty>', 'plaintext');
  } else {
    await showText('Failed Response Body', parsed.responseBody || '<empty>', 'plaintext');
  }
}

/**
 * Register the command that opens the failure-dump browser.
 *
 * The history log browser is gone: every request used to be persisted whether it worked or not.
 * Only failures are written now, so this browses `.smartercode/deepseek-failures/`.
 */
export function registerLogBrowserCommand(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  commandId: string,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(commandId, async () => {
      openFailureBrowser(context, log);
    }),
  );
}

function openFailureBrowser(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const panel = vscode.window.createWebviewPanel(
    'deepseekFailureBrowser',
    'DeepSeek: Failed Requests',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = getHtml();

  panel.webview.onDidReceiveMessage(async (message: any) => {
    try {
      if (message?.type === 'refresh') {
        const dir = getFailuresDir();
        const files = listFailureFiles();
        output.appendLine(`[deepseek-failures] Scanning: ${dir}, found ${files.length} file(s)`);
        postTable(panel, files);
        return;
      }

      if (message?.type === 'rowSelected') {
        const filePath = String(message?.filePath || '');
        if (!filePath) {
          return;
        }
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Show Request Body', description: 'The exact JSON sent to DeepSeek' },
            { label: 'Show Response Body', description: 'The raw body DeepSeek returned' },
            { label: 'Show Full Dump', description: 'Status, error, request and response in one JSON file' },
          ],
          { title: 'Failed Request', placeHolder: 'What do you want to view?' },
        );
        if (!pick) {
          return;
        }
        if (pick.label === 'Show Request Body') {
          await showFailurePart(filePath, 'request');
        } else if (pick.label === 'Show Response Body') {
          await showFailurePart(filePath, 'response');
        } else {
          await showFailurePart(filePath, 'full');
        }
        return;
      }

      if (message?.type === 'deleteFile') {
        const filePath = String(message?.filePath || '');
        if (filePath) {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
            output.appendLine(`[deepseek-failures] Deleted: ${filePath}`);
          } catch {
            output.appendLine(`[deepseek-failures] Failed to delete: ${filePath}`);
          }
          postTable(panel, listFailureFiles());
        }
        return;
      }

      if (message?.type === 'deleteAll') {
        const confirm = await vscode.window.showWarningMessage(
          'Delete all DeepSeek failure dumps?',
          { modal: true },
          'Delete All',
        );
        if (confirm === 'Delete All') {
          const files = listFailureFiles();
          for (const file of files) {
            try {
              await vscode.workspace.fs.delete(vscode.Uri.file(file.filePath));
            } catch {
              // skip
            }
          }
          output.appendLine(`[deepseek-failures] Deleted ${files.length} file(s).`);
          postTable(panel, []);
        }
        return;
      }

      if (message?.type === 'showActionsMenu') {
        const actions = (message?.actions as Array<{ id: string; label: string }>) || [];
        if (actions.length === 0) {
          return;
        }
        const pick = await vscode.window.showQuickPick(
          actions.map((action) => ({ label: action.label, description: '', id: action.id })),
          { title: 'DeepSeek: Failed Requests', placeHolder: 'Select an action...' },
        );
        if (!pick) {
          return;
        }
        if (pick.id === 'clearLog') {
          const confirm = await vscode.window.showWarningMessage(
            'Delete all DeepSeek failure dumps?',
            { modal: true },
            'Clear All',
          );
          if (confirm === 'Clear All') {
            const files = listFailureFiles();
            for (const file of files) {
              try {
                await vscode.workspace.fs.delete(vscode.Uri.file(file.filePath));
              } catch {
                // skip
              }
            }
            output.appendLine(`[deepseek-failures] Cleared ${files.length} file(s).`);
            postTable(panel, []);
          }
        } else if (pick.id === 'openContainingFolder') {
          await revealFailuresDir();
        }
        return;
      }

      if (message?.type === 'openContainingFolder') {
        await revealFailuresDir();
        return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error || 'unknown error');
      output.appendLine(`deepseek-failures error: ${text}`);
      panel.webview.postMessage({ type: 'status', text: `Error: ${text}` });
    }
  }, undefined, context.subscriptions);

  try {
    const files = listFailureFiles();
    output.appendLine(`[deepseek-failures] ${files.length} dump(s) on open.`);
    postTable(panel, files);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error || 'unknown error');
    output.appendLine(`deepseek-failures initial load error: ${text}`);
  }
}

function getHtml(): string {
  const styles = getManagedTableStyles();
  const tableHtml = getManagedTableHtml({
    title: 'DeepSeek Failed Requests',
    columns: [
      { id: 'time', label: 'Time', width: '80px', clickable: true },
      { id: 'source', label: '', width: '30px' },
      { id: 'model', label: 'Model' },
      { id: 'status', label: 'Status', width: '72px', align: 'right' },
      { id: 'reqSize', label: 'Req.Size', width: '84px', align: 'right' },
      { id: 'respSize', label: 'Resp.Size', width: '84px', align: 'right' },
      { id: 'error', label: 'Error' },
    ],
    showTextFilter: true,
    filterPlaceholder: 'Filter failures...',
    actions: [
      { id: 'clearLog', label: 'Clear All' },
      { id: 'openContainingFolder', label: 'Open Containing Folder' },
    ],
  });
  const script = getManagedTableScript({
    reloadHandler: 'vscode.postMessage({ type: "refresh" })',
    columns: [
      { id: 'time', label: 'Time', clickable: true },
      { id: 'source', label: '' },
      { id: 'model', label: 'Model' },
      { id: 'status', label: 'Status', align: 'right' },
      { id: 'reqSize', label: 'Req.Size', align: 'right' },
      { id: 'respSize', label: 'Resp.Size', align: 'right' },
      { id: 'error', label: 'Error' },
    ],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeepSeek Failed Requests</title>
  <style>
    ${styles}
  </style>
</head>
<body>
  ${tableHtml}
  <script>
    const vscode = acquireVsCodeApi();
    ${script}

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'logData') {
        if (window.__managedTableApi) {
          window.__managedTableApi.setRows(msg.rows || []);
          window.__managedTableApi.setActionsEnabled(true);
        }
        if (window.__managedSetRefreshing) window.__managedSetRefreshing(false);
      }
      if (msg && msg.type === 'totals') {
        if (window.__managedTableApi) window.__managedTableApi.setStatus(msg.text || '');
      }
      if (msg && msg.type === 'status') {
        if (window.__managedTableApi) window.__managedTableApi.setStatus(msg.text || '');
      }
    });

    if (window.__managedTableApi) {
      window.__managedTableApi.onRowClick(function(rowId) {
        var meta = window.__managedTableApi.getRowMeta(rowId);
        if (meta && meta.filePath) {
          vscode.postMessage({ type: 'rowSelected', filePath: meta.filePath });
        }
      });
      window.__managedTableApi.onAction(function(actionId, rowId) {
        if (actionId === 'delete') {
          var meta = window.__managedTableApi.getRowMeta(rowId);
          if (meta && meta.filePath) {
            vscode.postMessage({ type: 'deleteFile', filePath: meta.filePath });
          }
        }
      });
    }

    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
}
