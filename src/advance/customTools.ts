// Discovery for the global custom-tool folder.
//
// A custom tool is a markdown document in `<globalStorage>/tools/*.md`. It uses the same directive
// syntax as a workflow form — `param` declares an argument, `script` holds the steps, and `output`
// is the result template — but it has no dialog: the model calls it, and the harness runs it.
//
// The folder is global (it belongs to the extension, not the project), so the harness is granted a
// `/tools` root for writing one and this module reads the folder back on the next engine start.

import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import * as path from "node:path";

import { parseSteps } from "./workflowDoc";
import {
  sanitizeName,
  type CustomToolDefinition,
  type ToolParameter,
  type ToolStep,
} from "./toolCatalogue";

/**
 * Every custom tool in `directory`, in name order.
 *
 * A tool the agent creates is a flat `<name>.md`; a tool installed from the gallery is a folder
 * `<id>/tool.md` (supporting files may sit beside it). Both are the same document to the harness.
 */
export function discoverCustomTools(directory: string): CustomToolDefinition[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const tools: CustomToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let file: string | undefined;
    let fallback: string;
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      file = path.join(directory, entry.name);
      fallback = entry.name.replace(/\.md$/i, "");
    } else if (entry.isDirectory()) {
      fallback = entry.name;
      for (const candidate of ["tool.md", `${entry.name}.md`, "index.md"]) {
        const candidatePath = path.join(directory, entry.name, candidate);
        if (existsSync(candidatePath)) {
          file = candidatePath;
          break;
        }
      }
    } else {
      continue;
    }
    if (file === undefined) {
      continue;
    }
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const tool = parseCustomTool(source, fallback);
    if (tool === undefined || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

/** Parse one custom-tool document. `undefined` when it has no callable steps. */
export function parseCustomTool(
  source: string,
  fallbackName: string,
): CustomToolDefinition | undefined {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const { fields: meta, body } = splitFrontmatter(text);
  const rawName = (meta.name || fallbackName).trim();
  const name = sanitizeName(rawName, "tool");
  const title = (meta.title || firstHeading(body.split(/\r?\n/)) || rawName || name).trim();
  const description = (meta.description || firstParagraph(body.split(/\r?\n/)) || "").trim();

  const params: ToolParameter[] = [];
  let output = meta.output ?? "";
  let scriptBody: string | undefined;

  let cursor = 0;
  while (cursor < body.length) {
    const open = body.indexOf("<!--", cursor);
    if (open < 0) {
      break;
    }
    const close = body.indexOf("-->", open + 4);
    if (close < 0) {
      break;
    }
    const directive = parseDirective(body.slice(open + 4, close));
    cursor = close + 3;
    if (directive === undefined) {
      continue;
    }
    if (directive.name === "param") {
      const param = parseParam(directive.attrs);
      if (param !== undefined) {
        params.push(param);
      }
      continue;
    }
    if (directive.name === "output" || directive.name === "script") {
      const end = findEnd(body, cursor);
      const content = end === undefined ? body.slice(cursor) : body.slice(cursor, end.index);
      cursor = end === undefined ? body.length : end.index + end.length;
      if (directive.name === "output") {
        output = content;
      } else if (scriptBody === undefined) {
        scriptBody = content;
      }
    }
  }

  if (scriptBody === undefined) {
    return undefined;
  }
  let steps;
  try {
    steps = parseSteps(scriptBody);
  } catch {
    return undefined;
  }
  if (steps.length === 0 || steps.some((step) => step.kind !== "command" && step.kind !== "write")) {
    return undefined;
  }
  const toolSteps: ToolStep[] = [];
  for (const step of steps) {
    if (step.kind === "command") {
      toolSteps.push({ kind: "command", value: step.run });
    } else if (step.kind === "write") {
      toolSteps.push({ kind: "write", value: step.path, content: step.content });
    }
  }
  if (toolSteps.length === 0) {
    return undefined;
  }

  return {
    name,
    title: title || name,
    description,
    params,
    steps: toolSteps,
    output: output.trim(),
    source: "custom",
  };
}

function parseParam(attrs: Map<string, string>): ToolParameter | undefined {
  const id = attrs.get("id")?.trim();
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  const kind = (attrs.get("type") || "string").trim().toLowerCase();
  const required = attrs.has("required") && attrs.get("required") !== "false";
  const values = (attrs.get("values") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return {
    id,
    type:
      kind === "number" || kind === "integer"
        ? "number"
        : kind === "boolean"
          ? "boolean"
          : "string",
    label: attrs.get("label")?.trim() || id,
    description: attrs.get("description")?.trim() || "",
    required,
    default: attrs.get("default") ?? "",
    values: values.length > 0 ? values : undefined,
  };
}

interface Directive {
  name: string;
  attrs: Map<string, string>;
}

function parseDirective(inner: string): Directive | undefined {
  const match = /^\s*([A-Za-z0-9_-]+)([\s\S]*)$/.exec(inner);
  if (match === null) {
    return undefined;
  }
  const attrs = new Map<string, string>();
  const attribute = /([A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  let found: RegExpExecArray | null;
  while ((found = attribute.exec(match[2])) !== null) {
    attrs.set(found[1].toLowerCase(), found[2] ?? found[3] ?? found[4] ?? "");
  }
  return { name: match[1].toLowerCase(), attrs };
}

interface EndMarker {
  index: number;
  length: number;
}

function findEnd(text: string, cursor: number): EndMarker | undefined {
  const marker = /<!--\s*end\s*-->/gi;
  marker.lastIndex = cursor;
  const found = marker.exec(text);
  return found === null ? undefined : { index: found.index, length: found[0].length };
}

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

function firstParagraph(lines: string[]): string | undefined {
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("<!--")) {
      return undefined;
    }
    return line;
  }
  return undefined;
}
