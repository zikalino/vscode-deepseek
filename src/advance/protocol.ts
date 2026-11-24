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
  /** The signed-in GitHub session token, used only for publishing a gallery tool. Never logged. */
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
  surface?: "chat" | "history" | "tasks" | "tools" | "workflows" | "settings";
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

/** What the harness asks the host to open for a message's View control. */
export interface ViewRequest {
  kind: "markdown" | "code" | "text";
  language: string;
  name: string;
  text: string;
}

/**
 * What the pointer should look like over the panel. The module reports it because only the module
 * knows which rectangle it drew as a button or a text field.
 */
export type PointerCursor = "default" | "pointer" | "text";

/**
 * One saved conversation, in the shape the harness's `Conversation` wire type has.
 *
 * `lines` is the module's own transcript and `messages` is the provider's wire history, so both are
 * opaque here: the host stores them and hands them back, and only the module reads them. The
 * harness leaves `id` and `updated` empty; the host stamps them before storing the entry.
 */
export interface Conversation {
  /** The host's id. Empty in a fresh snapshot; the host assigns one before storing it. */
  id: string;
  /** What the list calls it: the first user message, or a name the user chose. */
  title: string;
  /** When the host last saved it, in milliseconds since the Unix epoch. */
  updated: number;
  /** The last thing said, for the second line of the list. */
  preview: string;
  lines: unknown;
  messages: unknown[];
}

/** Messages the worker sends back. */
export type EngineResponse =
  | { type: "scene"; scene: string }
  | { type: "cursor"; cursor: PointerCursor }
  | { type: "status"; message: string }
  /** A message's View control asked for an editor tab. */
  | { type: "view"; request: ViewRequest }
  /** A message's Copy control (or Ctrl+C in the composer) asked for the clipboard. */
  | { type: "copied"; text: string }
  | { type: "ready" }
  /** A finished turn's conversation, for the host to store and list. */
  | { type: "snapshot"; conversation: Conversation }
  /** The chat opened a saved conversation; later snapshots continue that entry. */
  | { type: "historyOpen"; id: string }
  /** The chat started a new conversation; a later snapshot must not overwrite the old entry. */
  | { type: "historyNew" }
  | { type: "historyDelete"; id: string }
  | { type: "historyRename"; id: string; title: string }
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
