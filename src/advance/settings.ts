// The Advance settings and harness discovery, shared by the panel and the workflow runner.
//
// Kept out of `panel.ts` so a host-side workflow executor can read the same configuration (and find
// the same wasm) without importing the panel, which imports the executor to answer a card's Run.

import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { SECRET_KEY } from "../consts";
import { DEFAULT_GALLERY_URL } from "./galleryRepo";

export interface AdvanceSettings {
  apiUrl: string;
  model: string;
  allowedCommands: string[];
  allowWrite: boolean;
  commandTimeoutMs: number;
  /** The public gallery to clone and publish to. */
  galleryUrl: string;
  /** Dollars per million tokens, for the chat's cost divider (all zero hides the figures). */
  pricing: { inputPerMillion: number; cachedPerMillion: number; outputPerMillion: number };
}

const DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";

export function advanceSettings(): AdvanceSettings {
  const config = vscode.workspace.getConfiguration("deepseek");
  const advance = vscode.workspace.getConfiguration("deepseek.advance");
  const seconds = advance.get<number>("commandTimeoutSeconds", 120);
  return {
    apiUrl: endpoint(config.get<string>("apiEndpoint", DEFAULT_ENDPOINT)),
    model: config.get<string>("model", "deepseek-v4-flash") || "deepseek-v4-flash",
    allowedCommands: advance.get<string[]>("allowedCommands", []),
    allowWrite: advance.get<boolean>("allowWrite", true),
    commandTimeoutMs: Math.max(1, seconds) * 1000,
    galleryUrl: advance.get<string>("galleryUrl", DEFAULT_GALLERY_URL).trim() || DEFAULT_GALLERY_URL,
    pricing: {
      inputPerMillion: advance.get<number>("pricing.inputPerMillion", 0),
      cachedPerMillion: advance.get<number>("pricing.cachedPerMillion", 0),
      outputPerMillion: advance.get<number>("pricing.outputPerMillion", 0),
    },
  };
}

/** Append `/chat/completions` unless the URL already names an endpoint. */
function endpoint(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return DEFAULT_ENDPOINT;
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/** The stored key, else the configured key, else the environment. */
export async function readApiKey(context: vscode.ExtensionContext): Promise<string> {
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored !== undefined && stored.length > 0) {
    return stored;
  }
  const configured = vscode.workspace.getConfiguration("deepseek").get<string>("apiKey", "");
  if (configured.length > 0) {
    return configured;
  }
  return process.env.DEEPSEEK_API_KEY ?? "";
}

/**
 * Find the harness artifact: the explicit setting, a copy shipped beside the panel, or the build
 * output of a Cargo workspace at the folder (or one level above it, for this repo's layout).
 */
export function resolveHarnessWasm(workspace: string, extensionPath: string): string | undefined {
  const explicit = vscode.workspace
    .getConfiguration("deepseek.advance")
    .get<string>("harnessWasm", "")
    .trim();
  if (explicit.length > 0) {
    return existsSync(explicit) ? explicit : undefined;
  }
  const candidates: string[] = [path.join(extensionPath, "media", "advance_harness.wasm")];
  const bases = new Set<string>([
    workspace,
    path.join(workspace, "advance"),
    path.dirname(workspace),
    path.join(path.dirname(workspace), "advance"),
  ]);
  for (const profile of ["release", "debug"]) {
    for (const base of bases) {
      candidates.push(
        path.join(base, "target", "wasm32-unknown-unknown", profile, "advance_harness.wasm"),
      );
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}
