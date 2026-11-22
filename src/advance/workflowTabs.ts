// The workflow tab: one workflow, drawn by the harness as a markdown form.
//
// `DeepSeek: Show Workflow...` and `DeepSeek: Run Workflow...` discover `.advance/workflows/*.md`,
// let the user pick one, and open this tab. The tab hosts `advance_harness.wasm` on a worker thread
// exactly like the Advance panel does; it only differs in what it tells the module to draw: the
// workflow's own form, with its fields and `script` buttons.
//
// The harness cannot run a step (the allowlist and the executor are the host's), so a script's Run is
// a request. The form reports it as `workflowRun` with the answers its fields hold, and the host
// answers it with `runWorkflowDocument`. `Open Workflow Document...` is the way to the source.

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
import { readWorkflowDocument } from "./workflowFiles";
import { discoverWorkflows, type WorkflowBrief } from "./workflows";
import { runWorkflowDocument } from "./workflowRunner";
import { accountManager } from "../account/account";

const VIEW_TYPE = "deepseek.advanceWorkflow";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One workflow picker row, carrying the workflow it names. */
interface WorkflowPick extends vscode.QuickPickItem {
  workflow: WorkflowBrief;
}

/** The open workflow tabs, keyed by workflow id so the same document is not opened twice. */
const tabs = new Map<string, WorkflowTab>();

/** Register the workflow commands. */
export function registerWorkflowCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.advance.runWorkflow", () => runWorkflow(context)),
    vscode.commands.registerCommand("deepseek.advance.showWorkflow", () => showWorkflow(context)),
    vscode.commands.registerCommand("deepseek.advance.openWorkflowDocument", () =>
      openWorkflowSource(),
    ),
  );
}

/** The one picker all three workflow commands share. */
async function chooseWorkflow(
  title: string,
  placeHolder: string,
): Promise<{ root: vscode.Uri; workflow: WorkflowBrief } | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root === undefined) {
    void vscode.window.showInformationMessage(
      "Open a folder first: workflows live in .advance/workflows of the workspace.",
    );
    return undefined;
  }
  const workflows = discoverWorkflows(root.fsPath);
  if (workflows.length === 0) {
    void vscode.window.showInformationMessage(
      "No workflows found. Add a .md document under .advance/workflows, or ask the Zero agent to create one.",
    );
    return undefined;
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
      title,
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return picked === undefined ? undefined : { root, workflow: picked.workflow };
}

/** `DeepSeek: Run Workflow...`: pick one and open its form, so Run is the user's decision. */
async function runWorkflow(context: vscode.ExtensionContext): Promise<void> {
  await openWorkflowTab(context, "Run Workflow", "Select a workflow to run");
}

/** `DeepSeek: Show Workflow...`: open the harness-rendered form. */
async function showWorkflow(context: vscode.ExtensionContext): Promise<void> {
  await openWorkflowTab(context, "Show Workflow", "Select a workflow to show");
}

/** The picker both commands share; the form's Run is what actually starts a script. */
async function openWorkflowTab(
  context: vscode.ExtensionContext,
  title: string,
  placeHolder: string,
): Promise<void> {
  const choice = await chooseWorkflow(title, placeHolder);
  if (choice === undefined) {
    return;
  }
  const existing = tabs.get(choice.workflow.id);
  if (existing !== undefined) {
    existing.reveal();
    existing.refresh(choice.workflow);
    return;
  }
  tabs.set(choice.workflow.id, new WorkflowTab(context, choice.root, choice.workflow));
}

/** `DeepSeek: Open Workflow Document...`: open the source to review or edit. */
async function openWorkflowSource(): Promise<void> {
  const choice = await chooseWorkflow("Open Workflow Document", "Select a workflow to open");
  if (choice === undefined) {
    return;
  }
  const problem = await openWorkflowDocument(choice.root, choice.workflow.id);
  if (problem !== undefined) {
    void vscode.window.showErrorMessage(`Could not open ${choice.workflow.id}: ${problem}`);
  }
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
    const account = await accountManager(this.context).getAccess();
    const apiKey = account?.apiKey ?? (await readApiKey(this.context));
    if (generation !== this.generation) {
      return;
    }
    const document = readWorkflowDocument(this.root, this.workflow.id);
    if (document === undefined) {
      this.postStatus(`could not read ${this.workflow.id}`);
    }
    const options: EngineOptions = {
      wasmPath,
      workspace: this.root.fsPath,
      apiUrl: account?.chatUrl ?? config.apiUrl,
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
      workflowForm:
        document === undefined ? undefined : { title: document.title, source: document.source },
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
      case "workflowRun":
        await this.runWorkflow(message.script, message.values);
        return;
      case "workflowClose":
        this.panel.dispose();
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

  /** A script button in the form: run the script with the answers the form held. */
  private async runWorkflow(script: string, values: Record<string, string>): Promise<void> {
    try {
      await runWorkflowDocument(this.context, this.root, this.workflow.id, { script, values });
    } catch (error) {
      this.postStatus(`could not run ${this.workflow.id}: ${describe(error)}`);
    }
  }

  /** A card from the Workflows surface: show the document's form, never run it here. */
  private async openWorkflow(id: string): Promise<void> {
    if (!isWorkflowDocumentId(id) || id.trim().replace(/\\/g, "/") !== this.workflow.id) {
      return;
    }
    const document = readWorkflowDocument(this.root, this.workflow.id);
    if (document === undefined) {
      this.postStatus(`could not read ${this.workflow.id}`);
      return;
    }
    this.send({
      type: "input",
      event: { op: "workflowForm", title: document.title, source: document.source },
    });
  }
}
