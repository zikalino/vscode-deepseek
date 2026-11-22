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
    }
  }
}

let width = 800;
let height = 600;
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
  if (effects.repaint === true) {
    render();
  }
}

function start(): void {
  try {
    const router = new Router({
      roots: new Map([["workspace", options.workspace]]),
      writable: options.allowWrite,
      allowedCommands: options.allowedCommands,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    const pumps = new NetPumps(origin(options.apiUrl));

    guest = Guest.load(readFileSync(options.wasmPath), {
      hostCall: (request) => router.call(request),
      netBegin: (request) => pumps.begin(request),
      netPoll: (handle) => pumps.poll(handle),
      netClose: (handle) => pumps.close(handle),
    });

    // Hand the engine its provider exactly once, then open the chat view. Clipboard stays ungranted:
    // a worker thread has no clipboard access, so the engine must not advertise those tools.
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
    // The panel is multi-surface: the module draws its own top bar (Agent, Tasks, Tools and
    // Workflows) and settings stays on the chat's gear. The host adds no navigation of its own, so
    // the component has to keep its bar on and start on the conversation.
    guest.input({ op: "bar", value: true });
    guest.input({ op: "selectSurface", value: "chat" });
    // The harness cannot list `.advance/workflows`; discovery is the host's.
    guest.input({ op: "workflows", items: discoverWorkflows(options.workspace) });
    // This engine's webview (media/panel.js) turns a spinner on its own clock, so the module hands
    // it one instead of drawing dots that would freeze whenever a tool call blocks this thread.
    guest.input({ op: "hostSpins", value: true });

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
