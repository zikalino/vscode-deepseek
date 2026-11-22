// The wire shape of the tools the harness can call, shared with `advance_harness.wasm`.
//
// The harness's `ToolParam`, `ToolStep` and `CustomToolDef` use serde's camelCase, so these field
// names are the contract: `type` on a parameter becomes `kind` on the Rust side.

/** One argument of a user-defined tool. */
export interface ToolParameter {
  /** The name the steps and the output template use. */
  id: string;
  /** `string` (default), `number` or `boolean`. */
  type?: string;
  /** What the user reads beside it. */
  label?: string;
  /** What the model reads when deciding what to pass. */
  description?: string;
  /** Whether a call must pass it. */
  required?: boolean;
  /** The value when a call omits it. */
  default?: string;
  /** A string parameter's only allowed values. */
  values?: string[];
}

/** One step of a user-defined tool. */
export interface ToolStep {
  /** `command` or `write`. */
  kind: "command" | "write";
  /** The command line, or the path to write. */
  value: string;
  /** A `write` step's contents. */
  content?: string;
}

/** A custom tool, or a single-script workflow exposed as one. */
export interface CustomToolDefinition {
  /** The function name the model calls. */
  name: string;
  /** The heading the Tools view shows. */
  title?: string;
  /** What it does, in the words the model reads. */
  description?: string;
  /** Its arguments. */
  params: ToolParameter[];
  /** What it runs, in order. */
  steps: ToolStep[];
  /** The result template: `{{id}}` for an argument, `{{result}}` for the step output. */
  output?: string;
  /** Where it came from: `custom` or `workflow`. */
  source?: string;
}

/**
 * The name a tool is stored under, matching the harness's `scaffold::sanitize_name` so a workflow the
 * agent creates and the host later discovers answer to the same name.
 */
export function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .split("")
    .map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : "_"))
    .join("");
  let name = "";
  let lastUnderscore = false;
  for (const ch of cleaned) {
    if (ch === "_") {
      if (!lastUnderscore && name.length > 0) {
        name += "_";
      }
      lastUnderscore = true;
    } else {
      name += ch;
      lastUnderscore = false;
    }
  }
  name = name.replace(/^_+|_+$/g, "");
  if (name.length === 0) {
    return fallback;
  }
  return /^[0-9]/.test(name) ? `c_${name}` : name;
}
