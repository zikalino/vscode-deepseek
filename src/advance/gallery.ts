// The Zero gallery operations the harness calls through the host.
//
// The gallery repository is laid out as `tools/<tool-id>/tool.md` (supporting files are allowed in
// the folder). Installing copies the folder into the extension's global tools folder; publishing
// copies a local tool into a temporary clone and pushes a branch, so the read-only mirror is never
// modified.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { parseCustomTool } from "./customTools";
import { DEFAULT_GALLERY_URL, GALLERY_BRANCH, isGalleryId } from "./galleryRepo";
import type { CustomToolDefinition } from "./toolCatalogue";

const TOOL_FILE = "tool.md";

/** One gallery entry, as the Tools view and the model see it. */
export interface GalleryItem {
  id: string;
  title: string;
  description: string;
  installed: boolean;
}

export interface GalleryInstallResult {
  id: string;
  path: string;
  tool: CustomToolDefinition;
}

export interface GalleryPublishResult {
  id: string;
  branch: string;
  url: string;
  message: string;
}

/** Search, install and publish against the mirror and the global tools folder. */
export class Gallery {
  constructor(
    private readonly galleryDir: string | undefined,
    private readonly toolsDir: string | undefined,
    private readonly url: string = DEFAULT_GALLERY_URL,
    private readonly token: string = "",
  ) {}

  /** Every gallery tool matching `query` (case-insensitive; empty lists all). */
  search(query: string): GalleryItem[] {
    const root = this.galleryRoot();
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const needle = query.trim().toLowerCase();
    const items: GalleryItem[] = [];
    for (const entry of entries) {
      const id = entry.isDirectory()
        ? entry.name
        : entry.isFile() && entry.name.toLowerCase().endsWith(".md")
          ? entry.name.replace(/\.md$/i, "")
          : "";
      if (id.length === 0) {
        continue;
      }
      const file = entry.isDirectory()
        ? findToolFile(path.join(root, id), id)
        : path.join(root, entry.name);
      if (file === undefined) {
        continue;
      }
      const tool = readTool(file, id);
      if (tool === undefined) {
        continue;
      }
      const haystack = `${id} ${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
      if (needle.length > 0 && !haystack.includes(needle)) {
        continue;
      }
      items.push({
        id,
        title: tool.title?.trim() || tool.name || id,
        description: tool.description ?? "",
        installed: this.installed(id),
      });
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    return items.slice(0, 50);
  }

  /** Copy one gallery tool folder into the global tools folder and return its definition. */
  install(id: string): GalleryInstallResult {
    requireId(id);
    const root = this.galleryRoot();
    if (this.toolsDir === undefined) {
      throw new Error("the global tools folder is not available");
    }
    mkdirSync(this.toolsDir, { recursive: true });
    const sourceDir = path.join(root, id);
    const sourceFile = path.join(root, `${id}.md`);
    const targetDir = path.join(this.toolsDir, id);
    const targetFile = path.join(this.toolsDir, `${id}.md`);

    let sourceKind: "dir" | "file" | undefined;
    if (existsSync(sourceDir) && statSync(sourceDir).isDirectory()) {
      sourceKind = "dir";
    } else if (existsSync(sourceFile)) {
      sourceKind = "file";
    }
    if (sourceKind === undefined) {
      throw new Error(`\`${id}\` is not in the Zero gallery`);
    }

    // A tool can exist as a folder or as the older flat `<id>.md`; installing replaces both, so
    // there is one copy of the name in the catalogue.
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(targetFile, { force: true });
    if (sourceKind === "dir") {
      cpSync(sourceDir, targetDir, { recursive: true });
    } else {
      mkdirSync(targetDir, { recursive: true });
      cpSync(sourceFile, path.join(targetDir, TOOL_FILE));
    }

    const file = findToolFile(targetDir, id);
    if (file === undefined) {
      throw new Error(`the installed tool \`${id}\` has no ${TOOL_FILE}`);
    }
    const tool = readTool(file, id);
    if (tool === undefined) {
      throw new Error(`the installed tool \`${id}\` is not a valid tool document`);
    }
    return { id, path: targetDir, tool };
  }

  /**
   * Publish one local tool. A temporary clone keeps the read-only mirror untouched; the new branch
   * is pushed and, when `gh` is available, a pull request is opened. Without a token the push is
   * still attempted (a credential helper may supply one) and the error is reported.
   */
  publish(id: string): GalleryPublishResult {
    requireId(id);
    if (this.toolsDir === undefined) {
      throw new Error("the global tools folder is not available");
    }
    const sourceDir = path.join(this.toolsDir, id);
    const sourceFile = path.join(this.toolsDir, `${id}.md`);
    let sourceKind: "dir" | "file" | undefined;
    if (existsSync(sourceDir) && statSync(sourceDir).isDirectory()) {
      sourceKind = "dir";
    } else if (existsSync(sourceFile)) {
      sourceKind = "file";
    }
    if (sourceKind === undefined) {
      throw new Error(`there is no local tool \`${id}\` to publish`);
    }

    const url = (this.url || DEFAULT_GALLERY_URL).trim();
    const temp = mkdtempSync(path.join(tmpdir(), "zero-gallery-"));
    try {
      const repo = path.join(temp, "repo");
      try {
        // Clone the branch the pull request will target, so the commit has `main` as an ancestor
        // even when the remote's HEAD points at another branch.
        this.git(["clone", "--depth", "1", "--branch", GALLERY_BRANCH, url, repo], temp);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!/remote branch .* not found|couldn't find remote ref|could not find remote branch/i.test(text)) {
          throw error;
        }
        // An empty gallery has no branch to name; the first commit becomes an orphan branch.
        rmSync(repo, { recursive: true, force: true });
        this.git(["clone", "--depth", "1", url, repo], temp);
      }
      const branch = `tool/${id}-${stamp()}`;
      if (this.tryGit(["-C", repo, "rev-parse", "--verify", "HEAD"], temp)) {
        this.git(["-C", repo, "checkout", "-b", branch], temp);
      } else {
        // A repository with no commits (the gallery before its first tool) still accepts the first
        // commit; an orphan branch is how git spells that.
        this.git(["-C", repo, "checkout", "--orphan", branch], temp);
      }

      const targetDir = path.join(repo, "tools", id);
      // Replacing the folder (rather than merging into it) drops a support file the local tool no
      // longer has.
      rmSync(targetDir, { recursive: true, force: true });
      if (sourceKind === "dir") {
        mkdirSync(path.join(repo, "tools"), { recursive: true });
        cpSync(sourceDir, targetDir, { recursive: true });
      } else {
        mkdirSync(targetDir, { recursive: true });
        cpSync(sourceFile, path.join(targetDir, TOOL_FILE));
      }

      this.git(["-C", repo, "add", "-A"], temp);
      if (this.git(["-C", repo, "status", "--porcelain"], temp).trim().length === 0) {
        throw new Error(`\`${id}\` is identical to the gallery copy; change it before publishing`);
      }
      this.git(
        [
          "-C",
          repo,
          "-c",
          "user.name=Zero Gallery",
          "-c",
          "user.email=zero-gallery@users.noreply.github.com",
          "commit",
          "-m",
          `Add ${id} tool`,
        ],
        temp,
      );

      const push = ["-C", repo];
      if (this.token.trim().length > 0) {
        push.push("-c", `http.extraheader=AUTHORIZATION: bearer ${this.token.trim()}`);
      }
      push.push("push", "origin", `HEAD:refs/heads/${branch}`);
      this.git(push, temp);

      const compare = compareLink(url, branch);
      const pullRequest = this.tryPullRequest(repo, url, id, branch);
      const link = pullRequest ?? compare;
      const message = pullRequest !== undefined
        ? `published \`${id}\` and opened a pull request`
        : `published \`${id}\` on branch \`${branch}\`${compare.length > 0 ? "; open the link to create a pull request" : ""}`;
      return { id, branch, url: link, message };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  private installed(id: string): boolean {
    if (this.toolsDir === undefined) {
      return false;
    }
    return (
      existsSync(path.join(this.toolsDir, id)) ||
      existsSync(path.join(this.toolsDir, `${id}.md`))
    );
  }

  /** The gallery's `tools/` folder. Throws when the clone is missing, so a failed clone is not
   * reported as an empty gallery. A clone with no `tools/` folder yet is simply empty. */
  private galleryRoot(): string {
    if (this.galleryDir === undefined || !existsSync(this.galleryDir)) {
      throw new Error("the Zero gallery is not available");
    }
    return path.join(this.galleryDir, "tools");
  }

  private git(args: string[], cwd: string): string {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 90_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.error !== undefined) {
      throw new Error(`git failed: ${this.redact(result.error.message)}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new Error(`git failed: ${this.redact(detail)}`);
    }
    return result.stdout ?? "";
  }

  private tryGit(args: string[], cwd: string): boolean {
    try {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private tryPullRequest(repo: string, url: string, id: string, branch: string): string | undefined {
    const slug = repoSlug(url);
    if (slug === undefined) {
      return undefined;
    }
    const version = spawnSync("gh", ["--version"], { encoding: "utf8", windowsHide: true });
    if (version.status !== 0) {
      return undefined;
    }
    const env = { ...process.env };
    if (this.token.trim().length > 0) {
      env.GH_TOKEN = this.token.trim();
    }
    const result = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        slug,
        "--base",
        GALLERY_BRANCH,
        "--head",
        branch,
        "--title",
        `Add ${id} tool`,
        "--body",
        `Adds the \`${id}\` tool to the Zero gallery.`,
      ],
      { cwd: repo, encoding: "utf8", windowsHide: true, env, timeout: 60_000 },
    );
    if (result.status !== 0) {
      return undefined;
    }
    const lines = (result.stdout || "").trim().split(/\r?\n/).filter((line) => /^https?:\/\//.test(line));
    return lines.length > 0 ? lines[lines.length - 1] : undefined;
  }

  private redact(text: string): string {
    let out = text;
    const token = this.token.trim();
    if (token.length > 0) {
      out = out.split(token).join("***");
    }
    return out.replace(/\/\/[^/\s@]+@/g, "//***@");
  }
}

function requireId(id: string): void {
  if (!isGalleryId(id)) {
    throw new Error(`\`${id}\` is not a gallery tool id`);
  }
}

function findToolFile(dir: string, id: string): string | undefined {
  for (const name of [TOOL_FILE, `${id}.md`, "index.md"]) {
    const file = path.join(dir, name);
    if (existsSync(file)) {
      return file;
    }
  }
  return undefined;
}

function readTool(file: string, fallback: string): CustomToolDefinition | undefined {
  try {
    return parseCustomTool(readFileSync(file, "utf8"), fallback);
  } catch {
    return undefined;
  }
}

/** `tool/<id>-20261122203000`, so a second publish of the same tool does not collide. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function repoSlug(url: string): string | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

function compareLink(url: string, branch: string): string {
  const slug = repoSlug(url);
  return slug === undefined
    ? ""
    : `https://github.com/${slug}/compare/${GALLERY_BRANCH}...${encodeURIComponent(branch)}?expand=1`;
}
