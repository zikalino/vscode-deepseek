// Launching one allowlisted program for a workflow step.
//
// A workflow runs a program and its arguments; there is no shell, so `|`, `&&` and `>` mean nothing.
// On Windows that still has to work for `npm`, `vsce` and `code`, which are `.cmd` wrappers that
// CreateProcess cannot start directly. They are launched through `cmd.exe /d /s /c` with every word
// quoted for cmd, which preserves the no-shell rule for the program's own arguments without handing
// the line to a shell unquoted.
//
// Kept free of `vscode` so the launcher and the quoting can be exercised on their own.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Launch {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Extra environment entries the child needs (the `%` neutraliser, for a `.cmd` wrapper). */
  env?: Record<string, string>;
}

interface Resolved {
  path: string;
  kind: "exe" | "script";
}

/**
 * What to spawn for `program` and `args`. Throws when the program is not on PATH; a program that is
 * not found is a refusal to run, not a shell builtin to guess at.
 */
export function launchFor(program: string, args: string[]): Launch {
  if (process.platform !== "win32") {
    return { file: program, args };
  }
  const resolved = resolveWindows(program);
  if (resolved === undefined) {
    throw new Error(`could not find \`${program}\` on PATH`);
  }
  if (resolved.kind === "exe") {
    return { file: resolved.path, args };
  }
  const comspec = process.env.ComSpec ?? "cmd.exe";
  // cmd expands `%NAME%` even inside double quotes, and there is no command-line escape for `%`.
  // An environment variable whose value is one `%` gives a single-pass expansion to a literal `%`,
  // which is what keeps a workflow value such as `%PATH%` from being substituted by the shell.
  const percent = `DEEPSEEK_WF_PCT_${randomBytes(4).toString("hex")}`;
  const literalPercent = (text: string): string => text.replace(/%/g, `%${percent}%`);
  const line = [resolved.path, ...args]
    .map((part) => quoteCmdArg(literalPercent(part)))
    .join(" ");
  // `/s` makes cmd strip exactly the outer quotes; the inner quoting is what keeps an argument with
  // spaces or `&` one word instead of two or a second command.
  return {
    file: comspec,
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
    env: { [percent]: "%" },
  };
}

/** Find `program` in the PATH, accepting only things cmd can run. */
function resolveWindows(program: string): Resolved | undefined {
  const pathValue = process.env.PATH ?? "";
  const directories = pathValue
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
  // PATHEXT also lists `.VBS`/`.PS1`; those are not programs cmd can start without another shell.
  const extensions: Array<{ extension: string; kind: Resolved["kind"] }> = [
    { extension: ".COM", kind: "exe" },
    { extension: ".EXE", kind: "exe" },
    { extension: ".BAT", kind: "script" },
    { extension: ".CMD", kind: "script" },
  ];
  for (const directory of directories) {
    const base = path.join(directory, program);
    // Prefer the extensions cmd can start: Node installs both `npm` (a shell script) and `npm.cmd`,
    // and only the latter is a program on Windows.
    for (const candidate of extensions) {
      const target = base + candidate.extension;
      if (statFile(target) !== undefined) {
        return { path: target, kind: candidate.kind };
      }
    }
    const exact = statFile(base);
    if (exact !== undefined) {
      const extension = path.extname(base).toLowerCase();
      return { path: base, kind: extension === ".exe" || extension === ".com" ? "exe" : "script" };
    }
  }
  return undefined;
}

function statFile(target: string): fs.Stats | undefined {
  try {
    const stats = fs.statSync(target);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Quote one word for a cmd command line.
 *
 * Wrapping a word in double quotes keeps cmd from reading `&`, `|`, `<`, `>` and `^`; the
 * backslash/quote rules are the ones MSVCRT uses for argv, which is what npm and vsce are.
 */
export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"&|<>^()%]/.test(arg)) {
    return arg;
  }
  let out = '"';
  let backslashes = 0;
  for (const character of arg) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

/** Stop a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    // cmd.exe is in the way of npm/vsce/code, so killing it alone would leave the real work running.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** The one line worth showing when a step fails: the compiler's diagnosis, else the first line. */
export function firstProblem(stdout: string, stderr: string): string {
  const text = stderr.trim().length > 0 ? stderr : stdout;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines.find((candidate) => /^error/i.test(candidate)) ?? lines[0] ?? "no output";
  return clip(line, 160);
}

/** `text` in at most `room` characters, with an ellipsis when it had to be cut. */
export function clip(text: string, room: number): string {
  if (text.length <= room) {
    return text;
  }
  return `${text.slice(0, Math.max(0, room - 1))}…`;
}
