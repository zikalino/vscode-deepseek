// Discovery for the harness's Workflows surface.
//
// A workflow is a document in `<workspace>/.advance/workflows/*.md` (see the Advance project's
// `docs/workflows.md`). The harness may *write* one, but it is granted no read of the folder, so
// discovery is the host's: this module lists the folder and takes the few fields the surface's
// cards need. It is separate from the engine worker so it can be run without a wasm module.

import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import { parseSteps, parseWorkflow } from "./workflowDoc";
import { sanitizeName, type CustomToolDefinition } from "./toolCatalogue";

/** One workflow file, in the shape the harness's Workflows surface reads. */
export interface WorkflowBrief {
  id: string;
  title: string;
  description: string;
  steps: number;
  source: string;
  /** The function name when this workflow is also an agent tool; empty when it is not. */
  toolName: string;
  /** Whether the user allows the agent to run it. */
  enabled: boolean;
}

/** Where a workspace keeps its workflows, relative to its root. */
const WORKFLOW_DIR = ".advance/workflows";

/**
 * The workspace's workflows, in the order the surface lists them.
 *
 * This is one listing: workflows the agent creates during the session are added by the harness
 * itself, which saw the file it wrote. A folder that does not exist is an empty list, not an error.
 */
export function discoverWorkflows(workspace: string): WorkflowBrief[] {
  return discoverWorkflowCatalogue(workspace).items;
}

/**
 * The workspace's workflows and the single-script ones that can be model tools.
 *
 * A workflow with one script whose steps are all `command`/`write` becomes a tool: its form fields
 * are the parameters and its script is the body. A workflow with several buttons has no one thing a
 * call would run, and `agent`/`setting`/`task` steps need the host's bridge, so neither is exposed.
 */
export function discoverWorkflowCatalogue(
  workspace: string,
  enabled: Readonly<Record<string, boolean>> = {},
): { items: WorkflowBrief[]; tools: CustomToolDefinition[] } {
  const directory = path.join(workspace, ".advance", "workflows");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    return { items: [], tools: [] };
  }
  names.sort();
  const items: WorkflowBrief[] = [];
  const tools: CustomToolDefinition[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(path.join(directory, name), "utf8");
    } catch {
      continue;
    }
    const summary = summarize(name, text);
    const tool = agentToolFor(text, name.replace(/\.md$/i, ""), summary.description);
    const toolName = tool?.name ?? "";
    items.push({
      id: `${WORKFLOW_DIR}/${name}`,
      ...summary,
      source: "workspace",
      toolName,
      enabled: toolName.length > 0 && enabled[toolName] === true,
    });
    if (tool !== undefined && !seen.has(tool.name)) {
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return { items, tools };
}

/** The tool a workflow document stands for, when it has exactly one runnable script. */
function agentToolFor(
  text: string,
  fallbackName: string,
  description: string,
): CustomToolDefinition | undefined {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const { fields } = splitFrontmatter(source);
  const parsed = parseWorkflow(source, fallbackName);
  if (parsed.scripts.length !== 1) {
    return undefined;
  }
  let steps;
  try {
    steps = parseSteps(parsed.scripts[0].body);
  } catch {
    return undefined;
  }
  if (steps.length === 0 || steps.some((step) => step.kind !== "command" && step.kind !== "write")) {
    return undefined;
  }
  const toolSteps: CustomToolDefinition["steps"] = [];
  for (const step of steps) {
    if (step.kind === "command") {
      toolSteps.push({ kind: "command", value: step.run });
    } else if (step.kind === "write") {
      toolSteps.push({ kind: "write", value: step.path, content: step.content });
    }
  }
  const name = sanitizeName((fields.name || fallbackName).trim(), "workflow");
  return {
    name,
    title: parsed.title,
    description,
    params: parsed.fields.map((field) => ({
      id: field.id,
      type: field.kind === "toggle" ? "boolean" : "string",
      label: field.label,
      description: "",
      required: true,
      default: field.initial,
      values:
        field.kind === "select" && field.values.length > 0 ? field.values : undefined,
    })),
    steps: toolSteps,
    output: "",
    source: "workflow",
  };
}

/** What a card shows: the name the document gives itself, what it does, and how many steps. */
function summarize(
  name: string,
  text: string,
): { title: string; description: string; steps: number } {
  // A BOM is common in files a Windows editor wrote; it would hide the frontmatter's first `---`.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const { fields, body } = splitFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const fallback = firstHeading(lines) ?? name.replace(/\.md$/i, "");
  return {
    title: fields.title || fallback,
    description: fields.description || firstParagraph(lines),
    steps: countSteps(lines),
  };
}

/** The frontmatter fields, lower-cased, and the document without them. */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  if (!/^---\r?\n/.test(text)) {
    return { fields, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    return { fields, body: text };
  }
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[2].length > 0) {
      fields[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return { fields, body: text.slice(end + 4) };
}

/** The document's `# ` heading, up to the first control: a `#` inside a script is a comment. */
function firstHeading(lines: string[]): string | undefined {
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("<!--")) {
      break;
    }
    if (/^#\s+\S/.test(line)) {
      return line.replace(/^#\s+/, "");
    }
  }
  return undefined;
}

/** The description: the plain line between the heading and the first control, if there is one. */
function firstParagraph(lines: string[]): string {
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("<!--")) {
      return "";
    }
    return line;
  }
  return "";
}

/** Step lines inside the `<!-- script ... -->` blocks; a `write`/`task` body is not a step. */
function countSteps(lines: string[]): number {
  let steps = 0;
  let inScript = false;
  let inBody = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inScript) {
      if (/^<!--\s*script\b/.test(line)) {
        inScript = true;
      }
      continue;
    }
    if (/^<!--\s*end\s*-->\s*$/.test(line)) {
      inScript = false;
      inBody = false;
      continue;
    }
    if (inBody) {
      if (line === "end") {
        inBody = false;
      }
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    steps += 1;
    if (/^(write|task)\b/.test(line)) {
      inBody = true;
    }
  }
  return steps;
}
