// The messages exchanged between the extension host and the Token Usage worker.
//
// The worker runs `advance_usage.wasm`; the panel owns the webview, the shared usage journal and the
// pricing rules. Sample prices are computed host-side (the module draws money, it does not know
// rates), so the worker only carries frames and input events.

/** Everything the worker needs, handed over as `workerData`. */
export interface UsageWorkerOptions {
  /** The `advance_usage.wasm` artifact to instantiate. */
  wasmPath: string;
  /** Initial logical size; the webview sends the real one as soon as it lays out. */
  width?: number;
  height?: number;
}

/** Messages the panel sends to the worker. */
export type UsageWorkerRequest =
  | { type: "input"; event: Record<string, unknown> }
  | { type: "resize"; width: number; height: number }
  /** Re-post the current frame even when it is unchanged (the webview just became ready). */
  | { type: "refresh" }
  | { type: "stop" };

/** Messages the worker sends back. */
export type UsageWorkerResponse =
  | { type: "scene"; scene: string }
  | { type: "ready" }
  /** The module's Clear button was pressed; the panel owns the journal and must clear it. */
  | { type: "clear" }
  | { type: "error"; message: string };
