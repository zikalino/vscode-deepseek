import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  getManagedTableStyles,
  getManagedTableHtml,
  getManagedTableScript,
  ManagedTableRow,
} from '../vendor/vscode-components/dist/common-webviews';

const LOG_CATEGORY = 'deepseek';

/** Get the directory where history log files are stored. */
export function getHistoryDir(create = true): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open.');
  const dir = path.join(root, '.smartercode', `${LOG_CATEGORY}-history`);
  if (create) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Generate a filesystem-safe timestamp tag for log filenames. */
function timestampTag(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Pricing for cost calculation. */
const MODEL_PRICING: Record<string, { input: number; inputCacheHit: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },
  'deepseek-v4-pro':   { input: 0.435, inputCacheHit: 0.003625, output: 0.87 },
  'deepseek-chat':     { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },
  'deepseek-reasoner': { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },
};

export interface HistoryLogEntry {
  timestamp: string;
  model: string;
  source: 'api' | 'copilot';
  /** Request text (first ~500 chars as summary). */
  requestSummary: string;
  /** Full request body (raw prompt text). */
  requestBody?: string;
  /** Full response body (raw completion text). */
  responseBody?: string;
  /** Full request body size in bytes. */
  requestSizeBytes: number;
  /** Full response body size in bytes. */
  responseSizeBytes: number;
  /** Total tokens returned by API. */
  totalTokens: number;
  /** Prompt tokens. */
  promptTokens: number;
  /** Completion tokens. */
  completionTokens: number;
  /** Cache hit tokens (prompt_cache_hit_tokens). */
  cacheHitTokens: number;
  /** Cache miss tokens (prompt_cache_miss_tokens). */
  cacheMissTokens: number;
  /** Estimated cost in USD. */
  costUsd: number;
  /** Whether the response had an error. */
  hadError: boolean;
  /** Correlates request/response pairs. */
  correlationId: string;
}

/**
 * Maximum characters of request/response body kept per history entry.
 * Entries are written on every Copilot turn, and a full request body is
 * megabytes of JSON — without a cap a single workspace grows by GBs.
 */
const MAX_BODY_CHARS = 200_000;

/** Keep at most this many history files; older entries are removed. */
const MAX_HISTORY_FILES = 200;

/** Only sweep for stale entries occasionally; the directory can hold thousands of files. */
const PRUNE_EVERY = 20;
let writeCount = 0;

function truncateBody(text: string | undefined): string | undefined {
  if (!text || text.length <= MAX_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_CHARS)}\n... [TRUNCATED: ${text.length - MAX_BODY_CHARS} chars omitted]`;
}

function pruneHistory(dir: string): void {
  try {
    if (++writeCount % PRUNE_EVERY !== 0) {
      return;
    }
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => {
        const full = path.join(dir, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(MAX_HISTORY_FILES)) {
      try {
        fs.unlinkSync(stale.full);
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

/** History logging is opt-in: every turn writes a JSON entry into the workspace. */
function isHistoryLoggingEnabled(): boolean {
  try {
    return vscode.workspace
      .getConfiguration('deepseek-copilot')
      .get<boolean>('historyLogging', false);
  } catch {
    return false;
  }
}

/**
 * Write a structured JSON log entry to the history directory. Silently fails on error.
 * Disabled unless `deepseek-copilot.historyLogging` is enabled.
 */
export function writeHistoryEntry(entry: HistoryLogEntry): void {
  if (!isHistoryLoggingEnabled()) {
    return;
  }
  try {
    const dir = getHistoryDir();
    const requestBody = truncateBody(entry.requestBody);
    const responseBody = truncateBody(entry.responseBody);
    const stored: HistoryLogEntry = {
      ...entry,
      requestBody,
      responseBody,
      requestSizeBytes: requestBody === undefined
        ? entry.requestSizeBytes
        : Buffer.byteLength(requestBody, 'utf8'),
      responseSizeBytes: responseBody === undefined
        ? entry.responseSizeBytes
        : Buffer.byteLength(responseBody, 'utf8'),
    };
    const fileName = `${entry.timestamp}-${entry.model}-${entry.source}.json`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), 'utf8');
    pruneHistory(dir);
  } catch {
    // silently fail
  }
}

/** Format cost in USD. */
export function formatCost(costUsd: number): string {
  if (costUsd <= 0) return '-';
  return `$${costUsd.toFixed(5)}`;
}

/** Format token count with locale separators. */
export function formatTokens(count: number): string {
  if (count <= 0) return '-';
  return count.toLocaleString();
}

/**
 * Register the "DeepSeek: Browse Log" command.
 */
export function registerLogBrowserCommand(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  commandId: string,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(commandId, async () => {
      openLogBrowser(context, log);
    }),
  );
}

function listHistoryFiles(): Array<{
  filePath: string;
  filename: string;
  mtime: Date;
  sizeBytes: number;
  entry?: HistoryLogEntry;
}> {
  const dir = getHistoryDir(false);
  if (!fs.existsSync(dir)) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = entries
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => {
      const fullPath = path.join(dir, e.name);
      const stat = fs.statSync(fullPath);
      let entry: HistoryLogEntry | undefined;
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        entry = JSON.parse(raw) as HistoryLogEntry;
      } catch {
        // not a valid JSON log entry
      }
      return {
        filePath: fullPath,
        filename: e.name,
        mtime: stat.mtime,
        sizeBytes: stat.size,
        entry,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openLogBrowser(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const panel = vscode.window.createWebviewPanel(
    'deepseekLogBrowser',
    'DeepSeek: Log Browser',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = getHtml();

  panel.webview.onDidReceiveMessage(async (message: any) => {
    try {
      if (message?.type === 'refresh') {
        const dir = getHistoryDir();
        const files = listHistoryFiles();
        output.appendLine(`[deepseek-log-browser] Scanning: ${dir}, found ${files.length} file(s)`);
        const totalTokens = files.reduce((s, f) => s + (f.entry?.totalTokens ?? 0), 0);
        const totalCost = files.reduce((s, f) => s + (f.entry?.costUsd ?? 0), 0);
        const totalChars = files.reduce((s, f) => s + (f.entry?.responseSizeBytes ?? 0), 0);
        const totalMiss = files.reduce((s, f) => s + (f.entry?.cacheMissTokens ?? 0), 0);
        const totalHit = files.reduce((s, f) => s + (f.entry?.cacheHitTokens ?? 0), 0);
        const totalOutput = files.reduce((s, f) => s + (f.entry?.completionTokens ?? 0), 0);

        const rows: ManagedTableRow[] = files.map((f, i) => {
          const entry = f.entry;
          // Extract display time from the filename: "20260610-120000-..." -> "12:00:00"
          const timeMatch = f.filename.match(/^\d{8}-(\d{6})-/);
          const timeDisplay = timeMatch
            ? `${timeMatch[1].slice(0, 2)}:${timeMatch[1].slice(2, 4)}:${timeMatch[1].slice(4, 6)}`
            : f.mtime.toLocaleTimeString();
          // Extract source from filename
          const sourceLabel = f.filename.includes('-copilot') ? '🤖' : '☁️';
          return {
            id: String(i),
            cells: {
              time: timeDisplay,
              source: sourceLabel,
              model: entry?.model ?? '-',
              miss: formatTokens(entry?.cacheMissTokens ?? 0),
              hit: formatTokens(entry?.cacheHitTokens ?? 0),
              output: formatTokens(entry?.completionTokens ?? 0),
              cost: formatCost(entry?.costUsd ?? 0),
              reqSize: formatSize(entry?.requestSizeBytes ?? 0),
              respSize: formatSize(entry?.responseSizeBytes ?? f.sizeBytes),
            },
            meta: { filePath: f.filePath },
            className: 'clickable',
          };
        });
        // Send rows first
        panel.webview.postMessage({ type: 'logData', rows });
        // Then send totals
        panel.webview.postMessage({
          type: 'totals',
          text: `${rows.length} files | ${formatTokens(totalMiss)} Missed | ${formatTokens(totalHit)} Hits | ${formatTokens(totalOutput)} Out | ${formatCost(totalCost)} | ${formatSize(totalChars)}`,
        });
        return;
      }

      if (message?.type === 'rowSelected') {
        const filePath = String(message?.filePath || '');
        if (filePath) {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString('utf8');
          const parsed = JSON.parse(raw);
          const pick = await vscode.window.showQuickPick(
            [
              { label: 'Show Request', description: 'View the request payload sent to the API' },
              { label: 'Show Response', description: 'View the response received from the API' },
            ],
            { title: 'Log Entry', placeHolder: 'What do you want to view?' },
          );
          if (!pick) return;
          const isRequest = pick.label === 'Show Request';
          let content: string;
          if (isRequest) {
            content = parsed.requestBody
              ? `// --- Full Request Body ---\n${parsed.requestBody}`
              : JSON.stringify({ model: parsed.model, requestSummary: parsed.requestSummary, requestSizeBytes: parsed.requestSizeBytes, source: parsed.source }, null, 2);
          } else {
            content = parsed.responseBody
              ? `// --- Full Response Body ---\n${parsed.responseBody}`
              : JSON.stringify(parsed, null, 2);
          }
          const uri = vscode.Uri.parse('untitled:log-viewer.json');
          const doc = await vscode.workspace.openTextDocument(uri);
          const edit = new vscode.WorkspaceEdit();
          edit.insert(uri, new vscode.Position(0, 0), content);
          await vscode.workspace.applyEdit(edit);
          await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        }
        return;
      }

      if (message?.type === 'deleteFile') {
        const filePath = String(message?.filePath || '');
        if (filePath) {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
            output.appendLine(`[deepseek-log-browser] Deleted: ${filePath}`);
            // Refresh
            vscode.commands.executeCommand('deepseek.showLogs');
          } catch {
            output.appendLine(`[deepseek-log-browser] Failed to delete: ${filePath}`);
          }
        }
        return;
      }

      if (message?.type === 'deleteAll') {
        const confirm = await vscode.window.showWarningMessage(
          'Delete all DeepSeek log files?',
          { modal: true },
          'Delete All',
        );
        if (confirm === 'Delete All') {
          const files = listHistoryFiles();
          for (const f of files) {
            try { await vscode.workspace.fs.delete(vscode.Uri.file(f.filePath)); }
            catch { /* skip */ }
          }
          output.appendLine(`[deepseek-log-browser] Deleted ${files.length} log file(s).`);
          panel.webview.postMessage({ type: 'logData', rows: [] });
          panel.webview.postMessage({ type: 'totals', text: '0 log files · no data' });
        }
        return;
      }

      if (message?.type === 'showActionsMenu') {
        const actions = (message?.actions as Array<{ id: string; label: string }>) || [];
        if (actions.length === 0) return;
        const pick = await vscode.window.showQuickPick(
          actions.map(a => ({ label: a.label, description: '', id: a.id })),
          { title: 'DeepSeek Log Browser', placeHolder: 'Select an action...' },
        );
        if (!pick) return;

        if (pick.id === 'clearLog') {
          const confirm = await vscode.window.showWarningMessage(
            'Delete all DeepSeek log files?',
            { modal: true },
            'Clear Log',
          );
          if (confirm === 'Clear Log') {
            const files = listHistoryFiles();
            for (const f of files) {
              try { await vscode.workspace.fs.delete(vscode.Uri.file(f.filePath)); }
              catch { /* skip */ }
            }
            output.appendLine(`[deepseek-log-browser] Cleared ${files.length} log file(s).`);
            panel.webview.postMessage({ type: 'logData', rows: [] });
            panel.webview.postMessage({ type: 'totals', text: '0 log files · no data' });
          }
        } else if (pick.id === 'openContainingFolder') {
          const dir = getHistoryDir();
          try {
            const uri = vscode.Uri.file(dir);
            await vscode.commands.executeCommand('revealFileInOS', uri);
          } catch {
            vscode.env.openExternal(vscode.Uri.file(dir));
          }
        }
        return;
      }

      if (message?.type === 'openContainingFolder') {
        const dir = getHistoryDir();
        try {
          const uri = vscode.Uri.file(dir);
          await vscode.commands.executeCommand('revealFileInOS', uri);
        } catch {
          vscode.env.openExternal(vscode.Uri.file(dir));
        }
        return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error || 'unknown error');
      output.appendLine(`deepseek-log-browser error: ${text}`);
      panel.webview.postMessage({ type: 'status', text: `Error: ${text}` });
    }
  }, undefined, context.subscriptions);

  // Initial load
  try {
    const files = listHistoryFiles();
    const totalCost = files.reduce((s, f) => s + (f.entry?.costUsd ?? 0), 0);
    const totalChars = files.reduce((s, f) => s + (f.entry?.responseSizeBytes ?? 0), 0);
    const totalMiss = files.reduce((s, f) => s + (f.entry?.cacheMissTokens ?? 0), 0);
    const totalHit = files.reduce((s, f) => s + (f.entry?.cacheHitTokens ?? 0), 0);
    const totalOutput = files.reduce((s, f) => s + (f.entry?.completionTokens ?? 0), 0);
    const rows: ManagedTableRow[] = files.map((f, i) => {
      const entry = f.entry;
      const timeMatch = f.filename.match(/^\d{8}-(\d{6})-/);
      const timeDisplay = timeMatch
        ? `${timeMatch[1].slice(0, 2)}:${timeMatch[1].slice(2, 4)}:${timeMatch[1].slice(4, 6)}`
        : f.mtime.toLocaleTimeString();
      const sourceLabel = f.filename.includes('-copilot') ? '🤖' : '☁️';
      return {
        id: String(i),
        cells: {
          time: timeDisplay,
          source: sourceLabel,
          model: entry?.model ?? '-',
          miss: formatTokens(entry?.cacheMissTokens ?? 0),
          hit: formatTokens(entry?.cacheHitTokens ?? 0),
          output: formatTokens(entry?.completionTokens ?? 0),
          cost: formatCost(entry?.costUsd ?? 0),
          reqSize: formatSize(entry?.requestSizeBytes ?? 0),
          respSize: formatSize(entry?.responseSizeBytes ?? f.sizeBytes),
        },
        meta: { filePath: f.filePath },
        className: 'clickable',
      };
    });
    panel.webview.postMessage({ type: 'logData', rows });
    panel.webview.postMessage({
      type: 'totals',
      text: `${rows.length} files | ${formatTokens(totalMiss)} Missed | ${formatTokens(totalHit)} Hits | ${formatTokens(totalOutput)} Out | ${formatCost(totalCost)} | ${formatSize(totalChars)}`,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error || 'unknown error');
    output.appendLine(`deepseek-log-browser initial load error: ${text}`);
  }
}

function getHtml(): string {
  const styles = getManagedTableStyles();
  const tableHtml = getManagedTableHtml({
    title: 'DeepSeek Request Logs',
    columns: [
      { id: 'time', label: 'Time', width: '80px', clickable: true },
      { id: 'source', label: '', width: '30px' },
      { id: 'model', label: 'Model' },
      { id: 'miss', label: '(M)', width: '72px', align: 'right' },
      { id: 'hit', label: '(H)', width: '72px', align: 'right' },
      { id: 'output', label: '(O)', width: '72px', align: 'right' },
      { id: 'cost', label: 'Cost', width: '90px', align: 'right' },
      { id: 'reqSize', label: 'Req.Size', width: '90px', align: 'right' },
      { id: 'respSize', label: 'Resp.Size', width: '90px', align: 'right' },
    ],
    showTextFilter: true,
    filterPlaceholder: 'Filter logs...',
    actions: [
      { id: 'clearLog', label: 'Clear Log' },
      { id: 'openContainingFolder', label: 'Open Containing Folder' },
    ],
  });
  const script = getManagedTableScript({
    reloadHandler: 'vscode.postMessage({ type: "refresh" })',
    columns: [
      { id: 'time', label: 'Time', clickable: true },
      { id: 'source', label: '' },
      { id: 'model', label: 'Model' },
      { id: 'miss', label: '(M)', align: 'right' },
      { id: 'hit', label: '(H)', align: 'right' },
      { id: 'output', label: '(O)', align: 'right' },
      { id: 'cost', label: 'Cost', align: 'right' },
      { id: 'reqSize', label: 'Req.Size', align: 'right' },
      { id: 'respSize', label: 'Resp.Size', align: 'right' },
    ],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeepSeek Log Browser</title>
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

    // Handle row clicks
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

    // Request initial data
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
}
