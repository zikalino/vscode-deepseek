import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** Which client path produced the failure. */
export type FailureSource = 'copilot' | 'api';

/** One failed request, as written to `.smartercode/deepseek-failures/`. */
export interface FailureDump {
  /** ISO-8601 time the dump was written. */
  timestamp: string;
  /** The Copilot provider path or the direct API path. */
  source: FailureSource;
  /** The model the request named. */
  model: string;
  /** The full chat-completions URL. */
  url: string;
  /** HTTP status, or undefined when the request never got a response. */
  status?: number;
  /** HTTP status text, when there was a response. */
  statusText?: string;
  /** The error the user was shown, or the network error. */
  error: string;
  /** The exact JSON body sent to the provider. */
  requestBody: string;
  /** The raw response body; empty when the request never got a response. */
  responseBody: string;
  /** UTF-8 size of the request body. */
  requestSizeBytes: number;
  /** UTF-8 size of the response body. */
  responseSizeBytes: number;
}

/** Keep the newest dumps only; a failing provider can retry many times. */
const MAX_FAILURE_FILES = 50;

/** Makes two dumps written in the same millisecond distinct. */
let sequence = 0;

/** The directory where failed requests are dumped. */
export function getFailuresDir(create = true): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error('No workspace folder open.');
  }
  const dir = path.join(root, '.smartercode', 'deepseek-failures');
  if (create) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** A filesystem-safe local timestamp with milliseconds. */
function timestampTag(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

function safeModel(model: string): string {
  const cleaned = model.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'unknown').slice(0, 40);
}

function pruneFailures(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(MAX_FAILURE_FILES)) {
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

/**
 * Write one failed request to `.smartercode/deepseek-failures/`.
 *
 * Failures are rare, so this is unconditional: there is no setting to turn it on. Writing is
 * best-effort and never throws, because a diagnostic must not break the turn it is describing.
 */
export function writeFailureDump(
  failure: Omit<FailureDump, 'timestamp' | 'requestSizeBytes' | 'responseSizeBytes'>,
): void {
  try {
    const dir = getFailuresDir();
    const now = new Date();
    const status = failure.status === undefined ? 'network' : String(failure.status);
    const filename =
      `${timestampTag(now)}-${failure.source}-${safeModel(failure.model)}-${status}-${++sequence}.json`;
    const stored: FailureDump = {
      timestamp: now.toISOString(),
      ...failure,
      requestSizeBytes: Buffer.byteLength(failure.requestBody, 'utf8'),
      responseSizeBytes: Buffer.byteLength(failure.responseBody, 'utf8'),
    };
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(stored, null, 2), 'utf8');
    pruneFailures(dir);
  } catch {
    // A diagnostic is never worth throwing for.
  }
}
