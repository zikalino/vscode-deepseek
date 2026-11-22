// The messages exchanged between the extension host and the engine worker.
//
// Kept in its own module so both sides can import the types without pulling in the worker's
// top-level code (importing `engine-worker` outside a worker thread throws by design).

import type { CustomToolDefinition } from "./toolCatalogue";
import type { WorkflowBrief } from "./workflows";

/** Everything the worker needs, handed over as `workerData`. */
export interface EngineOptions {
  /** The harness artifact to instantiate. */
  wasmPath: string;
  /** The folder `/workspace` maps to. */
  workspace: string;
  /** The global tools folder `/tools` maps to. Custom tools live here, outside any project. */
  toolsDir?: string;
  /** The cloned public gallery, shared by every workspace. */
  galleryDir?: string;
  /** The gallery's git URL (the public repo, or a fork). */
  galleryUrl?: string;
  /** A GitHub token used only for publishing a gallery tool. Never logged. */
  githubToken?: string;
  /** User-defined tools discovered in `toolsDir`. */
  customTools?: CustomToolDefinition[];
  /** Single-script workflows the host exposes as model tools. */
  workflowTools?: CustomToolDefinition[];
  /** Tool name -> allowed. Built-ins default on; user-defined tools default off. */
  enabledTools?: Record<string, boolean>;
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
  /**
   * The surface the module should draw once it is live. The Advance panel leaves this unset (the
   * chat); a workflow tab asks for `workflows` so the same module paints the workflow card.
   */
  surface?: "chat" | "tasks" | "tools" | "workflows" | "settings";
  /** Whether the module draws its own surface bar. A single-surface tab turns it off. */
  bar?: boolean;
  /**
   * The workflow list the module should draw. Unset means "discover `.advance/workflows`"; a
   * workflow tab passes the one document the user picked.
   */
  workflowItems?: WorkflowBrief[];
  /**
   * The workflow document the module should draw as a form. The harness renders the markdown form
   * itself (fields, prose and `script` buttons); unset is the ordinary surface.
   */
  workflowForm?: { title: string; source: string };
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
  /** A tool's row was pressed: the host opens the markdown behind a custom or workflow tool. */
  | { type: "openTool"; kind: string; name: string }
  /** The harness's `busy\t1`/`busy\t0`, so the host can hand it one prompt at a time. */
  | { type: "busy"; busy: boolean }
  /** The harness's `turn-done`, which also arrives when a turn could not start at all. */
  | { type: "turnDone" }
  /** A tool's checkbox was pressed; the host owns the persisted choice. */
  | { type: "toolEnabled"; name: string; enabled: boolean }
  /**
   * A workflow form's `script` button was pressed. The host owns the executor, so it runs the
   * script with these answers.
   */
  | { type: "workflowRun"; script: string; values: Record<string, string> }
  /** The workflow form's close button was pressed. */
  | { type: "workflowClose" }
  | { type: "error"; message: string };
