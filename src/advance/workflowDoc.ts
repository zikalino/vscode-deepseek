// Markdown workflow parsing for the VS Code host.
//
// A workflow is the document described by the Advance project's `docs/workflows.md`: markdown form
// controls in HTML comments, plus `script` directives whose bodies are the steps the host runs.
// This module is pure (no `vscode`, no `node:fs`) so the parser and the step language can be tested
// on their own; `workflowRunner.ts` adds the prompts, the policy and the process execution.

export type FieldKind = "input" | "select" | "toggle" | "editable";

/** One form control whose value is an answer. Scripts and buttons are not answers. */
export interface WorkflowField {
  id: string;
  kind: FieldKind;
  label: string;
  placeholder: string;
  secret: boolean;
  /** The value the dialog starts with. */
  initial: string;
  /** The choices of a `select`, in the order the document lists them. */
  values: string[];
  /** A `when="id=value[,value]"` guard, if the control has one. */
  when?: string;
}

/** One `script` directive: a button and the steps it stands for. */
export interface WorkflowScript {
  id: string;
  label: string;
  body: string;
}

export interface ParsedWorkflow {
  title: string;
  fields: WorkflowField[];
  scripts: WorkflowScript[];
}

/** One step of a script, as `docs/workflows.md` describes the step language. */
export type WorkflowStep =
  | { kind: "command"; run: string }
  | { kind: "agent"; text: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "setting"; key: string; value: string }
  | { kind: "task"; title: string; description: string };

/** Parse a workflow document. `fallbackTitle` is the file's stem, used when it names itself nowhere. */
export function parseWorkflow(source: string, fallbackTitle: string): ParsedWorkflow {
  // A BOM is common in files a Windows editor wrote; it would hide the frontmatter's first `---`.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const { fields: meta, body } = splitFrontmatter(text);
  const title = (meta.title || "").trim() || firstHeading(body.split(/\r?\n/)) || fallbackTitle;
  const fields: WorkflowField[] = [];
  const scripts: WorkflowScript[] = [];

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
    const { name, attrs } = directive;

    if (name === "input") {
      const id = attrs.get("id")?.trim();
      if (id !== undefined && id.length > 0) {
        fields.push(field(id, "input", attrs));
      }
      continue;
    }
    if (name === "button") {
      // A button is a caption, never an answer.
      continue;
    }
    if (name === "select" || name === "toggle" || name === "editable" || name === "script") {
      const end = findEnd(body, cursor);
      const content = end === undefined ? body.slice(cursor) : body.slice(cursor, end.index);
      cursor = end === undefined ? body.length : end.index + end.length;
      if (name === "script") {
        const id = attrs.get("id")?.trim() || `script-${scripts.length + 1}`;
        scripts.push({ id, label: attrs.get("label")?.trim() || id, body: content });
        continue;
      }
      const id = attrs.get("id")?.trim();
      if (id === undefined || id.length === 0) {
        continue;
      }
      const item = field(id, name, attrs);
      item.initial = content.trim();
      if (name === "select") {
        if (item.values.length === 0) {
          item.values = item.initial.length > 0 ? [item.initial] : [];
        } else if (item.initial.length === 0) {
          item.initial = item.values[0] ?? "";
        }
      } else if (name === "toggle") {
        item.initial = item.initial.toLowerCase() === "true" ? "true" : "false";
      }
      fields.push(item);
    }
  }

  return { title, fields, scripts };
}

function field(id: string, kind: FieldKind, attrs: Map<string, string>): WorkflowField {
  return {
    id,
    kind,
    label: attrs.get("label")?.trim() || id,
    placeholder: attrs.get("placeholder") ?? "",
    secret: attrs.has("secret"),
    initial: attrs.get("value") ?? "",
    values:
      kind === "select"
        ? (attrs.get("values") ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [],
    when: attrs.get("when")?.trim() || undefined,
  };
}

interface Directive {
  name: string;
  attrs: Map<string, string>;
}

/** `script id=run label="Run this"` → its name and attributes. */
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

/** The next `<!-- end -->`, from `cursor`. */
function findEnd(text: string, cursor: number): EndMarker | undefined {
  const marker = /<!--\s*end\s*-->/gi;
  marker.lastIndex = cursor;
  const found = marker.exec(text);
  return found === null ? undefined : { index: found.index, length: found[0].length };
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

/** Parse the body of a `script` directive into the steps it stands for. */
export function parseSteps(body: string): WorkflowStep[] {
  const lines = body.split(/\r?\n/);
  const steps: WorkflowStep[] = [];
  let index = 0;
  while (index < lines.length) {
    const number = index + 1;
    const line = lines[index].trim();
    index += 1;
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const space = line.search(/\s/);
    const word = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space).trim();
    switch (word) {
      case "run":
      case "cmd":
        if (rest.length === 0) {
          throw new Error(`line ${number}: \`${word}\` with nothing to run`);
        }
        steps.push({ kind: "command", run: rest });
        break;
      case "agent":
      case "prompt":
        if (rest.length === 0) {
          throw new Error(`line ${number}: \`${word}\` with nothing to ask`);
        }
        steps.push({ kind: "agent", text: rest });
        break;
      case "setting":
      case "config": {
        const split = splitOnce(rest);
        if (split === undefined) {
          throw new Error(
            `line ${number}: \`${word}\` needs a setting and a value — \`${word} apiKey {{key}}\``,
          );
        }
        steps.push({ kind: "setting", key: split[0].trim(), value: split[1].trim() });
        break;
      }
      case "task": {
        if (rest.length === 0) {
          throw new Error(`line ${number}: \`task\` with no title`);
        }
        const bodyLines: string[] = [];
        let closed = false;
        while (index < lines.length) {
          const current = lines[index];
          index += 1;
          if (current.trim() === "end") {
            closed = true;
            break;
          }
          bodyLines.push(current);
        }
        if (!closed && bodyLines.length > 0) {
          throw new Error(
            `line ${number}: the description of \`${rest}\` is never closed — add a line that is just \`end\``,
          );
        }
        steps.push({ kind: "task", title: rest, description: dedent(bodyLines) });
        break;
      }
      case "write": {
        const path = rest.replace(/^:/, "").trim();
        if (path.length === 0) {
          throw new Error(`line ${number}: \`write\` with no path`);
        }
        const bodyLines: string[] = [];
        let closed = false;
        while (index < lines.length) {
          const current = lines[index];
          index += 1;
          if (current.trim() === "end") {
            closed = true;
            break;
          }
          bodyLines.push(current);
        }
        if (!closed) {
          throw new Error(
            `line ${number}: writing \`${path}\` is never closed — add a line that is just \`end\``,
          );
        }
        steps.push({ kind: "write", path, content: dedent(bodyLines) });
        break;
      }
      default:
        steps.push({ kind: "command", run: line });
    }
  }
  return steps;
}

function splitOnce(text: string): [string, string] | undefined {
  const at = text.search(/\s/);
  if (at < 0) {
    return undefined;
  }
  return [text.slice(0, at), text.slice(at)];
}

/**
 * Drop the indentation a block shares, so a `write` body written inside the markdown's own
 * indentation arrives as the user laid it out rather than shifted left by the file's nesting.
 */
function dedent(lines: string[]): string {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  if (indents.length === 0) {
    return "";
  }
  const indent = Math.min(...indents);
  const out = lines.map((line) => (line.trim().length === 0 ? "" : line.slice(indent)));
  while (out.length > 0 && out[out.length - 1].trim().length === 0) {
    out.pop();
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** The ids `text` interpolates, in order. */
export function placeholders(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open < 0) {
      break;
    }
    const after = rest.slice(open + 2);
    const close = after.indexOf("}}");
    if (close < 0) {
      break;
    }
    const id = after.slice(0, close).trim();
    if (id.length > 0) {
      found.push(id);
    }
    rest = after.slice(close + 2);
  }
  return found;
}

/** Replace every `{{id}}` that names a value; a placeholder naming nothing is left alone. */
export function fill(text: string, values: ReadonlyMap<string, string>): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open < 0) {
      break;
    }
    const after = rest.slice(open + 2);
    const close = after.indexOf("}}");
    if (close < 0) {
      break;
    }
    const id = after.slice(0, close).trim();
    out += rest.slice(0, open);
    if (values.has(id)) {
      out += values.get(id);
    } else {
      out += `{{${after.slice(0, close)}}}`;
    }
    rest = after.slice(close + 2);
  }
  return out + rest;
}

/** The first placeholder naming no value, if there is one. */
export function firstUnknown(
  text: string,
  values: ReadonlyMap<string, string>,
): string | undefined {
  for (const id of placeholders(text)) {
    if (!values.has(id)) {
      return id;
    }
  }
  return undefined;
}

/** The one placeholder `text` is, when it is exactly one and nothing else. */
export function singleReference(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) {
    return undefined;
  }
  const id = trimmed.slice(2, -2).trim();
  if (id.length === 0 || id.includes("{{") || id.includes("}}")) {
    return undefined;
  }
  return id;
}

/**
 * Split a command line into the program and its arguments.
 *
 * The line is broken up *before* the values go in, which is what makes a value one argument however
 * many spaces it has. `"…"` groups words into one argument; `\"` is a quote inside one.
 */
export function splitCommand(line: string, values: ReadonlyMap<string, string>): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote = false;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === "{" && line[index + 1] === "{") {
      const close = line.indexOf("}}", index + 2);
      if (close < 0) {
        current += "{";
        index += 1;
        continue;
      }
      const id = line.slice(index + 2, close).trim();
      current += values.get(id) ?? `{{${id}}}`;
      inToken = true;
      index = close + 2;
      continue;
    }
    index += 1;
    if (character === '"') {
      quote = !quote;
      continue;
    }
    if (character === "\\" && quote) {
      if (index < line.length) {
        current += line[index];
        index += 1;
      }
      continue;
    }
    if (/\s/.test(character) && !quote) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += character;
    inToken = true;
  }
  if (quote) {
    throw new Error('a `"` is never closed');
  }
  if (inToken) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new Error("nothing to run");
  }
  return tokens;
}

/**
 * Whether `program` may be run, by the same names `allowedCommands` holds.
 *
 * A bare program name only: `cargo` matches `cargo` and `cargo.exe`, and `C:\elsewhere\cargo` does
 * not match anything.
 */
export function programAllowed(program: string, allowed: readonly string[]): boolean {
  if (program.length === 0 || program.includes("/") || program.includes("\\")) {
    return false;
  }
  const wanted = bareName(program);
  return allowed.some((candidate) => bareName(candidate) === wanted);
}

/** `Cargo.EXE` → `cargo`. */
export function bareName(program: string): string {
  const name = program.split(/[\\/]/).pop() ?? program;
  return name.replace(/\.exe$/i, "").toLowerCase();
}
