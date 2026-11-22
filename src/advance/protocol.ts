// The messages exchanged between the extension host and the engine worker.
//
// Kept in its own module so both sides can import the types without pulling in the worker's
// top-level code (importing `engine-worker` outside a worker thread throws by design).

/** Everything the worker needs, handed over as `workerData`. */
export interface EngineOptions {
  /** The harness artifact to instantiate. */
  wasmPath: string;
  /** The folder `/workspace` maps to. */
  workspace: string;
  /** The full chat-completions URL. */
  apiUrl: string;
  /** The provider token (in-process only; never sent to the webview). */
  apiKey: string;
  model: string;
  allowWrite: boolean;
  allowedCommands: string[];
  commandTimeoutMs: number;
  /** Dollars per million tokens, handed to the harness for its cost divider. */
  pricing: { inputPerMillion: number; cachedPerMillion: number; outputPerMillion: number };
  /** The VS Code theme the webview computed, applied before the first frame when known. */
  theme?: Record<string, unknown>;
  /**
   * The panel's last known logical size. A fresh engine is created without a resize event (the
   * canvas has not moved), so without this its first frame would be 800x600 and paint over only
   * part of the stale scene.
   */
  width?: number;
  height?: number;
}

/** Messages the extension host sends to the worker. */
export type EngineRequest =
  | { type: "input"; event: Record<string, unknown> }
  | { type: "resize"; width: number; height: number }
  | { type: "stop" };

/** Messages the worker sends back. */
export type EngineResponse =
  | { type: "scene"; scene: string }
  | { type: "status"; message: string }
  | { type: "ready" }
  | { type: "openWorkflow"; path: string }
  | { type: "error"; message: string };
