// The Token Usage worker: where `advance_usage.wasm` actually runs.
//
// The module is a small, static display list: it has no capabilities, no clock and no journal. The
// panel feeds it samples and prices; this worker only marshals frames and input across the C ABI.
// It still belongs on a worker thread because `abi_frame` is synchronous and a large history should
// not be laid out on the extension host.

import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { Guest } from "./guest";
import type { UsageWorkerOptions, UsageWorkerRequest, UsageWorkerResponse } from "./usageProtocol";

const port = parentPort;
if (port === null) {
  throw new Error("the usage worker must be started as a worker thread");
}

const options = workerData as UsageWorkerOptions;

/** The module declares no imports; extra bindings in the import object are ignored. */
const noCapabilities = {
  hostCall: () => "",
  netBegin: () => 0,
  netPoll: () => "",
  netClose: () => undefined,
};

let width = Math.max(1, Math.floor(options.width ?? 800));
let height = Math.max(1, Math.floor(options.height ?? 600));
/** The last display list posted, so an unchanged frame is not re-sent. */
let lastScene = "";
let guest: Guest | undefined;

function post(message: UsageWorkerResponse): void {
  port?.postMessage(message);
}

/** Act on the lines a frame asked the host to read. The Usage module only asks to clear. */
function emitLogs(scene: string): void {
  let logs: unknown;
  try {
    logs = (JSON.parse(scene) as { logs?: unknown }).logs;
  } catch {
    return;
  }
  if (Array.isArray(logs) && logs.some((line) => line === "usage\tclear")) {
    post({ type: "clear" });
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
    post({ type: "error", message: `the usage panel failed while drawing: ${describe(error)}` });
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
  let repaint = false;
  try {
    repaint = guest.input(event).repaint === true;
  } catch (error) {
    post({ type: "error", message: `the usage panel failed on input: ${describe(error)}` });
    return;
  }
  if (repaint) {
    render();
  }
}

function start(): void {
  try {
    guest = Guest.load(readFileSync(options.wasmPath), noCapabilities);
    post({ type: "ready" });
    render();
  } catch (error) {
    post({ type: "error", message: `the usage panel could not start: ${describe(error)}` });
  }
}

port.on("message", (message: UsageWorkerRequest) => {
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
    case "refresh":
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
