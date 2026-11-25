import * as fs from 'fs';
import * as path from 'path';
import { getCacheDiagnosticsDir, type FailureLogger } from '../../deepseekFailures';
import type { CacheDiagnostics, DeepSeekUsage, ToolListChange } from '../../types';

/**
 * One significant prompt-cache miss, written to `.smartercode/deepseek-cache/`.
 *
 * A miss is only diagnosable after the fact if the sizes and fingerprints of the
 * blocks that form the cached prefix are recorded together with what changed.
 * The output channel is not durable enough for this: the record for the request
 * after a session resume is gone before the user can inspect it.
 */
export interface CacheMissRecord {
  timestamp: string;
  model: string;
  kind: string;
  segmentId: string;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** cacheHitTokens / promptTokens, 0..1. */
  hitRate: number;
  completionTokens: number;
  tools: {
    count: number;
    chars?: number;
    hash?: string;
    change?: ToolListChange;
  };
  system: {
    chars?: number;
    changed?: boolean;
  };
  messages: {
    count: number;
    chars?: number;
    prefixOverlapRatio?: number;
    toolArgChars?: number;
    reasoningChars?: number;
    byRole?: Record<string, number>;
  };
}

/** Keep a handful of records; a cache miss is rare and each record is small. */
const MAX_RECORDS = 20;
/** Below this hit rate the miss is worth keeping after the session ends. */
const MISS_HIT_RATE = 0.9;
/** Tiny prompts have noisy hit rates; ignore them. */
const MIN_PROMPT_TOKENS = 1000;

/** True when a request's cache miss is large enough to persist. */
export function shouldRecordCacheMiss(usage: DeepSeekUsage): boolean {
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
  const prompt = usage.prompt_tokens || cacheHit + cacheMiss;
  if (prompt < MIN_PROMPT_TOKENS) {
    return false;
  }
  return cacheHit / prompt < MISS_HIT_RATE;
}

/** Describe the request that just finished, using its cache diagnostics. */
export function buildCacheMissRecord(
  diagnostics: CacheDiagnostics,
  usage: DeepSeekUsage,
  model: string,
  kind: string,
): CacheMissRecord {
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = usage.prompt_cache_miss_tokens ?? 0;
  const promptTokens = usage.prompt_tokens || cacheHitTokens + cacheMissTokens;
  return {
    timestamp: new Date().toISOString(),
    model,
    kind,
    segmentId: diagnostics.segmentId,
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    hitRate: promptTokens > 0 ? cacheHitTokens / promptTokens : 0,
    completionTokens: usage.completion_tokens,
    tools: {
      count: diagnostics.toolCount ?? 0,
      chars: diagnostics.toolsChars,
      hash: diagnostics.toolsHash,
      change: diagnostics.toolListChange,
    },
    system: {
      chars: diagnostics.systemChars,
      changed: diagnostics.systemChanged,
    },
    messages: {
      count: Object.values(diagnostics.messageCountByRole).reduce((sum, n) => sum + n, 0),
      chars: diagnostics.messageChars,
      prefixOverlapRatio: diagnostics.prefixOverlapRatio,
      toolArgChars: diagnostics.toolCallArgChars,
      reasoningChars: diagnostics.reasoningContentChars,
      byRole: diagnostics.messageCountByRole,
    },
  };
}

/** Write one record, plus a stable `last-miss.json` for the most recent one. */
export function writeCacheMissRecord(record: CacheMissRecord, log?: FailureLogger): void {
  try {
    const dir = getCacheDiagnosticsDir();
    const json = JSON.stringify(record, null, 2);
    fs.writeFileSync(path.join(dir, 'last-miss.json'), json, 'utf8');
    fs.writeFileSync(path.join(dir, `miss-${timestampTag(new Date())}.json`), json, 'utf8');
    pruneRecords(dir);
  } catch (error) {
    // Diagnostics must never break the turn they describe.
    log?.warn('Failed to write DeepSeek cache-miss record:', error);
  }
}

function timestampTag(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

function pruneRecords(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith('miss-') && entry.name.endsWith('.json'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(MAX_RECORDS)) {
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
