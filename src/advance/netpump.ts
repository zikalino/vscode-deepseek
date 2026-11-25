// The streaming `net/fetch` proxy, in-process.
//
// The harness's `net/fetch` is incremental: it opens a fetch, then polls each frame for whatever
// bytes arrived, so an SSE completion can paint token by token. `net_poll` must therefore be a pure
// queue drain — never a blocking read. Node's HTTP client is asynchronous, so the response is pumped
// into a queue on the worker's event loop, and the guest drains it between frames.
//
// The URL is still checked against the provider origin, mirroring the grant the desktop host applies.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import { decodeBase64, headerField, optionalNumber, optionalString, stringField, type Header } from "./abi";
import type { EngineUsage } from "./protocol";

/** One queued `advance_abi::wasm::NetPoll`, already in its wire shape. */
type NetPoll =
  | { kind: "pending" }
  | { kind: "start"; status: number; headers: Header[] }
  | { kind: "chunk"; data: string }
  | { kind: "end" }
  | { kind: "error"; code: string; message: string };

/** One fetch in flight. */
class Pump {
  private readonly queue: NetPoll[] = [];
  /** The terminal poll, replayed once the queue drains so a repeated poll never hangs on `pending`. */
  private terminal: NetPoll | undefined;
  private request: ClientRequest | undefined;

  push(poll: NetPoll): void {
    if (poll.kind === "end" || poll.kind === "error") {
      this.terminal = poll;
    }
    this.queue.push(poll);
  }

  poll(): NetPoll {
    const next = this.queue.shift();
    if (next !== undefined) {
      return next;
    }
    return this.terminal ?? { kind: "pending" };
  }

  attach(request: ClientRequest): void {
    this.request = request;
  }

  abort(): void {
    this.request?.destroy();
  }
}

/** A refusal or a bad request, carrying the ABI code to report. */
class PumpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PumpError";
  }
}

/** The live pumps, keyed by the handle the guest polls. */
export class NetPumps {
  private readonly pumps = new Map<number, Pump>();
  private next = 1;

  /** @param allowedOrigin the provider origin (`scheme://host[:port]`) every fetch must share. */
  constructor(
    private readonly allowedOrigin: string,
    private readonly onUsage: (usage: EngineUsage) => void = () => undefined,
  ) {}

  /** Start a fetch from a `FetchRequest` JSON; always returns a handle. */
  begin(requestJson: string): number {
    const handle = this.next++;
    const pump = new Pump();
    this.pumps.set(handle, pump);
    try {
      this.start(pump, requestJson);
    } catch (error) {
      pump.push({
        kind: "error",
        code: error instanceof PumpError ? error.code : "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return handle;
  }

  /** The next poll for a handle. */
  poll(handle: number): string {
    const pump = this.pumps.get(handle);
    if (pump === undefined) {
      return JSON.stringify({
        kind: "error",
        code: "not_found",
        message: `no fetch with handle ${handle}`,
      } satisfies NetPoll);
    }
    return JSON.stringify(pump.poll());
  }

  /** Release a handle and abort its request. */
  close(handle: number): void {
    this.pumps.get(handle)?.abort();
    this.pumps.delete(handle);
  }

  private start(pump: Pump, requestJson: string): void {
    const payload = JSON.parse(requestJson) as unknown;
    const method = stringField(payload, "method").toUpperCase();
    const target = stringField(payload, "url");
    const bodyText = optionalString(payload, "body_base64");
    const timeoutMs = optionalNumber(payload, "timeout_ms") ?? 120_000;

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new PumpError("invalid_request", `\`${target}\` is not an absolute URL`);
    }
    if (`${url.protocol}//${url.host}` !== this.allowedOrigin) {
      throw new PumpError("not_permitted", `\`${target}\` is outside the net allowlist`);
    }

    const headers: Record<string, string> = {};
    for (const header of headerField(payload, "headers")) {
      const name = header.name.toLowerCase();
      // Node computes these; a stale copy would either corrupt the body or the connection.
      if (name === "content-length" || name === "host" || name === "connection") {
        continue;
      }
      headers[header.name] = header.value;
    }
    const body = bodyText === undefined ? undefined : Buffer.from(decodeBase64(bodyText));
    if (body !== undefined) {
      headers["content-length"] = String(body.length);
    }
    const model = requestModel(body);

    const transport = url.protocol === "http:" ? httpRequest : httpsRequest;
    const request = transport(url, { method, headers }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      pump.push({
        kind: "start",
        status,
        headers: rawHeaders(response),
      });
      // Only a successful completion carries a `usage` object; a 4xx/5xx body does not.
      const tap = status >= 200 && status < 300 ? new UsageTap(model, this.onUsage) : undefined;
      response.on("data", (chunk: Buffer) => {
        tap?.push(chunk);
        pump.push({ kind: "chunk", data: chunk.toString("base64") });
      });
      response.on("end", () => {
        tap?.finish();
        pump.push({ kind: "end" });
      });
      response.on("error", (error: Error) => {
        pump.push({ kind: "error", code: "upstream", message: error.message });
      });
    });
    pump.attach(request);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`the provider did not answer within ${timeoutMs} ms`));
    });
    request.on("error", (error: Error) => {
      pump.push({ kind: "error", code: "upstream", message: error.message });
    });
    request.end(body);
  }
}

/** `res.rawHeaders` is a flat `[name, value, ...]` list, which preserves duplicates and casing. */
function rawHeaders(response: IncomingMessage): Header[] {
  const headers: Header[] = [];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    headers.push({ name: response.rawHeaders[index], value: response.rawHeaders[index + 1] });
  }
  return headers;
}

/** The request body's `model`, when it is the JSON chat-completions body we expect. */
function requestModel(body: Buffer | undefined): string {
  if (body === undefined) {
    return "";
  }
  const parsed = parseJson(body.toString("utf8"));
  return isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : "";
}

/**
 * How much of the response tail is kept for parsing. The usage frame arrives last, so a long
 * completion does not need to be buffered in full just to read it.
 */
const USAGE_TAIL_LIMIT = 256 * 1024;

/**
 * Reads the `usage` object out of one chat-completions response.
 *
 * The upstream body is either a JSON object or an SSE stream whose final `data:` frame carries
 * `usage` (the harness asks for `stream_options.include_usage`). The tap only reports, never
 * changes what the guest receives.
 */
class UsageTap {
  private tail = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly model: string,
    private readonly emit: (usage: EngineUsage) => void,
  ) {}

  push(chunk: Buffer): void {
    this.tail += this.decoder.decode(chunk, { stream: true });
    if (this.tail.length > USAGE_TAIL_LIMIT) {
      this.tail = this.tail.slice(-USAGE_TAIL_LIMIT);
    }
  }

  finish(): void {
    this.tail += this.decoder.decode();
    const usage = usageFromBody(this.tail);
    if (usage !== undefined) {
      this.emit({ model: this.model, ...usage });
    }
  }
}

interface UsageFields {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

function usageFromBody(body: string): UsageFields | undefined {
  const text = body.trim();
  if (text.length === 0) {
    return undefined;
  }

  // A non-streamed response is one JSON object.
  const direct = usageFields(parseJson(text));
  if (direct !== undefined) {
    return direct;
  }

  // An SSE response repeats `data: {...}` lines; the usage frame is the final one.
  let found: UsageFields | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") {
      continue;
    }
    const fields = usageFields(parseJson(payload));
    if (fields !== undefined) {
      found = fields;
    }
  }
  return found;
}

function usageFields(value: unknown): UsageFields | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return undefined;
  }
  const usage = value.usage;
  const promptTokens = numberField(usage.prompt_tokens);
  const completionTokens = numberField(usage.completion_tokens);
  if (promptTokens === 0 && completionTokens === 0) {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens: numberField(usage.prompt_cache_hit_tokens),
    cacheMissTokens: numberField(usage.prompt_cache_miss_tokens),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
