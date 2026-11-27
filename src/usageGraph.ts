// The token-usage graph: one thin bar per DeepSeek API call, drawn by `advance_usage.wasm`.
//
// The module is the same one the desktop shell and the web client use. It owns the chart, the
// legend, the totals card and the Clear button; this file owns the webview, the shared usage journal
// and the pricing rules. Samples are priced here, because the rates are the host's and the module
// only lays the money out.
//
// The API is stateless, so a bar is one request's `usage` object: both request paths feed the same
// recorder (see `usage.ts`), so Copilot turns and Zero turns appear side by side.

import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";

import type { UsageWorkerOptions, UsageWorkerRequest, UsageWorkerResponse } from "./advance/usageProtocol";
import { panelHtml } from "./advance/webview";
import { costPartsOf, type PricingRules } from "./pricing";
import { readPricingRules } from "./pricingSettings";
import {
  getUsageJournal,
  getUsageRecorder,
  USAGE_SAMPLE_LIMIT,
  type UsageSample,
} from "./usage";

const VIEW_TYPE = "deepseek.usageGraph";
const TITLE = "DeepSeek: Token Usage";
/** How often the panel checks the shared journal for samples written by other windows. */
const POLL_INTERVAL_MS = 500;

/** One sample in the shape `advance_usage::input::UsageSample` decodes. */
interface CostedSample {
  at: number;
  model: string;
  cacheHit: number;
  cacheMiss: number;
  output: number;
  total: number;
  cost: number;
  costHit: number;
  costMiss: number;
  costOut: number;
}

let currentPanel: vscode.WebviewPanel | undefined;
let disposeCurrent: (() => void) | undefined;

export function registerUsageGraphCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.showUsageGraph", () => openUsageGraph(context)),
    {
      dispose: () => {
        disposeCurrent?.();
        disposeCurrent = undefined;
      },
    },
  );
}

function openUsageGraph(context: vscode.ExtensionContext): void {
  if (currentPanel !== undefined) {
    currentPanel.reveal(undefined, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  });
  currentPanel = panel;
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  panel.webview.html = panelHtml(panel.webview, media, TITLE);

  const wasmPath = resolveUsageWasm(context.extensionPath);
  const missingWasm =
    wasmPath === undefined
      ? "advance_usage.wasm not found — build it with " +
        "`cargo build -p advance-usage --target wasm32-unknown-unknown --release`."
      : undefined;

  const journal = getUsageJournal();
  let offset = 0;
  let worker: Worker | undefined;
  let workerReady = false;
  let disposed = false;
  let width = 800;
  let height = 600;
  /** Inputs that arrived before the worker attached its listener, in arrival order. */
  const queued: UsageWorkerRequest[] = [];

  const postStatus = (message: string): void => {
    void panel.webview.postMessage({ type: "status", message });
  };

  const toWorker = (message: UsageWorkerRequest): void => {
    if (worker === undefined) {
      return;
    }
    if (workerReady) {
      worker.postMessage(message);
    } else {
      queued.push(message);
    }
  };

  const flush = (): void => {
    if (worker === undefined) {
      return;
    }
    for (const message of queued.splice(0)) {
      worker.postMessage(message);
    }
  };

  const priced = (samples: readonly UsageSample[], rules: PricingRules): CostedSample[] =>
    samples.slice(-USAGE_SAMPLE_LIMIT).map((sample) => {
      const parts = costPartsOf(
        sample.model,
        sample.at,
        { cacheHit: sample.cacheHit, cacheMiss: sample.cacheMiss, output: sample.output },
        rules,
      );
      return {
        at: sample.at,
        model: sample.model,
        cacheHit: sample.cacheHit,
        cacheMiss: sample.cacheMiss,
        output: sample.output,
        total: sample.total,
        cost: parts?.total ?? 0,
        costHit: parts?.hit ?? 0,
        costMiss: parts?.miss ?? 0,
        costOut: parts?.out ?? 0,
      };
    });

  const readAll = (): { samples: UsageSample[]; offset: number } => {
    if (journal !== undefined) {
      const slice = journal.read(0);
      return { samples: slice.samples, offset: slice.offset };
    }
    return { samples: getUsageRecorder().snapshot(), offset: 0 };
  };

  const sendReset = (): void => {
    const all = readAll();
    offset = all.offset;
    toWorker({
      type: "input",
      event: { op: "usageReset", samples: priced(all.samples, readPricingRules()) },
    });
  };

  if (missingWasm !== undefined) {
    // The canvas still opens: the page's status line says what to build, instead of a blank panel.
    void vscode.window.showErrorMessage(missingWasm);
  } else {
    worker = new Worker(
      path.join(context.extensionPath, "out", "advance", "usage-worker.js"),
      { workerData: { wasmPath, width, height } satisfies UsageWorkerOptions },
    );
    worker.on("message", (message: UsageWorkerResponse) => {
      if (disposed) {
        return;
      }
      switch (message.type) {
        case "ready":
          workerReady = true;
          flush();
          sendReset();
          return;
        case "scene":
          void panel.webview.postMessage(message);
          return;
        case "clear":
          getUsageRecorder().clear();
          offset = 0;
          sendReset();
          return;
        case "error":
          postStatus(message.message);
          return;
        default:
          return;
      }
    });
    worker.on("error", (error: Error) => {
      if (!disposed) {
        postStatus(`the usage panel failed: ${error.message}`);
      }
    });
    worker.on("exit", (code: number) => {
      if (!disposed && code !== 0) {
        postStatus(`the usage panel stopped (exit code ${code}).`);
      }
    });
  }

  const messages = panel.webview.onDidReceiveMessage((message: unknown) => {
    const command = message as {
      type?: string;
      event?: Record<string, unknown>;
      width?: number;
      height?: number;
    };
    switch (command.type) {
      case "ready":
        if (missingWasm !== undefined) {
          postStatus(missingWasm);
        } else {
          // The webview's listener is now attached; re-post a frame it may have missed.
          toWorker({ type: "refresh" });
        }
        return;
      case "resize":
        if (typeof command.width === "number" && typeof command.height === "number") {
          width = command.width;
          height = command.height;
          toWorker({ type: "resize", width, height });
        }
        return;
      case "input":
        if (command.event !== undefined) {
          toWorker({ type: "input", event: command.event });
        }
        return;
      default:
        return;
    }
  });

  // The active extension host is not necessarily the one serving Copilot (VS Code's BYOK bridge
  // picks a window), so samples are read from the shared journal instead of this host's buffer.
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  if (journal !== undefined) {
    timer = setInterval(() => {
      if (disposed || worker === undefined || !workerReady) {
        return;
      }
      const slice = journal.read(offset);
      offset = slice.offset;
      if (slice.reset) {
        // Another window cleared the history; replace rather than append.
        toWorker({
          type: "input",
          event: { op: "usageReset", samples: priced(slice.samples, readPricingRules()) },
        });
        return;
      }
      if (slice.samples.length > 0) {
        toWorker({
          type: "input",
          event: { op: "usageAppend", samples: priced(slice.samples, readPricingRules()) },
        });
      }
    }, POLL_INTERVAL_MS);
  } else {
    unsubscribe = getUsageRecorder().onDidRecord((samples) => {
      if (disposed || worker === undefined || !workerReady) {
        return;
      }
      toWorker({
        type: "input",
        event: { op: "usageAppend", samples: priced(samples, readPricingRules()) },
      });
    });
  }

  // Prices are edited in settings; recompute every sample and replace the chart instead of waiting
  // for a reopen. The module holds no rates, so a reset is how a new price reaches an old bar.
  const configuration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("deepseek.advance.pricing") ||
      event.affectsConfiguration("deepseek.model")
    ) {
      sendReset();
    }
  });

  disposeCurrent = () => panel.dispose();

  panel.onDidDispose(() => {
    disposed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    messages.dispose();
    configuration.dispose();
    unsubscribe?.();
    unsubscribe = undefined;
    if (worker !== undefined) {
      worker.postMessage({ type: "stop" } satisfies UsageWorkerRequest);
      void worker.terminate();
      worker = undefined;
    }
    currentPanel = undefined;
    disposeCurrent = undefined;
  });
}

/**
 * Find the Usage artifact: the copy shipped beside the panel, or the build output of a Cargo
 * workspace at the folder (or one level above it, for this repo's layout).
 */
function resolveUsageWasm(extensionPath: string): string | undefined {
  const candidates: string[] = [path.join(extensionPath, "media", "advance_usage.wasm")];
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspace !== undefined) {
    const bases = new Set<string>([
      workspace,
      path.join(workspace, "advance"),
      path.dirname(workspace),
      path.join(path.dirname(workspace), "advance"),
    ]);
    for (const profile of ["release", "debug"]) {
      for (const base of bases) {
        candidates.push(
          path.join(base, "target", "wasm32-unknown-unknown", profile, "advance_usage.wasm"),
        );
      }
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}