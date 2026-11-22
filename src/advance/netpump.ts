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
  constructor(private readonly allowedOrigin: string) {}

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

    const transport = url.protocol === "http:" ? httpRequest : httpsRequest;
    const request = transport(url, { method, headers }, (response: IncomingMessage) => {
      pump.push({
        kind: "start",
        status: response.statusCode ?? 0,
        headers: rawHeaders(response),
      });
      response.on("data", (chunk: Buffer) => {
        pump.push({ kind: "chunk", data: chunk.toString("base64") });
      });
      response.on("end", () => {
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
