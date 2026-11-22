// The wasm host: load `advance_harness.wasm` and marshal across its C ABI.
//
// The ABI passes one `u64` per value — low 32 bits a pointer into the guest's linear memory, high 32
// a length — with UTF-8 JSON on the other side (`advance_abi::wasm::pack`). The four imports the
// module declares (`advance.host_call`, `advance.net_begin`, `advance.net_poll`,
// `advance.net_close`) are bound to this instance, so a capability call is always marshalled against
// the memory of the module that made it.
//
// This file is deliberately free of `vscode` imports: it runs in a worker thread, where blocking on
// `host_call` cannot freeze the editor.

import { readFileSync } from "node:fs";

/** What the guest's imports reach for. */
export interface Capabilities {
  /** `advance.host_call`: a request envelope in, the reply envelope array out. */
  hostCall(request: string): string;
  /** `advance.net_begin`: start a streaming fetch, returning its handle. */
  netBegin(request: string): number;
  /** `advance.net_poll`: the next `NetPoll` JSON for a handle. */
  netPoll(handle: number): string;
  /** `advance.net_close`: release a handle. */
  netClose(handle: number): void;
}

/** What a module reports after an input (`Effects` in both modules). */
export interface Effects {
  repaint?: boolean;
  status?: string | null;
}

interface Exports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  abi_alloc(len: number): number;
  abi_free(ptr: number, len: number): void;
  abi_frame(width: number, height: number): bigint;
  abi_input(ptr: number, len: number): bigint;
}

/** One instantiated module. */
export class Guest {
  private constructor(
    private readonly wasm: Exports,
    private readonly capabilities: Capabilities,
  ) {}

  /** Instantiate the module at `wasmPath`, binding its imports to `capabilities`. */
  static load(wasmPath: string | Buffer, capabilities: Capabilities): Guest {
    const bytes = typeof wasmPath === "string" ? readFileSync(wasmPath) : wasmPath;
    // The closures read `guest`, assigned right after `instantiate` returns. Instantiation never calls
    // an import — only `abi_frame`/`abi_input` do — so the binding is always in place first.
    let guest: Guest | undefined;
    const imports: WebAssembly.Imports = {
      advance: {
        host_call: (ptr: number, len: number): bigint => {
          if (guest === undefined) {
            return 0n;
          }
          const request = guest.read(ptr, len);
          return guest.write(guest.capabilities.hostCall(request));
        },
        net_begin: (ptr: number, len: number): bigint => {
          if (guest === undefined) {
            return 0n;
          }
          const request = guest.read(ptr, len);
          return BigInt(guest.capabilities.netBegin(request) | 0);
        },
        net_poll: (handle: number): bigint => {
          if (guest === undefined) {
            return 0n;
          }
          return guest.write(guest.capabilities.netPoll(handle));
        },
        net_close: (handle: number): void => {
          guest?.capabilities.netClose(handle);
        },
      },
    };

    // Node's Buffer is a view over ArrayBufferLike, which newer WebAssembly typings reject.
    const module = new WebAssembly.Module(bytes as unknown as BufferSource);
    const instance = new WebAssembly.Instance(module, imports);
    const wasm = instance.exports as unknown as Exports;
    if (typeof wasm.abi_version !== "function" || wasm.abi_version() !== 1) {
      throw new Error("the harness module speaks a different ABI version");
    }
    guest = new Guest(wasm, capabilities);
    return guest;
  }

  /** Feed one input event and return the module's effects. */
  input(event: Record<string, unknown>): Effects {
    const bytes = Buffer.from(JSON.stringify(event), "utf8");
    const ptr = this.wasm.abi_alloc(bytes.length);
    if (ptr === 0 && bytes.length > 0) {
      return {};
    }
    new Uint8Array(this.wasm.memory.buffer, ptr, bytes.length).set(bytes);
    // `abi_input` consumes this buffer (the guest reconstructs and frees it), so we do not free it.
    const [outPtr, outLen] = unpack(this.wasm.abi_input(ptr, bytes.length));
    if (outPtr === 0 || outLen === 0) {
      return {};
    }
    try {
      return JSON.parse(this.readAndFree(outPtr, outLen)) as Effects;
    } catch {
      return {};
    }
  }

  /** Build one frame: the scene JSON, or `null` when the module produced nothing. */
  frame(width: number, height: number): string | null {
    const [ptr, len] = unpack(this.wasm.abi_frame(width, height));
    if (ptr === 0 || len === 0) {
      return null;
    }
    return this.readAndFree(ptr, len);
  }

  private read(ptr: number, len: number): string {
    if (ptr === 0 || len === 0) {
      return "";
    }
    return Buffer.from(this.wasm.memory.buffer, ptr, len).toString("utf8");
  }

  private readAndFree(ptr: number, len: number): string {
    const text = this.read(ptr, len);
    this.wasm.abi_free(ptr, len);
    return text;
  }

  private write(text: string): bigint {
    const bytes = Buffer.from(text, "utf8");
    const ptr = this.wasm.abi_alloc(bytes.length);
    if (ptr === 0 && bytes.length > 0) {
      return 0n;
    }
    new Uint8Array(this.wasm.memory.buffer, ptr, bytes.length).set(bytes);
    // The guest reads and frees this buffer (`take_string`), so we do not free it here.
    return pack(ptr, bytes.length);
  }
}

/** Pack a (pointer, length) pair the way `advance_abi::wasm::pack` does. */
function pack(ptr: number, len: number): bigint {
  return (BigInt(len) << 32n) | BigInt(ptr);
}

function unpack(packed: bigint): [number, number] {
  const ptr = Number(packed & 0xffffffffn);
  const len = Number(packed >> 32n);
  return [ptr, len];
}
