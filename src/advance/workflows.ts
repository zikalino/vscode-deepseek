// Discovery for the harness's Workflows surface.
//
// A workflow is a document in `<workspace>/.advance/workflows/*.md` (see the Advance project's
// `docs/workflows.md`). The harness may *write* one, but it is granted no read of the folder, so
// discovery is the host's: this module lists the folder and takes the few fields the surface's
// cards need. It is separate from the engine worker so it can be run without a wasm module.

import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

/** One workflow file, in the shape the harness's Workflows surface reads. */
export interface WorkflowBrief {
  id: string;
  title: string;
  description: string;
  steps: number;
  source: string;
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
  const directory = path.join(workspace, ".advance", "workflows");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  names.sort();
  const items: WorkflowBrief[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(path.join(directory, name), "utf8");
    } catch {
      continue;
    }
    const summary = summarize(name, text);
    items.push({ id: `${WORKFLOW_DIR}/${name}`, ...summary, source: "workspace" });
  }
  return items;
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
