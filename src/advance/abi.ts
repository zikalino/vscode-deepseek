// The Advance ABI's wire types, in TypeScript.
//
// The harness (`advance_harness.wasm`) speaks the same C ABI as the desktop host: a packed `u64`
// (low 32 bits a pointer into the guest's memory, high 32 a length) carrying UTF-8 JSON. This module
// mirrors `advance-abi` — the envelope, the error taxonomy, the payload shapes and the serde casing
// — so a TypeScript host answers exactly like the Rust one.
//
// Casing matters: `advance-abi` only renames where a struct says so. The harness's own `Input` and
// `Effects` are camelCase, but the ABI payloads keep Rust's snake_case (`create_parents`,
// `body_base64`, `include_hidden`), and `EntryKind`/`Encoding` are snake_case strings.

/** The kind of a directory entry, as `advance_abi::types::EntryKind` spells it. */
export type EntryKind = "file" | "directory" | "symlink";

/** How bytes are carried, as `advance_abi::types::Encoding` spells it. */
export type Encoding = "utf8" | "base64";

/** The closed error taxonomy (`advance_abi::ErrorCode`). */
export type ErrorCode =
  | "invalid_request"
  | "invalid_path"
  | "not_found"
  | "conflict"
  | "out_of_range"
  | "not_permitted"
  | "unsupported"
  | "unavailable"
  | "timeout"
  | "upstream"
  | "error";

/** The `error` object of a failed terminal. */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  detail?: string;
}

/** A failure the router turns into an error envelope. */
export class AbiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AbiError";
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.detail !== undefined) {
      body.detail = this.detail;
    }
    return body;
  }
}

/** One ABI header. */
export interface Header {
  name: string;
  value: string;
}

/** One directory entry. */
export interface DirEntry {
  name: string;
  path: string;
  type: EntryKind;
  size: number;
  modified?: number;
}

/** The message envelope (`advance_abi::Envelope`). */
export interface Envelope {
  v: number;
  kind: string;
  id: string;
  method?: string;
  payload?: unknown;
  error?: ErrorBody;
}

/** The envelope version this build speaks. */
export const ENVELOPE_VERSION = 1;

/** Build a successful terminal, omitting the fields serde would omit. */
export function response(id: string, method: string, payload?: unknown): Envelope {
  const envelope: Envelope = { v: ENVELOPE_VERSION, kind: "response", id, method };
  if (payload !== undefined && payload !== null) {
    envelope.payload = payload;
  }
  return envelope;
}

/** Build a failed terminal. */
export function errorResponse(id: string, method: string, error: ErrorBody): Envelope {
  return { v: ENVELOPE_VERSION, kind: "response", id, method, error };
}

/** Parse an incoming envelope, checking its version. */
export function parseEnvelope(json: string): Envelope {
  let parsed: Partial<Envelope> | null;
  try {
    parsed = JSON.parse(json) as Partial<Envelope> | null;
  } catch (error) {
    throw new AbiError(
      "invalid_request",
      `the request is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AbiError("invalid_request", "the request is not an envelope");
  }
  if (parsed.v !== ENVELOPE_VERSION) {
    throw new AbiError("invalid_request", `unsupported envelope version ${String(parsed.v)}`);
  }
  return {
    v: ENVELOPE_VERSION,
    kind: typeof parsed.kind === "string" ? parsed.kind : "",
    id: typeof parsed.id === "string" ? parsed.id : "",
    method: typeof parsed.method === "string" ? parsed.method : "",
    payload: parsed.payload,
    error: parsed.error,
  };
}

/** Base64-encode bytes, the encoding every `data` field uses. */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 `data` field. */
export function decodeBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

/** A required string field of a payload. */
export function stringField(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string") {
    throw new AbiError("invalid_request", `\`${key}\` must be a string`);
  }
  return value;
}

/** An optional boolean field, defaulting to false like serde's `#[serde(default)]`. */
export function boolField(payload: unknown, key: string): boolean {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return value === true;
}

/** An optional string field. */
export function optionalString(payload: unknown, key: string): string | undefined {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

/** An optional integer field. */
export function optionalNumber(payload: unknown, key: string): number | undefined {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An optional header array. */
export function headerField(payload: unknown, key: string): Header[] {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Header =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Header).name === "string" &&
      typeof (entry as Header).value === "string",
  );
}
