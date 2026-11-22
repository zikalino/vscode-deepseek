// The workflow tab: one workflow, drawn by the harness's Workflows surface.
//
// `DeepSeek: Run Workflow...` discovers `.advance/workflows/*.md`, lets the user pick one, and opens
// this tab. The tab hosts `advance_harness.wasm` on a worker thread exactly like the Advance panel
// does; it only differs in what it tells the module to draw: the Workflows surface, with a list that
// holds the one workflow the user picked. The module is the painter, so the card is the same card
// the Advance panel's Workflows surface draws.
//
// The harness cannot run a step (the allowlist and the executor are the host's), so the card's Run
// pill is a request to open the document; that is what the card does in the Advance panel too.

import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";

import {
  advanceSettings,
  isWorkflowDocumentId,
  openWorkflowDocument,
  panelHtml,
  readApiKey,
  resolveHarnessWasm,
} from "./panel";
import type { EngineOptions, EngineRequest, EngineResponse } from "./protocol";
import { discoverWorkflows, type WorkflowBrief } from "./workflows";

const VIEW_TYPE = "deepseek.advanceWorkflow";

/** One workflow picker row, carrying the workflow it names. */
interface WorkflowPick extends vscode.QuickPickItem {
  workflow: WorkflowBrief;
}

/** The open workflow tabs, keyed by workflow id so the same document is not opened twice. */
const tabs = new Map<string, WorkflowTab>();

/** Register `DeepSeek: Run Workflow...`. */
export function registerWorkflowCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.advance.runWorkflow", () => runWorkflow(context)),
  );
}

async function runWorkflow(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root === undefined) {
    void vscode.window.showInformationMessage(
      "Open a folder first: workflows live in .advance/workflows of the workspace.",
    );
    return;
  }
  const workflows = discoverWorkflows(root.fsPath);
  if (workflows.length === 0) {
    void vscode.window.showInformationMessage(
      "No workflows found. Add a .md document under .advance/workflows, or ask the Advance agent to create one.",
    );
    return;
  }
  const picked = await vscode.window.showQuickPick<WorkflowPick>(
    workflows.map((workflow) => ({
      label: workflow.title || path.basename(workflow.id),
      description: workflow.steps === 1 ? "1 step" : `${workflow.steps} steps`,
      detail: workflow.description
        ? `${workflow.id} — ${workflow.description}`
        : workflow.id,
      workflow,
    })),
    {
      title: "Run Workflow",
      placeHolder: "Select a workflow to render",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (picked === undefined) {
    return;
  }
  const existing = tabs.get(picked.workflow.id);
  if (existing !== undefined) {
    existing.reveal();
    existing.refresh(picked.workflow);
    return;
  }
  tabs.set(picked.workflow.id, new WorkflowTab(context, root, picked.workflow));
}

/** One editor tab, with its own engine worker and its own scene. */
class WorkflowTab {
  private readonly panel: vscode.WebviewPanel;
  private readonly media: vscode.Uri;
  private worker: Worker | undefined;
  /** Bumped by every start/stop so an in-flight async start cannot install a stale worker. */
  private generation = 0;
  /** The last theme the webview computed, replayed once the module is live. */
  private theme: Record<string, unknown> | undefined;
  /** The last canvas size the webview reported, replayed to the engine at startup. */
  private size: { width: number; height: number } | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: vscode.Uri,
    private workflow: WorkflowBrief,
  ) {
    this.media = vscode.Uri.joinPath(context.extensionUri, "media");
    const title = workflow.title || path.basename(workflow.id);
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [this.media],
        retainContextWhenHidden: true,
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.media, "advance.svg");
    this.panel.webview.html = panelHtml(this.panel.webview, this.media, title);
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message);
    });
    this.panel.onDidDispose(() => {
      this.stopEngine();
      if (tabs.get(this.workflow.id) === this) {
        tabs.delete(this.workflow.id);
      }
    });
    void this.startEngine();
  }

  /** Bring this workflow's tab to the front. */
  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  /** Re-read the workflow and start a fresh engine, keeping the one tab. */
  refresh(workflow: WorkflowBrief): void {
    this.workflow = workflow;
    this.panel.title = workflow.title || path.basename(workflow.id);
    this.stopEngine();
    // A fresh engine replaces the card; clear the old one first so a slow start does not leave the
    // previous workflow on screen under the new tab title.
    void this.panel.webview.postMessage({ type: "clear" });
    void this.startEngine();
  }

  private send(message: EngineRequest): void {
    this.worker?.postMessage(message);
  }

  private postStatus(message: string): void {
    void this.panel.webview.postMessage({ type: "status", message });
  }

  private async receive(message: unknown): Promise<void> {
    const command = message as { type?: string };
    switch (command.type) {
      case "ready":
        return;
      case "input": {
        const event = (message as { event?: Record<string, unknown> }).event;
        // Keep the theme: a fresh engine needs it replayed, and the webview cannot know when the
        // worker's guest is ready.
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
    this.generation += 1;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      worker.postMessage({ type: "stop" } satisfies EngineRequest);
      void worker.terminate();
    }
  }

  private async startEngine(): Promise<void> {
    const generation = ++this.generation;
    const wasmPath = resolveHarnessWasm(this.root.fsPath, this.context.extensionPath);
    if (wasmPath === undefined) {
      this.postStatus(
        "advance_harness.wasm not found — build it with " +
          "`cargo build -p advance-harness --target wasm32-unknown-unknown --release`.",
      );
      return;
    }
    const config = advanceSettings();
    const apiKey = await readApiKey(this.context);
    if (generation !== this.generation) {
      return;
    }
    const options: EngineOptions = {
      wasmPath,
      workspace: this.root.fsPath,
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
      surface: "workflows",
      bar: false,
      workflowItems: [this.workflow],
    };
    const worker = new Worker(
      path.join(this.context.extensionPath, "out", "advance", "engine-worker.js"),
      { workerData: options },
    );
    this.worker = worker;
    worker.on("message", (message: EngineResponse) => {
      // terminate() does not recall a message already on its way, and a replaced worker must not
      // paint its card over its successor's.
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
        void this.panel.webview.postMessage(message);
        return;
      case "status":
        this.postStatus(message.message);
        return;
      case "openWorkflow":
        await this.openWorkflow(message.path);
        return;
      case "ready":
        // The guest is live: hand it the theme the webview computed before it existed.
        if (this.theme !== undefined) {
          this.send({ type: "input", event: this.theme });
        }
        return;
      case "error":
        this.postStatus(message.message);
        void vscode.window.showErrorMessage(`Advance workflow: ${message.message}`);
        return;
      default:
        return;
    }
  }

  /** The card's Run pill: the harness asks for the document, and the user runs it from there. */
  private async openWorkflow(id: string): Promise<void> {
    if (!isWorkflowDocumentId(id)) {
      return;
    }
    const problem = await openWorkflowDocument(this.root, id);
    if (problem !== undefined) {
      this.postStatus(`could not open ${id}: ${problem}`);
    }
  }
}
