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
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";

import { GITHUB_SECRET_KEY, SECRET_KEY } from "../consts";
import { setAdvanceBridge, type AdvanceBridge } from "./advanceBridge";
import type { EngineOptions, EngineRequest, EngineResponse } from "./protocol";
import { advanceSettings, readApiKey, resolveHarnessWasm } from "./settings";
import { discoverCustomTools } from "./customTools";
import { ensureGallery, GALLERY_DIR_NAME } from "./galleryRepo";
import { isWorkflowDocumentId, readWorkflowDocument } from "./workflowFiles";
import { runWorkflowDocument } from "./workflowRunner";
import { discoverWorkflowCatalogue } from "./workflows";

export { advanceSettings, readApiKey, resolveHarnessWasm } from "./settings";
export type { AdvanceSettings } from "./settings";
export { isWorkflowDocumentId, openWorkflowDocument } from "./workflowFiles";

export const ADVANCE_VIEW_ID = "deepseek.advanceView";

/** Where this workspace remembers which tools the user allowed. */
const TOOL_ENABLED_KEY = "deepseek.advance.toolEnabled";

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The panel. */
class Panel implements vscode.WebviewViewProvider, AdvanceBridge {
  private view: vscode.WebviewView | undefined;
  private worker: Worker | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  /** Bumped by every start/stop so an in-flight async start cannot install a stale worker. */
  private generation = 0;
  /** The engine is live and can take input. */
  private ready = false;
  /** Whether a turn is running, as the harness last reported it (`busy\t1`/`busy\t0`). */
  private busy = false;
  /** A queued submission was sent and its turn has not finished yet. */
  private submitted = false;
  /** Whether the harness has reported the submitted turn as busy at least once. */
  private sawBusy = false;
  /** Whether the next queued submission should bring the chat surface forward first. */
  private showChat = false;
  /** Agent prompts and tasks waiting for the engine to be idle, so a second is not refused. */
  private readonly pending: Array<Record<string, unknown>> = [];
  /** The last theme the webview computed, replayed to every fresh engine instance. */
  private theme: Record<string, unknown> | undefined;
  /** The last canvas size the webview reported, replayed to every fresh engine instance. */
  private size: { width: number; height: number } | undefined;
  /** The workflow document whose form the panel is showing, when one is open. */
  private workflowId: string | undefined;
  /** The workspace's allow/disable choices, kept in memory so two quick ticks cannot lose one. */
  private enabledTools: Record<string, boolean> = {};

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = panelHtml(view.webview, media, "DeepSeek Zero");
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message);
    });
    view.onDidDispose(() => {
      this.stopEngine();
      this.pending.length = 0;
      this.view = undefined;
    });
    void this.startEngine();
  }

  /** Start over: a fresh wasm instance means a fresh conversation. */
  async newChat(): Promise<void> {
    await vscode.commands.executeCommand(`${ADVANCE_VIEW_ID}.focus`);
    this.pending.length = 0;
    await this.startEngine();
  }

  /** Stop the running turn. */
  abort(): void {
    this.send({ type: "input", event: { op: "abort" } });
    this.turnStopped();
  }

  /**
   * The harness's `abort` sets the engine idle without a `turn-done`, so a submission it stopped
   * must not leave the workflow queue waiting for an outcome that will never arrive.
   */
  private turnStopped(): void {
    this.submitted = false;
    this.sawBusy = false;
    this.pump();
  }

  /** A workflow's `agent` step: send a turn, queued until the engine is idle. */
  submitPrompt(text: string): void {
    this.enqueueSubmission({ op: "submit", text });
  }

  /** A workflow's `task` step: queue the task and start its turn. */
  submitTask(title: string, description: string, prompt: string): void {
    this.enqueueSubmission({ op: "submitTask", title, description, prompt });
  }

  /** A workflow's `setting` step: store the credential where the extension keeps credentials. */
  async storeSetting(key: string, value: string): Promise<void> {
    if (key === "apiKey") {
      await this.context.secrets.store(SECRET_KEY, value);
      // The key is handed to the engine at startup, so pick it up now when the panel is live.
      if (this.view !== undefined) {
        await this.startEngine();
      }
      return;
    }
    if (key === "githubToken") {
      await this.context.secrets.store(GITHUB_SECRET_KEY, value);
      return;
    }
    throw new Error(`\`${key}\` is not a setting a workflow may write`);
  }

  private enqueueSubmission(event: Record<string, unknown>): void {
    // Reveal the panel so the agent's work is where the user can see it, then queue. If the view is
    // not resolved yet, `resolveWebviewView` starts the engine and `ready` drains the queue.
    void vscode.commands.executeCommand(`${ADVANCE_VIEW_ID}.focus`).then(undefined, () => undefined);
    this.showChat = true;
    this.pending.push(event);
    this.pump();
  }

  /** Send the next queued submission when the engine is live and idle. */
  private pump(): void {
    if (!this.ready || this.worker === undefined || this.busy || this.submitted) {
      return;
    }
    const event = this.pending.shift();
    if (event === undefined) {
      return;
    }
    // A workflow's agent step is usually pressed from the Workflows surface; bring the transcript
    // forward so the turn is visible, exactly as the desktop's always-on chat pane is.
    if (this.showChat) {
      this.showChat = false;
      this.send({ type: "input", event: { op: "selectSurface", value: "chat" } });
    }
    this.send({ type: "input", event });
    this.submitted = true;
    this.sawBusy = false;
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
        // The webview's Escape/Stop sends `abort` as an input event rather than through `abort()`;
        // it must clear the same queue state.
        if (event?.op === "abort") {
          this.turnStopped();
        }
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
    this.generation += 1;
    this.ready = false;
    this.busy = false;
    this.submitted = false;
    this.sawBusy = false;
    this.workflowId = undefined;
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
    this.stopEngine();
    const generation = this.generation;
    const config = advanceSettings();
    const apiKey = await readApiKey(this.context);
    if (generation !== this.generation) {
      return;
    }
    if (apiKey.length === 0) {
      this.postStatus("No DeepSeek API key yet — run “DeepSeek: Set Zero API Key”.");
    }

    // A fresh engine replaces the whole conversation. Clear the old frame first: if the new engine
    // cannot start, the user sees an empty panel and the status, not the conversation they left.
    void this.view?.webview.postMessage({ type: "clear" });

    // Custom tools are global to the extension, not to this project. The folder is created once so
    // the harness's `/tools` root always has somewhere to write.
    const toolsDir = vscode.Uri.joinPath(this.context.globalStorageUri, "tools");
    try {
      mkdirSync(toolsDir.fsPath, { recursive: true });
    } catch {
      // A read-only global-storage location just means no new tools can be created; the rest works.
    }
    this.enabledTools = {
      ...(this.context.workspaceState.get<Record<string, boolean>>(TOOL_ENABLED_KEY) ?? {}),
    };
    const customTools = discoverCustomTools(toolsDir.fsPath);
    const workflowCatalogue = discoverWorkflowCatalogue(root.fsPath, this.enabledTools);

    // The gallery is shared by every workspace, so it lives beside the global tools. A clone failure
    // is reported but never stops the panel: everything else works without a gallery.
    const galleryDir = vscode.Uri.joinPath(this.context.globalStorageUri, GALLERY_DIR_NAME);
    const [gallery, githubToken] = await Promise.all([
      ensureGallery(galleryDir.fsPath, config.galleryUrl),
      this.context.secrets.get(GITHUB_SECRET_KEY),
    ]);
    if (generation !== this.generation) {
      return;
    }
    if (!gallery.ok) {
      this.postStatus(gallery.message);
    }

    const options: EngineOptions = {
      wasmPath,
      workspace: root.fsPath,
      toolsDir: toolsDir.fsPath,
      galleryDir: galleryDir.fsPath,
      galleryUrl: config.galleryUrl,
      githubToken: githubToken ?? "",
      customTools,
      workflowTools: workflowCatalogue.tools,
      enabledTools: this.enabledTools,
      workflowItems: workflowCatalogue.items,
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
      case "workflowRun": {
        const id = this.workflowId;
        const root = workspaceRoot();
        if (id === undefined || root === undefined) {
          return;
        }
        try {
          await runWorkflowDocument(this.context, root, id, {
            script: message.script,
            values: message.values,
          });
        } catch (error) {
          this.postStatus(`could not run ${id}: ${describe(error)}`);
        }
        return;
      }
      case "workflowClose":
        this.workflowId = undefined;
        return;
      case "busy":
        this.busy = message.busy;
        if (message.busy) {
          // Only a turn that actually ran can end without `turn-done` (the harness's own Stop
          // control calls `engine.abort()`, which reports nothing). The stale `busy\t0` drawn
          // before a just-sent prompt arrived must not count as that.
          this.sawBusy = true;
          return;
        }
        if (this.submitted && this.sawBusy) {
          this.submitted = false;
        }
        this.sawBusy = false;
        this.pump();
        return;
      case "turnDone":
        // A turn that could not start reports `turn-done` without ever being `busy`; the next
        // queued prompt must not wait for a busy transition that will not come.
        this.submitted = false;
        if (!this.busy) {
          this.sawBusy = false;
          this.pump();
        }
        return;
      case "toolEnabled": {
        // The harness owns the checkbox's immediate effect; this workspace owns the choice. A new
        // tool is absent from the map, which is why "disabled until the user allows it" needs no
        // second store. The in-memory map makes two quick ticks additive rather than last-wins.
        this.enabledTools[message.name] = message.enabled;
        await this.context.workspaceState.update(TOOL_ENABLED_KEY, this.enabledTools);
        return;
      }
      case "ready":
        this.ready = true;
        // The guest is live: hand it the theme the webview computed before it existed (or before
        // this restart), so it never draws a frame in the wrong palette.
        if (this.theme !== undefined) {
          this.send({ type: "input", event: this.theme });
        }
        this.pump();
        return;
      case "error":
        this.postStatus(message.message);
        void vscode.window.showErrorMessage(`Zero: ${message.message}`);
        return;
      default:
        return;
    }
  }

  /**
   * A workflow card was pressed: the harness cannot read `.advance/workflows`, so the host reads the
   * document and asks the module to draw its form. Run is pressed in the form, never here.
   */
  private async openWorkflow(id: string): Promise<void> {
    const root = workspaceRoot();
    // Only a document under the workflow folder: the id is what the harness built the card from,
    // and a card that names anything else has no form to draw.
    if (root === undefined || !isWorkflowDocumentId(id)) {
      return;
    }
    const document = readWorkflowDocument(root, id);
    if (document === undefined) {
      this.postStatus(`could not read ${id}`);
      return;
    }
    this.workflowId = id;
    this.send({
      type: "input",
      event: { op: "workflowForm", title: document.title, source: document.source },
    });
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
  // Workflow `agent`/`task`/`setting` steps reach the panel through this, so the runner never has to
  // import the panel (which imports the runner to answer a card's Run).
  setAdvanceBridge(panel);
  context.subscriptions.push(
    { dispose: () => setAdvanceBridge(undefined) },
    vscode.window.registerWebviewViewProvider(ADVANCE_VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("deepseek.advance.newChat", () => panel.newChat()),
    vscode.commands.registerCommand("deepseek.advance.abort", () => panel.abort()),
    vscode.commands.registerCommand("deepseek.advance.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "deepseek.advance"),
    ),
    vscode.commands.registerCommand("deepseek.advance.setGithubToken", async () => {
      const value = await vscode.window.showInputBox({
        title: "GitHub token for publishing to the Zero gallery",
        prompt:
          "Used only to push a branch when the agent publishes a tool. Stored in VS Code's " +
          "encrypted secret storage. Leave empty to clear it.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await context.secrets.delete(GITHUB_SECRET_KEY);
      } else {
        await context.secrets.store(GITHUB_SECRET_KEY, trimmed);
      }
      void vscode.window.showInformationMessage(
        trimmed.length > 0 ? "Zero: GitHub token saved." : "Zero: GitHub token cleared.",
      );
      // The token is handed to the engine at startup, so pick it up now.
      await panel.restart();
    }),
    vscode.commands.registerCommand("deepseek.advance.setApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "DeepSeek API key for the Zero panel",
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
