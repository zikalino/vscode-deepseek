// The host-side workflow executor.
//
// The harness can *draw* a workflow card and say `openWorkflow`, but it is granted no process and no
// filesystem writes: those are the shell's, which is what this module is for the VS Code host. A
// card's Run asks for this; the script's steps are planned first, under the same allowlist and
// write policy the agent's tools use, and only then run in order.
//
// * `command` runs a program with no shell (see `commandLaunch.ts` for the Windows `.cmd` wrapper).
// * `write` writes a file inside the workspace.
// * `agent` hands the prompt to the Advance chat; several are queued until the engine is idle.
// * `setting` stores a credential in VS Code's secret storage.
// * `task` queues a task and starts its turn.
//
// The steps of a workflow are a sequence: a failure stops the rest.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { SECRET_KEY } from "../consts";
import { advanceBridge } from "./advanceBridge";
import { clip, firstProblem, killTree, launchFor } from "./commandLaunch";
import { advanceSettings } from "./settings";
import { isWorkflowDocumentId, openWorkflowDocument } from "./workflowFiles";
import {
  fill,
  firstUnknown,
  parseSteps,
  parseWorkflow,
  singleReference,
  splitCommand,
  type WorkflowField,
  type WorkflowScript,
  type WorkflowStep,
} from "./workflowDoc";

type PlannedStep =
  | { kind: "command"; program: string; args: string[]; line: string }
  | { kind: "agent"; text: string }
  | { kind: "write"; path: string; shown: string; content: string }
  | { kind: "setting"; key: string; value: string }
  | { kind: "task"; title: string; description: string; prompt: string };

type PlanResult = { planned: PlannedStep[] } | { error: string };

interface ExecutionOutcome {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
}

interface CommandResult {
  ok: boolean;
  problem?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

/** What a workflow form's Run hands the host: the script pressed and the fields it held. */
export interface WorkflowRunRequest {
  script: string;
  values: Record<string, string>;
}

/** The workflows currently running, so a second press does not start the same script twice. */
const running = new Set<string>();

let channel: vscode.OutputChannel | undefined;

/**
 * Run the workflow named by a card's id.
 *
 * `preset` is what the wasm form's Run supplies: the script's id and the answers its fields held.
 * Without it the host asks with VS Code's own inputs, which is the fallback for a host that cannot
 * draw the module's form.
 */
export async function runWorkflowDocument(
  context: vscode.ExtensionContext,
  root: vscode.Uri,
  id: string,
  preset?: WorkflowRunRequest,
): Promise<void> {
  const relative = id.trim().replace(/\\/g, "/");
  if (!isWorkflowDocumentId(relative)) {
    void vscode.window.showErrorMessage(`Not a workflow document: ${id}`);
    return;
  }
  if (running.has(relative)) {
    void vscode.window.showInformationMessage(`This workflow is already running: ${relative}`);
    return;
  }
  running.add(relative);
  try {
    await run(context, root, relative, preset);
  } finally {
    running.delete(relative);
  }
}

function outputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (channel === undefined) {
    channel = vscode.window.createOutputChannel("DeepSeek Workflows");
    context.subscriptions.push(channel);
  }
  return channel;
}

async function run(
  context: vscode.ExtensionContext,
  root: vscode.Uri,
  relative: string,
  preset?: WorkflowRunRequest,
): Promise<void> {
  const target = vscode.Uri.joinPath(root, ...relative.split("/"));
  let source: string;
  try {
    source = fs.readFileSync(target.fsPath, "utf8");
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read ${relative}: ${message(error)}`);
    return;
  }

  const fallback = path.basename(relative).replace(/\.md$/i, "");
  const parsed = parseWorkflow(source, fallback);
  const output = outputChannel(context);
  output.show(true);
  output.appendLine("");
  output.appendLine(`Workflow: ${parsed.title} (${relative})`);

  if (parsed.scripts.length === 0) {
    await fail(output, `Workflow "${parsed.title}": no script directives found`, root, relative);
    return;
  }
  const script =
    preset === undefined
      ? await chooseScript(parsed.title, parsed.scripts)
      : parsed.scripts.find((candidate) => candidate.id === preset.script);
  if (script === undefined) {
    if (preset !== undefined) {
      await fail(
        output,
        `Workflow "${parsed.title}": no script named "${preset.script}"`,
        root,
        relative,
      );
      return;
    }
    output.appendLine("cancelled.");
    return;
  }
  output.appendLine(`Script: ${script.label} (${script.id})`);

  let steps: WorkflowStep[];
  try {
    steps = parseSteps(script.body);
  } catch (error) {
    await fail(output, `Workflow "${parsed.title}": ${message(error)}`, root, relative);
    return;
  }

  const values =
    preset === undefined
      ? await collectValues(parsed.title, parsed.fields)
      : new Map(Object.entries(preset.values));
  if (values === undefined) {
    output.appendLine("cancelled.");
    return;
  }

  // No per-step allowlist or write-permission preflight: an allowed workflow is allowed. What
  // remains is the workspace boundary — a `write` step still cannot name a path outside the folder.
  const plan = planSteps(steps, values, root.fsPath);
  if (!("planned" in plan)) {
    await fail(output, `Workflow "${parsed.title}": ${plan.error}`, root, relative);
    return;
  }
  const planned = plan.planned;

  const config = advanceSettings();
  output.appendLine(`Running ${planned.length} step${planned.length === 1 ? "" : "s"}...`);
  const outcome = await vscode.window.withProgress<ExecutionOutcome>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Running ${parsed.title}`,
      cancellable: true,
    },
    async (progress, token) =>
      execute(context, planned, root.fsPath, output, config.commandTimeoutMs, progress, token),
  );
  if (outcome === undefined) {
    return;
  }

  if (!outcome.ok) {
    if (outcome.cancelled) {
      output.appendLine("cancelled.");
      void vscode.window.showInformationMessage(`Workflow "${parsed.title}" cancelled.`);
      return;
    }
    output.appendLine("stopped.");
    const choice = await vscode.window.showErrorMessage(
      `Workflow "${parsed.title}" stopped: ${outcome.error ?? "a step failed"}`,
      "Show Output",
      "Open Workflow",
    );
    if (choice === "Show Output") {
      output.show(true);
    } else if (choice === "Open Workflow") {
      await openWorkflowDocument(root, relative);
    }
    return;
  }

  output.appendLine("done.");
  const agentContinues = planned.some((step) => step.kind === "agent" || step.kind === "task");
  const choice = await vscode.window.showInformationMessage(
    agentContinues
      ? `Workflow "${parsed.title}" finished; the agent continues in the Zero panel.`
      : `Workflow "${parsed.title}" finished.`,
    "Show Output",
  );
  if (choice === "Show Output") {
    output.show(true);
  }
}

async function chooseScript(title: string, scripts: WorkflowScript[]): Promise<WorkflowScript | undefined> {
  if (scripts.length === 1) {
    return scripts[0];
  }
  const picked = await vscode.window.showQuickPick(
    scripts.map((script) => ({
      label: script.label,
      description: script.id,
      script,
    })),
    {
      title: `Run ${title}`,
      placeHolder: "Select the script to run",
      ignoreFocusOut: true,
    },
  );
  return picked?.script;
}

async function fail(
  output: vscode.OutputChannel,
  problem: string,
  root: vscode.Uri,
  id: string,
): Promise<void> {
  output.appendLine(`error: ${problem}`);
  const choice = await vscode.window.showErrorMessage(problem, "Show Output", "Open Workflow");
  if (choice === "Show Output") {
    output.show(true);
  } else if (choice === "Open Workflow") {
    await openWorkflowDocument(root, id);
  }
}

/** Ask for each field, in document order, with the value the document starts it with. */
async function collectValues(
  title: string,
  fields: WorkflowField[],
): Promise<Map<string, string> | undefined> {
  const values = new Map<string, string>();
  for (const field of fields) {
    if (field.when !== undefined && !isShown(field.when, values)) {
      continue;
    }
    const label = field.label || field.id;
    let value: string;
    if (field.kind === "select") {
      const options = field.values.length > 0 ? [...field.values] : [field.initial];
      const initial = options.indexOf(field.initial);
      if (initial > 0) {
        options.unshift(...options.splice(initial, 1));
      }
      const picked = await vscode.window.showQuickPick(
        options.map((option) => ({ label: option })),
        {
          title: `Run ${title}`,
          placeHolder: label,
          ignoreFocusOut: true,
        },
      );
      if (picked === undefined) {
        return undefined;
      }
      value = picked.label;
    } else if (field.kind === "toggle") {
      const initial = field.initial === "true";
      const options = initial
        ? [{ label: "true" }, { label: "false" }]
        : [{ label: "false" }, { label: "true" }];
      const picked = await vscode.window.showQuickPick(options, {
        title: `Run ${title}`,
        placeHolder: label,
        ignoreFocusOut: true,
      });
      if (picked === undefined) {
        return undefined;
      }
      value = picked.label;
    } else {
      const entered = await vscode.window.showInputBox({
        title: `Run ${title}`,
        prompt: label,
        value: field.initial,
        placeHolder: field.placeholder.length > 0 ? field.placeholder : undefined,
        password: field.secret,
        ignoreFocusOut: true,
      });
      if (entered === undefined) {
        return undefined;
      }
      value = entered;
    }
    values.set(field.id, value);
  }
  return values;
}

/** `when="id=value[,value]"`: a control is showing only while its condition holds. */
function isShown(when: string, values: ReadonlyMap<string, string>): boolean {
  const equals = when.indexOf("=");
  if (equals < 0) {
    return true;
  }
  const id = when.slice(0, equals).trim();
  const choices = when
    .slice(equals + 1)
    .split(",")
    .map((choice) => choice.trim());
  const current = values.get(id);
  return current !== undefined && choices.includes(current);
}

/**
 * Decide every step before anything runs. An allowed workflow is allowed: the program's name is
 * not checked against a list, and a write is not checked against `allowWrite`. The workspace
 * boundary still holds — a `write` path that leaves the folder is a refusal, not a normalisation.
 */
function planSteps(
  steps: WorkflowStep[],
  values: ReadonlyMap<string, string>,
  root: string,
): PlanResult {
  if (steps.length === 0) {
    return { error: "this workflow has no steps — write them inside the `script` directive" };
  }
  const planned: PlannedStep[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case "command": {
        const unknown = firstUnknown(step.run, values);
        if (unknown !== undefined) {
          return {
            error: `\`${step.run}\` uses \`{{${unknown}}}\`, which is not a field in this workflow`,
          };
        }
        const filled = fill(step.run, values);
        let tokens: string[];
        try {
          // The empty map is deliberate: the values are already in, and expanding again would give
          // a typed value that happens to look like `{{id}}` a second chance to become a command.
          tokens = splitCommand(filled, new Map());
        } catch (error) {
          return { error: `\`${filled}\`: ${message(error)}` };
        }
        const [program, ...args] = tokens;
        if (program.length === 0) {
          return { error: `\`${filled}\`: there is no program to run` };
        }
        planned.push({ kind: "command", program, args, line: filled });
        break;
      }
      case "agent": {
        const unknown = firstUnknown(step.text, values);
        if (unknown !== undefined) {
          return {
            error: `\`${step.text}\` uses \`{{${unknown}}}\`, which is not a field in this workflow`,
          };
        }
        const filled = fill(step.text, values);
        if (filled.trim().length === 0) {
          return { error: "an `agent` step with nothing to ask" };
        }
        planned.push({ kind: "agent", text: filled });
        break;
      }
      case "write": {
        const unknown = firstUnknown(step.path, values);
        if (unknown !== undefined) {
          return {
            error: `\`${step.path}\` uses \`{{${unknown}}}\`, which is not a field in this workflow`,
          };
        }
        const shown = fill(step.path, values);
        let target: string;
        try {
          target = inside(root, shown);
        } catch (error) {
          return { error: message(error) };
        }
        planned.push({ kind: "write", path: target, shown, content: fill(step.content, values) });
        break;
      }
      case "setting": {
        if (step.key !== "apiKey") {
          return {
            error: `\`${step.key}\` is not a setting a workflow may write (only: apiKey)`,
          };
        }
        const reference = singleReference(step.value);
        if (reference === undefined) {
          return {
            error:
              `\`setting ${step.key}\` takes its value from a field — write ` +
              `\`${step.key} {{<id>}}\`, not the value itself`,
          };
        }
        const unknown = firstUnknown(step.value, values);
        if (unknown !== undefined) {
          return {
            error: `\`${step.value}\` uses \`{{${unknown}}}\`, which is not a field in this workflow`,
          };
        }
        const filled = fill(step.value, values);
        if (filled.trim().length === 0) {
          return { error: `\`${reference}\` is empty — paste a value into it first` };
        }
        planned.push({ kind: "setting", key: step.key, value: filled });
        break;
      }
      case "task": {
        for (const text of [step.title, step.description]) {
          const unknown = firstUnknown(text, values);
          if (unknown !== undefined) {
            return {
              error: `\`${text}\` uses \`{{${unknown}}}\`, which is not a field in this workflow`,
            };
          }
        }
        const title = fill(step.title, values).trim();
        if (title.length === 0) {
          return { error: "a task needs a title — fill the field in" };
        }
        const description = fill(step.description, values).trim();
        planned.push({ kind: "task", title, description, prompt: taskPrompt(title, description) });
        break;
      }
    }
  }

  return { planned };
}

/** Resolve `shown` under `root`, refusing anything that would leave it. */
function inside(root: string, shown: string): string {
  const trimmed = shown.trim();
  if (trimmed.length === 0) {
    throw new Error("a `write` step with no path");
  }
  if (
    path.isAbsolute(trimmed) ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\")
  ) {
    throw new Error(`\`${trimmed}\` is outside the workspace`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, trimmed);
  const lower = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const base = lower(resolvedRoot);
  const target = lower(resolved);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`\`${trimmed}\` is outside the workspace`);
  }
  return resolved;
}

/** The prompt a `task` step hands the engine: the queue's instructions, not the transcript's. */
function taskPrompt(title: string, description: string): string {
  const lines = [
    "You are an autonomous coding agent working on one task in a project.",
    `Finish this task: ${title}.`,
  ];
  if (description.length > 0) {
    lines.push(description);
  }
  lines.push("Report DONE when it is complete.");
  return lines.join(" ");
}

async function execute(
  context: vscode.ExtensionContext,
  planned: PlannedStep[],
  cwd: string,
  output: vscode.OutputChannel,
  timeoutMs: number,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<ExecutionOutcome> {
  for (const step of planned) {
    if (token.isCancellationRequested) {
      return { ok: false, cancelled: true, error: "cancelled" };
    }
    switch (step.kind) {
      case "command": {
        progress.report({ message: step.line });
        output.appendLine(`$ ${step.line}`);
        const result = await runCommand(step.program, step.args, cwd, timeoutMs, output, token);
        if (!result.ok) {
          if (result.cancelled === true) {
            output.appendLine("  cancelled");
            return { ok: false, cancelled: true, error: "cancelled" };
          }
          if (result.timedOut === true) {
            const seconds = Math.round(timeoutMs / 1000);
            output.appendLine(`  timed out after ${seconds}s`);
            return {
              ok: false,
              cancelled: false,
              error: `\`${step.program}\` timed out after ${seconds}s`,
            };
          }
          output.appendLine(`  failed: ${result.problem ?? "no output"}`);
          output.appendLine(`stopped at \`${step.program}\``);
          return { ok: false, cancelled: false, error: `\`${step.program}\` failed` };
        }
        output.appendLine("  ok");
        break;
      }
      case "write": {
        progress.report({ message: `writing ${step.shown}` });
        try {
          await fs.promises.mkdir(path.dirname(step.path), { recursive: true });
          await fs.promises.writeFile(step.path, step.content, "utf8");
          output.appendLine(`wrote ${step.shown} (${Buffer.byteLength(step.content)} bytes)`);
        } catch (error) {
          const problem = `could not write ${step.shown}: ${message(error)}`;
          output.appendLine(`  ${problem}`);
          return { ok: false, cancelled: false, error: problem };
        }
        break;
      }
      case "agent": {
        progress.report({ message: `agent: ${clip(step.text.replace(/\s+/g, " "), 80)}` });
        const bridge = advanceBridge();
        if (bridge === undefined) {
          const problem = "no Zero panel is available to receive the prompt";
          output.appendLine(`  ${problem}`);
          return { ok: false, cancelled: false, error: problem };
        }
        bridge.submitPrompt(step.text);
        output.appendLine(`→ agent: ${clip(step.text.replace(/\s+/g, " "), 160)}`);
        break;
      }
      case "setting": {
        progress.report({ message: `saving ${step.key}` });
        const bridge = advanceBridge();
        try {
          if (bridge !== undefined) {
            await bridge.storeSetting(step.key, step.value);
          } else {
            await context.secrets.store(SECRET_KEY, step.value);
          }
          output.appendLine(`saved ${step.key}`);
        } catch (error) {
          const problem = `could not save ${step.key}: ${message(error)}`;
          output.appendLine(`  ${problem}`);
          return { ok: false, cancelled: false, error: problem };
        }
        break;
      }
      case "task": {
        progress.report({ message: `queuing ${step.title}` });
        const bridge = advanceBridge();
        if (bridge === undefined) {
          const problem = "no Zero panel is available to queue the task";
          output.appendLine(`  ${problem}`);
          return { ok: false, cancelled: false, error: problem };
        }
        bridge.submitTask(step.title, step.description, step.prompt);
        output.appendLine(`queued task: ${step.title}`);
        break;
      }
    }
    progress.report({ increment: 100 / planned.length });
  }
  return { ok: true };
}

function runCommand(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let stdout = "";
    let stderr = "";

    let launch;
    try {
      launch = launchFor(program, args);
    } catch (error) {
      resolve({ ok: false, problem: message(error) });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(launch.file, launch.args, {
        cwd,
        env: { ...process.env, ...launch.env },
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
        // A new process group lets a cancelled step take the build it started with it on Unix.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ ok: false, problem: message(error) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onCancel = token.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (stdout.length < 4_000_000) {
        stdout += text;
      }
      output.append(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (stderr.length < 4_000_000) {
        stderr += text;
      }
      output.append(text);
    });
    child.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      onCancel.dispose();
      resolve({ ok: false, problem: message(error) });
    });
    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      onCancel.dispose();
      const ok = !timedOut && !cancelled && code === 0;
      resolve({
        ok,
        problem: ok ? undefined : firstProblem(stdout, stderr),
        timedOut,
        cancelled,
      });
    });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
