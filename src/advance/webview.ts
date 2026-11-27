// The canvas page every Advance wasm panel hosts; only the title differs.
//
// Kept out of `panel.ts` so the Token Usage panel can reuse the same canvas, theme computation and
// pointer/keyboard plumbing without importing the chat panel's engine wiring.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** The canvas page every Advance webview hosts; only the title differs. */
export function panelHtml(webview: vscode.Webview, media: vscode.Uri, title: string): string {
  const nonce = randomBytes(16).toString("base64");
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
  const theme = webview.asWebviewUri(vscode.Uri.joinPath(media, "theme.js"));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
  const label = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>${label}</title>
</head>
<body>
<div id="app">
  <canvas id="screen" tabindex="0" aria-label="${label}"></canvas>
  <span id="status" role="status"></span>
</div>
<script nonce="${nonce}" src="${theme}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
