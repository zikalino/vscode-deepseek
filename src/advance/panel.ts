// The Advance chat panel: its UI *is* `advance_harness.wasm`.
//
// * the **engine worker** (`out/advance/engine-worker.js`, a worker thread) runs the wasm module and
//   answers its synchronous capability calls with Node's fs/child_process. Blocking there cannot
//   freeze the editor, which is the whole point of the thread.
// * this file owns the webview and the wiring: it forwards input events to the worker and paints the
//   display list the worker posts back.
// * the **webview** is a canvas; the conversation is drawn by the module itself.
//
// Provider settings are shared with the rest of the extension (`deepseek.apiEndpoint`,
// `deepseek.model`, and the key in SecretStorage); the sandbox is configured under
// `deepseek.advance.*`.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";

import { SECRET_KEY } from "../consts";
import type { EngineOptions, EngineRequest, EngineResponse } from "./protocol";

export const ADVANCE_VIEW_ID = "deepseek.advanceView";

export interface AdvanceSettings {
  apiUrl: string;
  model: string;
  allowedCommands: string[];
  allowWrite: boolean;
  commandTimeoutMs: number;
  /** Dollars per million tokens, for the chat's cost divider (all zero hides the figures). */
  pricing: { inputPerMillion: number; cachedPerMillion: number; outputPerMillion: number };
}

const DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";

export function advanceSettings(): AdvanceSettings {
  const config = vscode.workspace.getConfiguration("deepseek");
  const advance = vscode.workspace.getConfiguration("deepseek.advance");
  const seconds = advance.get<number>("commandTimeoutSeconds", 120);
  return {
    apiUrl: endpoint(config.get<string>("apiEndpoint", DEFAULT_ENDPOINT)),
    model: config.get<string>("model", "deepseek-v4-flash") || "deepseek-v4-flash",
    allowedCommands: advance.get<string[]>("allowedCommands", []),
    allowWrite: advance.get<boolean>("allowWrite", true),
    commandTimeoutMs: Math.max(1, seconds) * 1000,
    pricing: {
      inputPerMillion: advance.get<number>("pricing.inputPerMillion", 0),
      cachedPerMillion: advance.get<number>("pricing.cachedPerMillion", 0),
      outputPerMillion: advance.get<number>("pricing.outputPerMillion", 0),
    },
  };
}

/** Append `/chat/completions` unless the URL already names an endpoint. */
function endpoint(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return DEFAULT_ENDPOINT;
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stored key, else the configured key, else the environment. */
export async function readApiKey(context: vscode.ExtensionContext): Promise<string> {
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored !== undefined && stored.length > 0) {
    return stored;
  }
  const configured = vscode.workspace.getConfiguration("deepseek").get<string>("apiKey", "");
  if (configured.length > 0) {
    return configured;
  }
  return process.env.DEEPSEEK_API_KEY ?? "";
}

/**
 * Find the harness artifact: the explicit setting, a copy shipped beside the panel, or the build
 * output of a Cargo workspace at the folder (or one level above it, for this repo's layout).
 */
export function resolveHarnessWasm(workspace: string, extensionPath: string): string | undefined {
  const explicit = vscode.workspace
    .getConfiguration("deepseek.advance")
    .get<string>("harnessWasm", "")
    .trim();
  if (explicit.length > 0) {
    return existsSync(explicit) ? explicit : undefined;
  }
  const candidates: string[] = [path.join(extensionPath, "media", "advance_harness.wasm")];
  const bases = new Set<string>([
    workspace,
    path.join(workspace, "advance"),
    path.dirname(workspace),
    path.join(path.dirname(workspace), "advance"),
  ]);
  for (const profile of ["release", "debug"]) {
    for (const base of bases) {
      candidates.push(
        path.join(base, "target", "wasm32-unknown-unknown", profile, "advance_harness.wasm"),
      );
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}

/** Whether a card's id names a document under the workspace's workflow folder. */
export function isWorkflowDocumentId(id: string): boolean {
  const relative = id.trim().replace(/\\/g, "/");
  return relative.startsWith(".advance/workflows/") && relative.toLowerCase().endsWith(".md");
}

/**
 * Open a workflow card's document in a preview tab. Returns the failure to report, or `undefined`
 * when the document opened.
 */
export async function openWorkflowDocument(
  root: vscode.Uri,
  id: string,
): Promise<string | undefined> {
  const relative = id.trim().replace(/\\/g, "/");
  if (!isWorkflowDocumentId(relative)) {
    return "it is not a workflow document";
  }
  const target = vscode.Uri.joinPath(root, ...relative.split("/"));
  try {
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: true });
    return undefined;
  } catch (error) {
    return describe(error);
  }
}

/** The panel. */
class Panel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private worker: Worker | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  /** The last theme the webview computed, replayed to every fresh engine instance. */
  private theme: Record<string, unknown> | undefined;
  /** The last canvas size the webview reported, replayed to every fresh engine instance. */
  private size: { width: number; height: number } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = panelHtml(view.webview, media, "DeepSeek Advance");
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message);
    });
    view.onDidDispose(() => {
      this.stopEngine();
      this.view = undefined;
    });
    void this.startEngine();
  }

  /** Start over: a fresh wasm instance means a fresh conversation. */
  async newChat(): Promise<void> {
    await vscode.commands.executeCommand(`${ADVANCE_VIEW_ID}.focus`);
    await this.startEngine();
  }

  /** Stop the running turn. */
  abort(): void {
    this.send({ type: "input", event: { op: "abort" } });
  }

  /** Ask the webview to recompute the VS Code theme and send it again. */
  refreshTheme(): void {
    void this.view?.webview.postMessage({ type: "refreshTheme" });
  }

  /** Re-read the configuration and restart the engine. */
  async restart(): Promise<void> {
    await this.startEngine();
  }

  /** Debounced restart, so a settings burst does not spin up a worker per keystroke. */
  scheduleRestart(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.startEngine();
    }, 300);
  }

  private send(message: EngineRequest): void {
    this.worker?.postMessage(message);
  }

  private postStatus(message: string): void {
    void this.view?.webview.postMessage({ type: "status", message });
  }

  private async receive(message: unknown): Promise<void> {
    const command = message as { type?: string };
    switch (command.type) {
      case "ready":
        return;
      case "input": {
        const event = (message as { event?: Record<string, unknown> }).event;
        // Keep the theme: a restarted engine needs it replayed, and the webview cannot know when
        // the worker's guest is ready.
        if (event?.op === "theme") {
          this.theme = event;
        }
        this.send(message as EngineRequest);
        return;
      }
      case "resize": {
        const size = message as { width?: unknown; height?: unknown };
        if (typeof size.width === "number" && typeof size.height === "number") {
          this.size = { width: size.width, height: size.height };
        }
        this.send(message as EngineRequest);
        return;
      }
      default:
        return;
    }
  }

  private stopEngine(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      worker.postMessage({ type: "stop" } satisfies EngineRequest);
      void worker.terminate();
    }
  }

  private async startEngine(): Promise<void> {
    const root = workspaceRoot();
    if (root === undefined) {
      this.postStatus("Open a folder first: the tools are confined to the first workspace folder.");
      return;
    }
    const wasmPath = resolveHarnessWasm(root.fsPath, this.context.extensionPath);
    if (wasmPath === undefined) {
      this.postStatus(
        "advance_harness.wasm not found — build it with " +
          "`cargo build -p advance-harness --target wasm32-unknown-unknown --release`.",
      );
      return;
    }
    const config = advanceSettings();
    const apiKey = await readApiKey(this.context);
    if (apiKey.length === 0) {
      this.postStatus("No DeepSeek API key yet — run “DeepSeek: Set Advance API Key”.");
    }

    this.stopEngine();
    // A fresh engine replaces the whole conversation. Clear the old frame first: if the new engine
    // cannot start, the user sees an empty panel and the status, not the conversation they left.
    void this.view?.webview.postMessage({ type: "clear" });
    const options: EngineOptions = {
      wasmPath,
      workspace: root.fsPath,
      apiUrl: config.apiUrl,
      apiKey,
      model: config.model,
      allowWrite: config.allowWrite,
      allowedCommands: config.allowedCommands,
      commandTimeoutMs: config.commandTimeoutMs,
      pricing: config.pricing,
      theme: this.theme,
      width: this.size?.width,
      height: this.size?.height,
    };
    const worker = new Worker(
      path.join(this.context.extensionPath, "out", "advance", "engine-worker.js"),
      { workerData: options },
    );
    this.worker = worker;
    worker.on("message", (message: EngineResponse) => {
      // terminate() does not recall a message already on its way, and a replaced worker must not
      // paint its conversation over its successor.
      if (this.worker !== worker) {
        return;
      }
      void this.onEngine(message);
    });
    worker.on("error", (error: Error) => {
      if (this.worker === worker) {
        this.postStatus(`the engine worker failed: ${error.message}`);
      }
    });
    worker.on("exit", (code: number) => {
      if (this.worker === worker && code !== 0) {
        this.postStatus(`the engine worker stopped (exit code ${code}).`);
      }
    });
  }

  private async onEngine(message: EngineResponse): Promise<void> {
    switch (message.type) {
      case "scene":
        void this.view?.webview.postMessage(message);
        return;
      case "status":
        this.postStatus(message.message);
        return;
      case "openWorkflow":
        await this.openWorkflow(message.path);
        return;
      case "ready":
        // The guest is live: hand it the theme the webview computed before it existed (or before
        // this restart), so it never draws a frame in the wrong palette.
        if (this.theme !== undefined) {
          this.send({ type: "input", event: this.theme });
        }
        return;
      case "error":
        this.postStatus(message.message);
        void vscode.window.showErrorMessage(`Advance: ${message.message}`);
        return;
      default:
        return;
    }
  }

  /**
   * A workflow card was pressed: the harness cannot run a step (the allowlist and the executor are
   * the host's), so it asks for the document to be opened and the user runs it from there.
   */
  private async openWorkflow(id: string): Promise<void> {
    const root = workspaceRoot();
    // Only a document under the workflow folder: the id is what the harness built the card from,
    // and a card that names anything else has no file to open.
    if (root === undefined || !isWorkflowDocumentId(id)) {
      return;
    }
    const problem = await openWorkflowDocument(root, id);
    if (problem !== undefined) {
      this.postStatus(`could not open ${id}: ${problem}`);
    }
  }
}

/** The canvas page every Advance webview hosts; only the title differs. */
export function panelHtml(webview: vscode.Webview, media: vscode.Uri, title: string): string {
  const nonce = randomBytes(16).toString("base64");
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
  const theme = webview.asWebviewUri(vscode.Uri.joinPath(media, "theme.js"));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
  const label = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>${label}</title>
</head>
<body>
<div id="app">
  <canvas id="screen" tabindex="0" aria-label="${label}"></canvas>
  <span id="status" role="status"></span>
</div>
<script nonce="${nonce}" src="${theme}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Register the Advance panel, its commands, and its configuration listener. */
export function registerAdvancePanel(context: vscode.ExtensionContext): void {
  const panel = new Panel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ADVANCE_VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("deepseek.advance.newChat", () => panel.newChat()),
    vscode.commands.registerCommand("deepseek.advance.abort", () => panel.abort()),
    vscode.commands.registerCommand("deepseek.advance.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "deepseek.advance"),
    ),
    vscode.commands.registerCommand("deepseek.advance.setApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "DeepSeek API key for the Advance panel",
        prompt: "Stored in VS Code's encrypted secret storage. Leave empty to clear it.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await context.secrets.delete(SECRET_KEY);
      } else {
        await context.secrets.store(SECRET_KEY, trimmed);
      }
      void vscode.window.showInformationMessage(
        trimmed.length > 0 ? "DeepSeek: API key saved." : "DeepSeek: API key cleared.",
      );
      // The key is handed to the engine at startup, so pick it up now.
      await panel.restart();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("deepseek")) {
        panel.scheduleRestart();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => panel.refreshTheme()),
  );
}
