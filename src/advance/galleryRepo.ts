// The public Zero gallery: where the mirror lives and how it is refreshed.
//
// The clone lives in the extension's global storage, not in a workspace: a gallery is shared by
// every project. It is a read-only mirror; publishing uses a temporary clone so a refresh can never
// throw away a branch the user just pushed.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

export const DEFAULT_GALLERY_URL = "https://github.com/zikalino/zero-gallery.git";
export const GALLERY_DIR_NAME = "zero-gallery";
export const GALLERY_BRANCH = "main";

/** How long a mirror may be reused before the next panel start refreshes it. */
const REFRESH_MS = 10 * 60 * 1000;

const run = promisify(execFile);

let lastSync = 0;
let lastUrl = "";
let inFlight: Promise<GallerySync> | undefined;

export interface GallerySync {
  ok: boolean;
  message: string;
}

/** A tool id is also a folder name: letters, digits, `_` and `-`, never a path. */
export function isGalleryId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

function redact(text: string): string {
  return text.replace(/\/\/[^/\s@]+@/g, "//***@");
}

/**
 * Clone the gallery if it is missing, otherwise fetch and reset the mirror.
 *
 * A failure is returned rather than thrown: the Zero panel still works without a gallery, and the
 * gallery tools report the same message when the agent calls them.
 */
export async function ensureGallery(
  dir: string,
  url: string,
  force = false,
): Promise<GallerySync> {
  const target = (url || DEFAULT_GALLERY_URL).trim() || DEFAULT_GALLERY_URL;
  if (!force && lastSync > 0 && Date.now() - lastSync < REFRESH_MS && lastUrl === target) {
    return { ok: true, message: "" };
  }
  if (inFlight !== undefined) {
    return inFlight;
  }
  inFlight = sync(dir, target);
  try {
    const result = await inFlight;
    if (result.ok) {
      lastSync = Date.now();
      lastUrl = target;
    }
    return result;
  } finally {
    inFlight = undefined;
  }
}

async function sync(dir: string, url: string): Promise<GallerySync> {
  if (existsSync(path.join(dir, ".git"))) {
    let current = "";
    try {
      const result = await run("git", ["-C", dir, "remote", "get-url", "origin"], options());
      current = (result.stdout ?? "").trim();
    } catch {
      current = "";
    }
    if (current === url) {
      try {
        await run("git", ["-C", dir, "fetch", "--depth", "1", "origin", GALLERY_BRANCH], options());
        await run("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], options());
        return { ok: true, message: "" };
      } catch (error) {
        const text = describe(error);
        // A repository that exists but has no branch yet (or no `tools` folder) is not an error:
        // it simply has nothing to install.
        if (/couldn't find remote ref|could not find remote ref|not found|empty repository/i.test(text)) {
          return { ok: true, message: "The Zero gallery is empty." };
        }
        return { ok: false, message: `Could not update the Zero gallery: ${redact(text)}` };
      }
    }
    // `galleryUrl` now names another repository; replace the mirror instead of fetching the old
    // origin.
    rmSync(dir, { recursive: true, force: true });
  }
  return clone(dir, url);
}

async function clone(dir: string, url: string): Promise<GallerySync> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  try {
    // Naming the branch matters: a bare remote's HEAD can point at `master` while the gallery
    // publishes `main`, and a clone of that checks nothing out.
    try {
      await run("git", ["clone", "--depth", "1", "--branch", GALLERY_BRANCH, url, dir], options());
    } catch (error) {
      const text = describe(error);
      if (!/remote branch .* not found|couldn't find remote ref|could not find remote branch/i.test(text)) {
        throw error;
      }
      // An empty gallery (or one whose default branch differs) still clones, with no tools.
      rmSync(dir, { recursive: true, force: true });
      await run("git", ["clone", "--depth", "1", url, dir], options());
    }
  } catch (error) {
    // A killed clone can leave a `.git` with no working tree; the next start must clone again
    // rather than try to update something that was never finished.
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, message: `Could not clone the Zero gallery: ${redact(describe(error))}` };
  }
  return { ok: true, message: "" };
}

function options(): {
  timeout: number;
  encoding: "utf8";
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
} {
  return {
    // The gallery is small; twenty seconds is a broken network, not a big repository.
    timeout: 20_000,
    encoding: "utf8" as const,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
}

function describe(error: unknown): string {
  const failure = error as { stderr?: string; message?: string };
  return (failure.stderr || failure.message || String(error)).trim();
}
