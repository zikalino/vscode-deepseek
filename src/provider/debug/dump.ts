import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../logger';

function workspaceDumpDir(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, '.dump') : undefined;
}

function timestampTag(): string {
  // ISO-like but filesystem-safe: 20260602T124530-456
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Write provider input snapshots to disk for debugging.
 * copilot-<time>.json       — raw Copilot payload before conversion
 * deepseek-out-<time>.json  — DeepSeek request payload sent by this extension
 * deepseek-in-<time>.json   — raw DeepSeek SSE data received by this extension
 * All other methods (legacy segment-based) are gated by setEnabled().
 */
export class RequestDumper {
  private baseDir: string;
  private log: Logger;
  private enabled: boolean;
  private flatEnabled: boolean;
  private flatWrites = 0;

  /** Keep at most this many files per flat dump kind in the workspace `.dump/` folder. */
  private static readonly FLAT_RETENTION = 100;
  /** How many flat writes to skip between retention sweeps. */
  private static readonly PRUNE_EVERY = 5;

  constructor(_context: vscode.ExtensionContext, log: Logger) {
    // Legacy segment-based dumps go to globalStorage; flat dumps go to workspace .dump/
    this.baseDir = path.join(_context.globalStorageUri.fsPath, 'request-dumps');
    this.log = log;
    this.enabled = false;
    this.flatEnabled = false;
  }

  // ── Flat workspace dumps (opt-in; they are megabytes per request) ─────────

  /** Enable/disable the always-growing workspace `.dump/` snapshots. */
  setFlatEnabled(enabled: boolean): void {
    this.flatEnabled = enabled;
  }

  private ensureWorkspaceDumpDir(): string | undefined {
    const dir = workspaceDumpDir();
    if (!dir) return undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return undefined;
    }
    return dir;
  }

  /** Delete the oldest `<prefix>*` files so the dump folder cannot grow without bound. */
  private pruneFlat(dir: string, prefix: string): void {
    try {
      if (++this.flatWrites % RequestDumper.PRUNE_EVERY !== 0) {
        return;
      }
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
        .map((name) => {
          const full = path.join(dir, name);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      for (const stale of files.slice(RequestDumper.FLAT_RETENTION)) {
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

  private writeFlat(prefix: string, data: unknown): void {
    if (!this.flatEnabled) return;
    const dir = this.ensureWorkspaceDumpDir();
    if (!dir) return;
    try {
      const file = path.join(dir, `${prefix}-${timestampTag()}.json`);
      fs.writeFileSync(file, safeJsonStringify(data), 'utf8');
      this.pruneFlat(dir, prefix);
    } catch (err) {
      this.log.warn(`Failed to write ${prefix} dump:`, err);
    }
  }

  /** Write the raw Copilot payload (messages + options) before any conversion. */
  dumpCopilotFlat(data: unknown): void {
    this.writeFlat('copilot', data);
  }

  /** Write the converted DeepSeek wire request (outbound). */
  dumpDeepSeekOutFlat(data: unknown): void {
    this.writeFlat('deepseek-out', data);
  }

  /** Write raw streamed DeepSeek SSE payload (inbound). */
  dumpDeepSeekInFlat(data: unknown): void {
    this.writeFlat('deepseek-in', data);
  }

  /** Backward-compatible alias for older call sites. */
  dumpDeepSeekFlat(data: unknown): void {
    this.dumpDeepSeekOutFlat(data);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private ensureDir(segmentId: string): string {
    const dir = path.join(this.baseDir, segmentId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private writeJson(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, safeJsonStringify(data), 'utf8');
  }

  async dumpProviderInput(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.provider-input.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump provider input:', err);
    }
  }

  async dumpCopilotOriginalPayload(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.copilot-original-payload.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump original Copilot payload:', err);
    }
  }

  async dumpInputSnapshot(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.input.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump input snapshot:', err);
    }
  }

  async dumpResolvedSnapshot(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.resolved.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump resolved snapshot:', err);
    }
  }

  async dumpRequestPayload(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump request payload:', err);
    }
  }

  async dumpCopilotMessages(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.copilot-messages.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump Copilot messages:', err);
    }
  }

  async dumpWireRequestPayload(segmentId: string, data: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      this.writeJson(path.join(dir, '.wire-request.json'), data);
    } catch (err) {
      this.log.warn('Failed to dump wire request payload:', err);
    }
  }

  async dumpWireRequestLogFull(segmentId: string, text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      fs.writeFileSync(
        path.join(dir, '.wire-request.log.full.txt'),
        text,
        'utf8',
      );
    } catch (err) {
      this.log.warn('Failed to dump full wire request log text:', err);
    }
  }

  async appendObservation(segmentId: string, observation: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    try {
      const dir = this.ensureDir(segmentId);
      fs.appendFileSync(
        path.join(dir, '_request-observations.jsonl'),
        JSON.stringify(observation) + '\n',
        'utf8',
      );
    } catch (err) {
      this.log.warn('Failed to append observation:', err);
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}

function safeJsonStringify(data: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }

      if (typeof value === 'function') {
        return `[Function ${value.name || 'anonymous'}]`;
      }

      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      if (value && typeof value === 'object') {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }

      return value;
    },
    2,
  );
}
