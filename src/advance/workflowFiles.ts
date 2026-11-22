// Where a workflow document lives and how the host opens it.
//
// Separate from `panel.ts` so the workflow runner can open the source when a run fails without
// importing the panel (which imports the runner to answer a card's Run).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { parseWorkflow } from "./workflowDoc";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A workflow document as the form needs it: what to call it and what to draw. */
export interface WorkflowDocument {
  title: string;
  source: string;
}

/** Read a workflow document. `undefined` when the id is not one, or it cannot be read. */
export function readWorkflowDocument(
  root: vscode.Uri,
  id: string,
): WorkflowDocument | undefined {
  const relative = id.trim().replace(/\\/g, "/");
  if (!isWorkflowDocumentId(relative)) {
    return undefined;
  }
  const target = vscode.Uri.joinPath(root, ...relative.split("/"));
  try {
    const source = readFileSync(target.fsPath, "utf8");
    const fallback = path.basename(relative).replace(/\.md$/i, "");
    return { title: parseWorkflow(source, fallback).title, source };
  } catch {
    return undefined;
  }
}

/**
 * Whether a card's id names a document directly under the workspace's workflow folder.
 *
 * The id comes from the harness, and it now drives a file read and a script run, so it is checked
 * as tightly as a path: exactly `.advance/workflows/<name>.md`, with no empty, `.` or `..` segment
 * that could walk out of the folder.
 */
export function isWorkflowDocumentId(id: string): boolean {
  const relative = id.trim().replace(/\\/g, "/");
  if (!relative.toLowerCase().endsWith(".md") || /^[A-Za-z]:/.test(relative)) {
    return false;
  }
  const segments = relative.split("/");
  if (segments.length !== 3 || segments[0] !== ".advance" || segments[1] !== "workflows") {
    return false;
  }
  const name = segments[2];
  return name.length > 0 && name !== "." && name !== "..";
}

/**
 * Open a workflow card's document in a preview tab. Returns the failure to report, or `undefined`
 * when the document opened.
 */
export async function openWorkflowDocument(
  root: vscode.Uri,
  id: string,
): Promise<string | undefined> {
  const relative = id.trim().replace(/\\/g, "/");
  if (!isWorkflowDocumentId(relative)) {
    return "it is not a workflow document";
  }
  const target = vscode.Uri.joinPath(root, ...relative.split("/"));
  try {
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: true });
    return undefined;
  } catch (error) {
    return describe(error);
  }
}
