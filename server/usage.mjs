// Token accounting for the quota proxy.
//
// DeepSeek reports usage once per response: a `usage` object on the JSON body, or (when
// `stream_options.include_usage` is set) one final `data:` frame on an SSE stream. That final frame
// has an empty `choices` array, so it is easy to miss — the meter looks at every frame and keeps
// the largest reported total.

/**
 * Total tokens for one `usage` object, preferring `total_tokens` and falling back to the sum so a
 * provider that omits the total still gets charged.
 */
export function usageTotal(usage) {
  if (usage === null || typeof usage !== 'object') {
    return 0;
  }
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) {
    return total;
  }
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  const sum = (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
  return sum > 0 ? sum : 0;
}

/** Incremental SSE parser: push decoded text, read the running token total. */
export class UsageMeter {
  constructor() {
    this.buffer = '';
    this.total = 0;
  }

  /** Feed one decoded chunk (any split point is fine). */
  push(text) {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.consume(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Feed the final partial line, if any, and return the total. */
  flush() {
    if (this.buffer.length > 0) {
      this.consume(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
    return this.total;
  }

  consume(line) {
    if (!line.startsWith('data:')) {
      return;
    }
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') {
      return;
    }
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      return;
    }
    const reported = usageTotal(frame?.usage);
    // Frames are cumulative or sent once, never decremented; the maximum is the response total.
    if (reported > this.total) {
      this.total = reported;
    }
  }
}
