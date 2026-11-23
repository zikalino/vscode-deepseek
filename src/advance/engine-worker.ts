// The engine worker: where `advance_harness.wasm` actually runs.
//
// It lives on a worker thread for one reason: `advance.host_call` is **synchronous**, so answering it
// blocks the calling thread. On the extension host that would stall every extension (and a
// `cargo build` would stall it for minutes). Here it only stalls this worker, while the webview keeps
// painting and the editor stays responsive.
//
// The worker owns the frame clock: `abi_frame` is what pumps the module (its agent loop drains the
// streaming fetch there), so it is called ~30 times a second and the resulting display list is posted
// to the panel only when it changes.

import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { Guest, type Effects } from "./guest";
import { NetPumps } from "./netpump";
import type { EngineOptions, EngineRequest, EngineResponse } from "./protocol";
import { Router } from "./router";
import { discoverWorkflows } from "./workflows";

const port = parentPort;
if (port === null) {
  throw new Error("the engine worker must be started as a worker thread");
}

const options = workerData as EngineOptions;

/** Act on the lines a frame asked the host to read (the harness's frame log). */
function emitLogs(scene: string): void {
  let logs: unknown;
  try {
    logs = (JSON.parse(scene) as { logs?: unknown }).logs;
  } catch {
    return;
  }
  if (!Array.isArray(logs)) {
    return;
  }
  for (const line of logs) {
    if (typeof line !== "string") {
      continue;
    }
    const [verb, ...rest] = line.split("\t");
    if (verb === "openWorkflow" && rest.length > 0) {
      post({ type: "openWorkflow", path: rest.join("\t") });
    } else if (verb === "openTool" && rest.length >= 2) {
      post({ type: "openTool", kind: rest[0], name: rest.slice(1).join("\t") });
    } else if (verb === "workflowRun" && rest.length > 0) {
      const run = parseRun(rest.join("\t"));
      if (run !== undefined) {
        post({ type: "workflowRun", script: run.script, values: run.values });
      }
    } else if (verb === "workflowClose") {
      post({ type: "workflowClose" });
    } else if (verb === "busy") {
      post({ type: "busy", busy: rest[0] === "1" });
    } else if (verb === "turn-done") {
      post({ type: "turnDone" });
    } else if (verb === "toolEnabled" && rest.length >= 2) {
      post({ type: "toolEnabled", name: rest[0], enabled: rest[1] === "1" });
    }
  }
}

/** The `workflowRun` line's payload: the script's id and the form's answers. */
function parseRun(json: string): { script: string; values: Record<string, string> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.script !== "string") {
    return undefined;
  }
  const values: Record<string, string> = {};
  if (isRecord(parsed.values)) {
    for (const [key, value] of Object.entries(parsed.values)) {
      if (typeof value === "string") {
        values[key] = value;
      }
    }
  }
  return { script: parsed.script, values };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let width = Math.max(1, Math.floor(options.width ?? 800));
let height = Math.max(1, Math.floor(options.height ?? 600));
/** The last display list posted, so an unchanged frame is not re-sent. */
let lastScene = "";
let guest: Guest | undefined;

function post(message: EngineResponse): void {
  port?.postMessage(message);
}

/** The provider origin, for the net allowlist. */
function origin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

function render(): void {
  if (guest === undefined) {
    return;
  }
  let scene: string | null;
  try {
    scene = guest.frame(width, height);
  } catch (error) {
    post({ type: "error", message: `the harness failed while drawing: ${describe(error)}` });
    return;
  }
  if (scene === null || scene === lastScene) {
    return;
  }
  lastScene = scene;
  post({ type: "scene", scene });
  emitLogs(scene);
}

function sendInput(event: Record<string, unknown>): void {
  if (guest === undefined) {
    return;
  }
  let effects: Effects;
  try {
    effects = guest.input(event);
  } catch (error) {
    post({ type: "error", message: `the harness failed on input: ${describe(error)}` });
    return;
  }
  if (typeof effects.status === "string" && effects.status.length > 0) {
    post({ type: "status", message: effects.status });
  }
  if (effects.cursor !== undefined) {
    post({ type: "cursor", cursor: effects.cursor });
  }
  if (effects.repaint === true) {
    render();
  }
}

function start(): void {
  try {
    // `tools` is the extension's global folder: a custom tool is written there by
    // `create_custom_tool`, not into the project it happens to be used in. A host that did not
    // supply one (a workflow tab) simply has no such root.
    const roots = new Map<string, string>([["workspace", options.workspace]]);
    if (options.toolsDir !== undefined) {
      roots.set("tools", options.toolsDir);
    }
    const router = new Router({
      roots,
      writable: options.allowWrite,
      allowedCommands: options.allowedCommands,
      commandTimeoutMs: options.commandTimeoutMs,
      galleryDir: options.galleryDir,
      galleryUrl: options.galleryUrl,
      githubToken: options.githubToken,
    });
    const pumps = new NetPumps(origin(options.apiUrl));

    guest = Guest.load(readFileSync(options.wasmPath), {
      hostCall: (request) => router.call(request),
      netBegin: (request) => pumps.begin(request),
      netPoll: (handle) => pumps.poll(handle),
      netClose: (handle) => pumps.close(handle),
    });

    // Hand the engine its provider exactly once, then open the surface the host asked for. The
    // default is the conversation with the module's own bar, which is what the Advance panel wants;
    // a workflow tab asks for `workflows` with no bar, so the one card is the whole tab.
    guest.input({
      op: "init",
      provider: {
        url: options.apiUrl,
        apiKey: options.apiKey,
        model: options.model,
        allowWrite: options.allowWrite,
        allowClipboard: false,
        allowedCommands: options.allowedCommands,
        // Only the harness's own settings view uses these two.
        workspace: options.workspace,
        pricing: options.pricing,
      },
    });
    // The catalogue is the host's discovery plus the user's checkboxes. It goes in after `init` so
    // the grant's built-ins and the user's tools are known together, and before the first frame so
    // the Tools view never flashes a list the user did not choose.
    guest.input({
      op: "catalogue",
      custom: options.customTools ?? [],
      workflows: options.workflowTools ?? [],
      enabled: options.enabledTools ?? {},
    });
    guest.input({ op: "bar", value: options.bar ?? true });
    // VS Code draws the view's own title bar, so the module must not draw a second header inside
    // the canvas. A host without one (the desktop shell) leaves this unset and keeps the title.
    guest.input({ op: "hostHeader", value: true });
    guest.input({ op: "selectSurface", value: options.surface ?? "chat" });
    // The harness cannot list `.advance/workflows`; discovery is the host's. A workflow tab hands
    // over the document it was opened for instead of the whole folder.
    guest.input({
      op: "workflows",
      items: options.workflowItems ?? discoverWorkflows(options.workspace),
    });
    // This engine's webview (media/panel.js) turns a spinner on its own clock, so the module hands
    // it one instead of drawing dots that would freeze whenever a tool call blocks this thread.
    guest.input({ op: "hostSpins", value: true });
    // A workflow tab asks for one document as a form rather than the Workflows list. It goes last
    // so the surface, bar and list setup above cannot clear it.
    if (options.workflowForm !== undefined) {
      guest.input({
        op: "workflowForm",
        title: options.workflowForm.title,
        source: options.workflowForm.source,
      });
    }

    // Apply the VS Code theme before the first frame when the webview has already computed it;
    // otherwise the panel replays it once this worker reports ready.
    if (options.theme !== undefined) {
      guest.input({ op: "theme", theme: options.theme });
    }

    post({ type: "ready" });
    render();
    // Keep the module pumped: `abi_frame` advances the agent loop and drains the fetch queue.
    setInterval(render, 33);
  } catch (error) {
    post({ type: "error", message: `the harness could not start: ${describe(error)}` });
  }
}

port.on("message", (message: EngineRequest) => {
  switch (message.type) {
    case "input":
      sendInput(message.event);
      return;
    case "resize":
      width = Math.max(1, Math.floor(message.width));
      height = Math.max(1, Math.floor(message.height));
      lastScene = "";
      render();
      return;
    case "stop":
      port?.close();
      return;
    default:
      return;
  }
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

start();
