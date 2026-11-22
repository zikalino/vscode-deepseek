// The virtual filesystem namespace (§7.5), ported from `advance-host/src/path.rs`.
//
// Two rules, enforced here so no capability forgets them:
//
// 1. **You can only address what is under a granted root.** A path is `/root/key...`; `..`, `.` and a
//    bare root are refused, so a component cannot even name a host path.
// 2. **A path is normalised before it is looked at**, and normalisation cannot climb above a root:
//    there is no parent of a root.

import { AbiError } from "./abi";

/** A validated virtual path: a root name and the key beneath it. */
export class VirtualPath {
  private constructor(
    readonly root: string,
    readonly key: string,
  ) {}

  /** Parse `path` against the roots this host granted. */
  static parse(path: string, roots: ReadonlyMap<string, string>): VirtualPath {
    if (!path.startsWith("/")) {
      throw new AbiError(
        "invalid_path",
        `\`${path.startsWith("/") ? path : `/${path}`}\` is not an absolute path`,
      );
    }
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const root = segments.shift();
    if (root === undefined) {
      throw new AbiError("invalid_path", "a path has no root");
    }
    if (root === "." || root === "..") {
      throw new AbiError("invalid_path", "`.` and `..` are not roots");
    }

    const parts: string[] = [];
    for (const segment of segments) {
      if (segment === "" || segment === ".") {
        continue;
      }
      if (segment === "..") {
        // Climbing out of a root is not a permission question: the path does not exist here.
        if (parts.pop() === undefined) {
          throw new AbiError("invalid_path", "a path cannot climb above its root");
        }
        continue;
      }
      if (segment.includes("\\")) {
        throw new AbiError("invalid_path", "a virtual path uses `/`, not `\\`");
      }
      if (segment.includes("\0")) {
        throw new AbiError("invalid_path", "a path cannot contain a NUL byte");
      }
      parts.push(segment);
    }

    if (!roots.has(root)) {
      throw new AbiError("not_permitted", `\`/${root}\` is not a granted root`);
    }
    return new VirtualPath(root, parts.join("/"));
  }

  /** The root's host directory. */
  base(roots: ReadonlyMap<string, string>): string {
    const base = roots.get(this.root);
    if (base === undefined) {
      throw new AbiError("not_permitted", `\`fs root ${this.root}\` was not granted`);
    }
    return base;
  }

  /** Whether this names the root itself; a destructive call on a root is always refused. */
  get isRoot(): boolean {
    return this.key.length === 0;
  }

  /** The virtual spelling, for messages and entries. */
  display(): string {
    return this.key.length === 0 ? `/${this.root}` : `/${this.root}/${this.key}`;
  }

  /** The last segment, or the root name for a root. */
  get name(): string {
    if (this.key.length === 0) {
      return this.root;
    }
    const index = this.key.lastIndexOf("/");
    return index < 0 ? this.key : this.key.slice(index + 1);
  }

  /** The key's segments. */
  get segments(): string[] {
    return this.key.length === 0 ? [] : this.key.split("/");
  }

  /** The virtual path of a child entry. */
  child(name: string): string {
    return this.key.length === 0 ? `/${this.root}/${name}` : `/${this.root}/${this.key}/${name}`;
  }
}
