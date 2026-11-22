// The capability router: the TypeScript twin of `advance_host::Router` for the methods the harness
// actually calls.
//
// The harness asks the host for a capability by handing over an `Envelope` and expecting the reply
// envelopes back **synchronously** (`advance.host_call`). That is why everything here is synchronous
// (`readFileSync`, `spawnSync`): the guest is blocked inside its own import while we answer. The
// worker thread this runs on is what keeps that blocking off the extension host's event loop.
//
// Semantics are ported from `advance-host/src/native.rs` on purpose, so the panel and the desktop
// behave identically:
//
// * paths are virtual (`/workspace/...`) and re-canonicalised, so a symlink out of the root is
//   refused rather than followed;
// * `fs/remove` on a root is `not_permitted`; `fs/list` sorts by name and hides dot-files by default;
// * `fs/readFile` answers base64 (what the harness decodes) and caps a read at 1 MiB;
// * a program runs to completion and its output is then served in chunks, exactly like
//   `NativeProcess`. The one addition is a timeout, so a hung command cannot wedge the worker.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AbiError,
  decodeBase64,
  encodeBase64,
  errorResponse,
  headerField,
  boolField,
  optionalNumber,
  optionalString,
  parseEnvelope,
  response,
  stringField,
  type DirEntry,
  type EntryKind,
  type ErrorBody,
  type Envelope,
} from "./abi";
import { VirtualPath } from "./vpath";

/** The ABI method names this router implements (`advance_abi::method`). */
export const METHOD = {
  FS_READ_FILE: "fs/readFile",
  FS_WRITE_FILE: "fs/writeFile",
  FS_WRITE_FILE_GRANTED: "fs/writeFileGranted",
  FS_LIST: "fs/list",
  FS_STAT: "fs/stat",
  FS_MKDIR: "fs/mkdir",
  FS_REMOVE: "fs/remove",
  FS_RENAME: "fs/rename",
  FS_TOUCH: "fs/touch",
  PROCESS_SPAWN: "process/spawn",
  PROCESS_SPAWN_GRANTED: "process/spawnGranted",
  PROCESS_READ_STDOUT: "process/readStdout",
  PROCESS_KILL: "process/kill",
  PROCESS_WRITE_STDIN: "process/writeStdin",
  CLIPBOARD_READ: "clipboard/read",
  CLIPBOARD_WRITE: "clipboard/write",
} as const;

/** The most a single `fs/readFile` returns, matching `NativeFs::max_read_bytes`. */
const MAX_READ_BYTES = 1 << 20;
/** How much of a captured stream one `process/readStdout` hands over. */
const STREAM_CHUNK = 64 * 1024;
/** `spawnSync`'s buffer: generous, so a chatty build is not truncated to Node's 1 MiB default. */
const MAX_OUTPUT = 32 * 1024 * 1024;

/** What a finished child left behind. */
interface Finished {
  stdout: Buffer;
  stdoutPos: number;
  stderr: Buffer;
  stderrPos: number;
  exitCode: number | null;
}

/** How the router is configured. */
export interface RouterOptions {
  /** Virtual root name -> host directory (`workspace` -> the open folder). */
  roots: ReadonlyMap<string, string>;
  /** Whether `fs/writeFile`, `mkdir`, `remove` and `rename` are granted. */
  writable: boolean;
  /** Programs `process/spawn` may run. */
  allowedCommands: readonly string[];
  /** How long a command may run before it is killed. */
  commandTimeoutMs: number;
}

/** Answer the harness's capability calls. */
export class Router {
  private readonly children = new Map<string, Finished>();
  private nextPid = 1;

  constructor(private readonly options: RouterOptions) {}

  /**
   * One `advance.host_call`: a request envelope in, the reply envelope array out.
   *
   * Never throws: a failure becomes an error envelope, which is what the engine expects to branch on.
   */
  call(requestJson: string): string {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(requestJson);
    } catch (error) {
      return JSON.stringify([errorResponse("", "", bodyOf(error))]);
    }
    const { id } = envelope;
    const method = envelope.method ?? "";
    if (envelope.kind !== "request") {
      // The harness only sends requests; anything else gets no invented reply.
      return "[]";
    }
    try {
      const payload = this.dispatch(method, envelope.payload);
      return JSON.stringify([response(id, method, payload)]);
    } catch (error) {
      return JSON.stringify([errorResponse(id, method, bodyOf(error))]);
    }
  }

  private dispatch(method: string, payload: unknown): unknown {
    switch (method) {
      case METHOD.FS_READ_FILE:
        return this.readFile(payload);
      case METHOD.FS_WRITE_FILE:
        return this.writeFile(payload, false);
      case METHOD.FS_WRITE_FILE_GRANTED:
        // An enabled user tool's write: the Tools view is the permission, not `allowWrite`. Paths
        // still go through `VirtualPath`, so `/workspace` and `/tools` remain the only roots.
        return this.writeFile(payload, true);
      case METHOD.FS_LIST:
        return { entries: this.list(payload) };
      case METHOD.FS_STAT:
        return this.stat(payload);
      case METHOD.FS_MKDIR:
        return this.mkdir(payload);
      case METHOD.FS_REMOVE:
        return this.remove(payload);
      case METHOD.FS_RENAME:
        return this.rename(payload);
      case METHOD.FS_TOUCH:
        return this.touch(payload);
      case METHOD.PROCESS_SPAWN:
        return this.spawn(payload, false);
      case METHOD.PROCESS_SPAWN_GRANTED:
        // An enabled user tool's command: the checkbox is the permission, not the allowlist. The
        // working directory is still confined to `/workspace`, and the timeout still applies.
        return this.spawn(payload, true);
      case METHOD.PROCESS_READ_STDOUT:
        return this.readStdout(payload);
      case METHOD.PROCESS_KILL:
        return this.kill(payload);
      case METHOD.PROCESS_WRITE_STDIN:
        throw new AbiError(
          "unavailable",
          "this supervisor runs commands non-interactively",
        );
      case METHOD.CLIPBOARD_READ:
      case METHOD.CLIPBOARD_WRITE:
        throw new AbiError("not_permitted", "`clipboard` was not granted");
      default:
        throw new AbiError("unsupported", `this host does not implement \`${method}\``);
    }
  }

  // ---- Filesystem --------------------------------------------------------------------------

  private readFile(payload: unknown): unknown {
    const virtual = this.virtual(stringField(payload, "path"));
    if (virtual.isRoot) {
      throw new AbiError("invalid_path", "a root is not a file");
    }
    const real = this.real(virtual);
    const bytes = this.readBytes(real, virtual);
    const offset = optionalNumber(payload, "offset") ?? 0;
    const length = optionalNumber(payload, "length");
    const start = Math.min(Math.max(0, offset), bytes.length);
    const room = start + MAX_READ_BYTES;
    const end =
      length === undefined
        ? Math.min(room, bytes.length)
        : Math.min(start + Math.max(0, length), bytes.length, room);
    const slice = bytes.subarray(start, end);
    // The harness asks for no encoding and then base64-decodes the answer, which is what
    // `NativeFs` returns. An explicit `utf8` request is honoured, and refuses invalid UTF-8.
    if (optionalString(payload, "encoding") === "utf8") {
      return { data: decodeUtf8(slice, virtual), encoding: "utf8", size: bytes.length };
    }
    return { data: encodeBase64(slice), encoding: "base64", size: bytes.length };
  }

  private writeFile(payload: unknown, granted: boolean): unknown {
    if (!granted) {
      this.requireWritable();
    }
    const virtual = this.virtual(stringField(payload, "path"));
    if (virtual.isRoot) {
      throw new AbiError("invalid_path", "a root is not a file");
    }
    // `encoding` defaults to `utf8` (`Encoding::default()`), which is what the harness sends for a
    // write: plain text, not base64. Only an explicit `base64` is decoded.
    const raw = stringField(payload, "data");
    const bytes =
      optionalString(payload, "encoding") === "base64" ? decodeBase64(raw) : Buffer.from(raw, "utf8");
    const append = boolField(payload, "append");
    const createParents = boolField(payload, "create_parents");
    const real = this.real(virtual);
    try {
      if (createParents) {
        fs.mkdirSync(path.dirname(real), { recursive: true });
      }
      if (append) {
        fs.appendFileSync(real, bytes);
      } else {
        fs.writeFileSync(real, bytes);
      }
    } catch (error) {
      throw ioError(error, virtual);
    }
    return { bytes_written: bytes.length };
  }

  private list(payload: unknown): DirEntry[] {
    const virtual = this.virtual(stringField(payload, "path"));
    const includeHidden = boolField(payload, "include_hidden");
    const real = this.real(virtual);
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(real, { withFileTypes: true });
    } catch (error) {
      throw ioError(error, virtual);
    }
    const entries: DirEntry[] = [];
    for (const dirent of names) {
      if (!includeHidden && dirent.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(real, dirent.name);
      let meta: fs.Stats;
      try {
        meta = fs.statSync(entryPath);
      } catch {
        // A vanished or unreadable entry simply does not appear.
        continue;
      }
      entries.push({
        name: dirent.name,
        path: virtual.child(dirent.name),
        type: kindOf(meta),
        size: meta.isDirectory() ? 0 : meta.size,
        modified: Math.round(meta.mtimeMs),
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  private stat(payload: unknown): unknown {
    const virtual = this.virtual(stringField(payload, "path"));
    const real = this.real(virtual);
    let meta: fs.Stats;
    try {
      meta = fs.statSync(real);
    } catch (error) {
      throw ioError(error, virtual);
    }
    return {
      name: virtual.name,
      path: virtual.display(),
      type: kindOf(meta),
      size: meta.isDirectory() ? 0 : meta.size,
      created: Math.round(meta.birthtimeMs),
      modified: Math.round(meta.mtimeMs),
    };
  }

  private mkdir(payload: unknown): unknown {
    this.requireWritable();
    const virtual = this.virtual(stringField(payload, "path"));
    const real = this.real(virtual);
    try {
      fs.mkdirSync(real, { recursive: boolField(payload, "recursive") });
    } catch (error) {
      throw ioError(error, virtual);
    }
    return undefined;
  }

  private remove(payload: unknown): unknown {
    this.requireWritable();
    const virtual = this.virtual(stringField(payload, "path"));
    if (virtual.isRoot) {
      throw new AbiError("not_permitted", "a root cannot be removed");
    }
    const real = this.real(virtual);
    try {
      if (boolField(payload, "recursive")) {
        fs.rmSync(real, { recursive: true, force: false });
      } else {
        fs.unlinkSync(real);
      }
    } catch (error) {
      throw ioError(error, virtual);
    }
    return undefined;
  }

  private rename(payload: unknown): unknown {
    this.requireWritable();
    const from = this.virtual(stringField(payload, "from"));
    const to = this.virtual(stringField(payload, "to"));
    const fromReal = this.real(from);
    const toReal = this.real(to);
    try {
      fs.renameSync(fromReal, toReal);
    } catch (error) {
      throw ioError(error, from);
    }
    return undefined;
  }

  private touch(payload: unknown): unknown {
    const virtual = this.virtual(stringField(payload, "path"));
    const real = this.real(virtual);
    try {
      // Re-writing the file's own bytes updates its mtime without altering content.
      fs.writeFileSync(real, fs.readFileSync(real));
    } catch (error) {
      throw ioError(error, virtual);
    }
    return undefined;
  }

  // ---- Process -----------------------------------------------------------------------------

  private spawn(payload: unknown, granted: boolean): unknown {
    const program = stringField(payload, "program");
    if (!granted && !this.options.allowedCommands.includes(program)) {
      throw new AbiError(
        "not_permitted",
        `\`${program}\` is not in the command allowlist (deepseek.advance.allowedCommands)`,
      );
    }
    const args = Array.isArray((payload as Record<string, unknown>).args)
      ? ((payload as Record<string, unknown>).args as unknown[]).filter(
          (arg): arg is string => typeof arg === "string",
        )
      : [];
    const cwd = this.workingDirectory(optionalString(payload, "cwd"));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const header of headerField(payload, "env")) {
      env[header.name] = header.value;
    }

    const result = spawnSync(program, args, {
      cwd,
      env,
      timeout: this.options.commandTimeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_OUTPUT,
    });
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new AbiError("not_found", `could not run \`${program}\`: ${result.error.message}`);
      }
      // A timeout still leaves whatever the child wrote; report it rather than losing the output.
      if (code !== "ETIMEDOUT") {
        throw new AbiError("upstream", `could not run \`${program}\`: ${result.error.message}`);
      }
    }

    const pid = `proc-${this.nextPid++}`;
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
    this.children.set(pid, {
      stdout,
      stdoutPos: 0,
      stderr,
      stderrPos: 0,
      exitCode: result.status ?? null,
    });
    return { pid };
  }

  private readStdout(payload: unknown): unknown {
    const pid = stringField(payload, "pid");
    const stream = optionalString(payload, "stream") === "stderr" ? "stderr" : "stdout";
    const child = this.children.get(pid);
    if (child === undefined) {
      throw new AbiError("not_found", `no process \`${pid}\``);
    }
    const buffer = stream === "stderr" ? child.stderr : child.stdout;
    const position = stream === "stderr" ? child.stderrPos : child.stdoutPos;
    const remaining = buffer.subarray(position);
    const take = Math.min(remaining.length, STREAM_CHUNK);
    if (stream === "stderr") {
      child.stderrPos += take;
    } else {
      child.stdoutPos += take;
    }
    const end = stream === "stderr" ? child.stderrPos : child.stdoutPos;
    return { data: encodeBase64(remaining.subarray(0, take)), eof: end >= buffer.length };
  }

  private kill(payload: unknown): unknown {
    const pid = stringField(payload, "pid");
    // The child already finished; dropping it is the only meaningful "kill".
    this.children.delete(pid);
    return undefined;
  }

  // ---- Paths -------------------------------------------------------------------------------

  private virtual(virtualPath: string): VirtualPath {
    return VirtualPath.parse(virtualPath, this.options.roots);
  }

  /** Resolve a virtual path to a host path, canonicalising and checking containment. */
  private real(virtual: VirtualPath): string {
    const base = virtual.base(this.options.roots);
    const baseReal = canonical(base) ?? this.notADirectory(base);
    let joined = baseReal;
    for (const segment of virtual.segments) {
      joined = path.join(joined, segment);
    }
    // If the target exists, canonicalising it resolves any symlink. If it does not, canonicalise the
    // nearest existing parent instead: otherwise a symlinked directory would let a *write* create a
    // file outside the root, because the leaf's real path cannot be resolved yet.
    const resolved = canonical(joined) ?? canonicalParent(joined);
    if (!within(baseReal, resolved ?? joined)) {
      throw new AbiError("not_permitted", `\`${virtual.display()}\` escapes its root`);
    }
    return joined;
  }

  private notADirectory(base: string): never {
    throw new AbiError("not_found", `\`${base}\` is not a directory`);
  }

  private readBytes(real: string, virtual: VirtualPath): Buffer {
    try {
      return fs.readFileSync(real);
    } catch (error) {
      throw ioError(error, virtual);
    }
  }

  /**
   * Where a command runs.
   *
   * The harness sends no `cwd` (its provider carries no workspace), so the default is the workspace
   * root — which is also what its prompt tells the model to assume. An explicit virtual or host path
   * is honoured only when it resolves inside a granted root.
   */
  private workingDirectory(requested: string | undefined): string {
    const workspace = this.options.roots.get("workspace");
    if (workspace === undefined) {
      throw new AbiError("not_permitted", "`fs root workspace` was not granted");
    }
    const baseReal = canonical(workspace) ?? this.notADirectory(workspace);
    if (requested === undefined || requested.length === 0) {
      return baseReal;
    }
    if (requested.startsWith("/")) {
      const real = this.real(VirtualPath.parse(requested, this.options.roots));
      const stats = safeStat(real);
      if (stats === undefined || !stats.isDirectory()) {
        throw new AbiError("not_found", `\`${requested}\` is not a directory`);
      }
      return real;
    }
    const resolved = canonical(requested) ?? path.resolve(requested);
    for (const root of this.options.roots.values()) {
      const rootReal = canonical(root) ?? path.resolve(root);
      if (within(rootReal, resolved)) {
        return resolved;
      }
    }
    throw new AbiError("not_permitted", `\`${requested}\` is outside the workspace`);
  }

  private requireWritable(): void {
    if (!this.options.writable) {
      throw new AbiError("not_permitted", "this filesystem is read-only");
    }
  }
}

function kindOf(meta: fs.Stats): EntryKind {
  if (meta.isDirectory()) {
    return "directory";
  }
  return meta.isSymbolicLink() ? "symlink" : "file";
}

/** `realpath`, or `undefined` when the path does not exist. */
function canonical(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/**
 * The real path of the nearest existing ancestor, with the missing segments re-appended.
 *
 * Used when the target itself does not exist yet, so a symlinked parent still resolves and the
 * containment check can see where a new file would actually land.
 */
function canonicalParent(target: string): string | undefined {
  const missing: string[] = [];
  let current = target;
  for (let depth = 0; depth < 32; depth += 1) {
    const real = canonical(current);
    if (real !== undefined) {
      return path.join(real, ...missing.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    missing.push(path.basename(current));
    current = parent;
  }
  return undefined;
}

function safeStat(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

/** Whether `target` is `base` or inside it, case-insensitively on Windows. */
function within(base: string, target: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const normalizedBase = normalize(base);
  const normalizedTarget = normalize(target);
  if (normalizedTarget === normalizedBase) {
    return true;
  }
  const prefix = normalizedBase.endsWith(path.sep) ? normalizedBase : normalizedBase + path.sep;
  return normalizedTarget.startsWith(prefix);
}

/** Strict UTF-8 decode: `utf8` on non-UTF-8 bytes is `invalid_request`. */
function decodeUtf8(bytes: Uint8Array, virtual: VirtualPath): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AbiError("invalid_request", `\`${virtual.display()}\` is not valid UTF-8`);
  }
}

/** Map a Node filesystem failure onto the ABI's taxonomy. */
function ioError(error: unknown, virtual: VirtualPath): AbiError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const mapped: ErrorBody["code"] =
    code === "ENOENT"
      ? "not_found"
      : code === "EACCES" || code === "EPERM"
        ? "not_permitted"
        : code === "EEXIST" || code === "ENOTEMPTY"
          ? "conflict"
          : "upstream";
  const message = error instanceof Error ? error.message : String(error);
  return new AbiError(mapped, `\`${virtual.display()}\`: ${message}`);
}

/** The error body for any thrown value. */
export function bodyOf(error: unknown): ErrorBody {
  if (error instanceof AbiError) {
    return error.toBody();
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "error", message };
}
