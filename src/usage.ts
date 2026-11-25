// The shared record of DeepSeek API calls behind the token-usage graph.
//
// One sample is pushed per completed API call: by the Copilot provider from its usage callback, and
// by the Zero worker (forwarded over the engine message channel). The graph is a pure view over
// this buffer, so recording never depends on the webview being open.
//
// Each VS Code window has its own extension host, and the BYOK bridge may serve a Copilot request
// in a different window from the one showing the graph. Samples are therefore appended to a
// per-instance journal file that every host writes and the graph tails, so one chart shows Copilot
// and Zero calls made anywhere in the running VS Code instance.
//
// The API is stateless and carries no chat id; a sample is just "one request's tokens", not a
// per-conversation total.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type UsageSource = "copilot" | "zero";

/** The token counts DeepSeek (or the quota proxy) reports for one request. */
export interface UsageInput {
  source: UsageSource;
  model: string;
  /** All prompt tokens, cache hit plus cache miss. */
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

/** One bar in the graph: three stacked token slices that add up to `total`. */
export interface UsageSample {
  /** Unique across processes: `<pid>:<sequence>`. */
  id: string;
  /** Milliseconds since the Unix epoch, for the tooltip. */
  at: number;
  source: UsageSource;
  model: string;
  /** The bottom slice. */
  cacheHit: number;
  /** The middle slice: uncached input. */
  cacheMiss: number;
  /** The top slice. */
  output: number;
  /** The bar's height. */
  total: number;
}

/** Older samples fall off once the buffer holds this many calls. */
export const USAGE_SAMPLE_LIMIT = 4000;

/** One incremental read of the journal. `reset` means the file was cleared or replaced. */
export interface UsageJournalSlice {
  samples: UsageSample[];
  /** Byte offset to pass to the next `read`. */
  offset: number;
  reset: boolean;
}

/**
 * An append-only history shared by every extension host of one VS Code instance. Appends are single
 * small writes, so separate processes can add samples without a lock; the reader keeps a byte offset
 * and only parses complete lines.
 */
export class UsageJournal {
  private readonly file: string;

  constructor(directory: string, instanceId: string) {
    this.file = join(directory, `usage-${instanceId}.jsonl`);
    mkdirSync(directory, { recursive: true });
    pruneOldJournals(directory, this.file);
  }

  append(sample: UsageSample): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(sample)}\n`, "utf8");
    } catch {
      // Recording must never fail a request because the history file is unavailable.
    }
  }

  clear(): void {
    try {
      writeFileSync(this.file, "", "utf8");
    } catch {
      // An unwritable history only costs the chart its past samples.
    }
  }

  read(offset: number): UsageJournalSlice {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return { samples: [], offset: 0, reset: offset > 0 };
    }
    let start = offset;
    let reset = false;
    if (size < start) {
      start = 0;
      reset = true;
    }
    if (size === start) {
      return { samples: [], offset: start, reset };
    }

    const buffer = Buffer.alloc(size - start);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.file, "r");
      readSync(descriptor, buffer, 0, buffer.length, start);
    } catch {
      return { samples: [], offset: start, reset };
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }

    // A writer may still be in the middle of a line; only consume through the last newline.
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      return { samples: [], offset: start, reset };
    }
    const complete = text.slice(0, end + 1);
    const next = start + Buffer.byteLength(complete, "utf8");
    const samples: UsageSample[] = [];
    for (const line of complete.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isUsageSample(parsed)) {
          samples.push(parsed);
        }
      } catch {
        // A torn line from an interrupted write is not worth failing the whole read.
      }
    }
    return { samples, offset: next, reset };
  }
}

let journal: UsageJournal | undefined;

/** Points the recorder at the shared journal; the graph falls back to this host when it fails. */
export function initializeUsageStorage(directory: string): void {
  try {
    journal = new UsageJournal(directory, instanceId());
  } catch {
    journal = undefined;
  }
}

export function getUsageJournal(): UsageJournal | undefined {
  return journal;
}

export class UsageRecorder {
  private readonly samples: UsageSample[] = [];
  private readonly listeners = new Set<(samples: readonly UsageSample[]) => void>();
  private nextSeq = 1;

  /** Adds one call; returns undefined when the report has no tokens to draw. */
  record(input: UsageInput): UsageSample | undefined {
    const sample = normalizeSample(input, `${process.pid}:${this.nextSeq}`);
    if (sample === undefined) {
      return undefined;
    }
    this.nextSeq += 1;
    this.samples.push(sample);
    if (this.samples.length > USAGE_SAMPLE_LIMIT) {
      this.samples.splice(0, this.samples.length - USAGE_SAMPLE_LIMIT);
    }
    journal?.append(sample);
    for (const listener of this.listeners) {
      listener([sample]);
    }
    return sample;
  }

  clear(): void {
    this.samples.length = 0;
    journal?.clear();
  }

  snapshot(): UsageSample[] {
    return [...this.samples];
  }

  /**
   * Listen for new samples. The listener gets only the samples just added, so a live view can
   * append without re-sending its whole history.
   */
  onDidRecord(listener: (samples: readonly UsageSample[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const recorder = new UsageRecorder();

export function getUsageRecorder(): UsageRecorder {
  return recorder;
}

export function recordApiUsage(input: UsageInput): void {
  recorder.record(input);
}

function normalizeSample(input: UsageInput, id: string): UsageSample | undefined {
  let cacheHit = count(input.cacheHitTokens);
  const reportedMiss =
    input.cacheMissTokens === undefined ? undefined : count(input.cacheMissTokens);
  let prompt = count(input.promptTokens);
  if (prompt === 0) {
    prompt = cacheHit + (reportedMiss ?? 0);
  }
  // A provider that reports only the miss count still tells us the hit count.
  if (cacheHit === 0 && reportedMiss !== undefined && reportedMiss <= prompt) {
    cacheHit = prompt - reportedMiss;
  }
  cacheHit = Math.min(cacheHit, prompt);
  // Every prompt token is either a hit or a miss. Forcing the split to add up keeps the three
  // stacked slices equal to the bar's height even when a provider reports inconsistent numbers.
  const cacheMiss = Math.max(0, prompt - cacheHit);
  const output = count(input.completionTokens);
  const total = prompt + output;
  if (total <= 0) {
    return undefined;
  }
  return {
    id,
    at: Date.now(),
    source: input.source,
    model: input.model,
    cacheHit,
    cacheMiss,
    output,
    total,
  };
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function instanceId(): string {
  // Every window's extension host descends from the same main process, so this id is shared by all
  // windows of one VS Code instance and differs across runs.
  return process.env.VSCODE_PID ?? String(process.ppid);
}

function isUsageSample(value: unknown): value is UsageSample {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const sample = value as Partial<UsageSample>;
  return (
    typeof sample.id === "string" &&
    typeof sample.at === "number" &&
    typeof sample.source === "string" &&
    typeof sample.model === "string" &&
    typeof sample.cacheHit === "number" &&
    typeof sample.cacheMiss === "number" &&
    typeof sample.output === "number" &&
    typeof sample.total === "number"
  );
}

const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Best-effort cleanup of journals left by earlier VS Code runs. */
function pruneOldJournals(directory: string, keep: string): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("usage-") || !entry.endsWith(".jsonl")) {
      continue;
    }
    const file = join(directory, entry);
    if (file === keep) {
      continue;
    }
    try {
      if (now - statSync(file).mtimeMs > JOURNAL_MAX_AGE_MS) {
        unlinkSync(file);
      }
    } catch {
      // Another window may be using or removing the file; leave it alone.
    }
  }
}
