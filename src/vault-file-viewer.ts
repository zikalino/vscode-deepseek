import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  createMarkdownWebviewPanel,
  MarkdownTab,
  updateEditableInMarkdown,
  injectEditableMarkers,
} from '../vendor/vscode-components/dist/prompt';

/**
 * Creates a markdown viewer webview for a vault memory file.
 * Uses the markdown-webview component for rich rendering.
 *
 * - Single-click from sidebar opens this viewer
 * - Renders markdown with interactive checkboxes, expandable sections
 * - Action buttons: Add to Prompt, View Source, Reload
 */
export function createVaultFileViewer(fileUri: vscode.Uri): void {
  const fileName = path.basename(fileUri.fsPath);
  const content = readFileContent(fileUri.fsPath);

  const tabs: MarkdownTab[] = [
    {
      id: 'note',
      label: 'Note',
      content: injectEditableMarkers(content, ['## Overview', '## Description', '## Notes', '## Initial Objective']),
      // Expandable sections are inline via <!-- ?expandable --> markers in the md file
      interactiveSections: [
        { header: '## Next Actions', checkboxes: true, removable: false },
        { header: '## Todos', checkboxes: true, removable: false },
        { header: '## TODO', checkboxes: true, removable: false },
        { header: '## Action Items', checkboxes: true, removable: false },
      ],
      actions: [
        {
          id: 'add-to-prompt',
          label: 'Add to Prompt',
          icon: '$(plus)',
          primary: true,
        },
        {
          id: 'source',
          label: 'View Source',
          icon: '$(go-to-file)',
        },
        {
          id: 'reload',
          label: 'Reload',
          icon: '$(sync)',
        },
      ],
    },
    {
      id: 'raw',
      label: 'Raw',
      content,
      rawContent: true,
    },
  ];

  // Must spread — vscode config returns frozen objects, mutation would silently fail
  const frontmatterVariables = { ...vscode.workspace.getConfiguration('deepseek').get<Record<string, string>>('variableFolders', {}) };
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

  const viewer = createMarkdownWebviewPanel({
    viewType: 'deepseek.vaultFileView',
    title: `📄 ${fileName}`,
    tabs,
    frontmatterLinkKeys: ['suggestedFiles'],
    frontmatterVariables,
    workspaceRoot,
    enableWikiLinks: true,
    onWikiLinkClick: async (linkText: string) => {
      try {
        // Walk up from the current file to find the vault root (.vault directory)
        let vaultRoot = path.dirname(fileUri.fsPath);
        while (vaultRoot && path.basename(vaultRoot) !== '.vault') {
          const parent = path.dirname(vaultRoot);
          if (parent === vaultRoot) { vaultRoot = ''; break; }
          vaultRoot = parent;
        }
        if (!vaultRoot) {
          const results = await vscode.workspace.findFiles(`**/${linkText}.md`, '**/node_modules/**', 1);
          if (results.length > 0) {
            vscode.commands.executeCommand('deepseek.openVaultFile', results[0].fsPath);
          } else {
            vscode.window.showInformationMessage(`No vault note found matching [[${linkText}]]`);
          }
          return;
        }
        const walkDir = async (dir: string): Promise<string | null> => {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = await walkDir(full);
              if (found) return found;
            } else if (entry.isFile() && entry.name.toLowerCase() === `${linkText.toLowerCase()}.md`) {
              return full;
            }
          }
          return null;
        };
        const found = await walkDir(vaultRoot);
        if (found) {
          vscode.commands.executeCommand('deepseek.openVaultFile', found);
        } else {
          vscode.window.showInformationMessage(`No vault note found matching [[${linkText}]]`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to find note [[${linkText}]]: ${err}`);
      }
    },
    onFrontmatterTagClick: (tag: string) => {
      vscode.commands.executeCommand('deepseek.advancedSearch', tag);
    },
    onAction: (actionId: string, _tabId: string) => {
      if (actionId === 'add-to-prompt') {
        vscode.commands.executeCommand('deepseek.addToPrompt', {
          nodeType: 'vault-file',
          metadata: { filePath: fileUri.fsPath },
        });
      } else if (actionId === 'source') {
        vscode.commands.executeCommand('markdown.showPreview', fileUri);
      } else if (actionId === 'reload') {
        const freshContent = readFileContent(fileUri.fsPath);
        viewer.updateTabContent('note', freshContent);
        viewer.updateTabContent('raw', freshContent);
      }
    },
    onContentChanged: (_tabId: string, sectionHeader: string, newValue: string) => {
      // When an editable section is changed, save it back to the file
      const currentContent = viewer.getTabContent('note');

      let updatedContent: string;
      if (sectionHeader.startsWith('@editable:')) {
        // @editable widget change — extract the directive line and update
        const rest = sectionHeader.slice('@editable:'.length);
        const idxMatch = rest.match(/^(\d+):(.*)$/);
        if (idxMatch) {
          const directive = idxMatch[2];
          updatedContent = updateEditableInMarkdown(currentContent, directive, newValue, parseInt(idxMatch[1]));
        } else {
          // Legacy format without occurrence index
          updatedContent = updateEditableInMarkdown(currentContent, rest, newValue);
        }
      } else {
        // Regular section header change
        updatedContent = updateSectionInMarkdown(currentContent, sectionHeader, newValue);
      }

      viewer.setTabContent('note', updatedContent);
      viewer.setTabContent('raw', updatedContent);
      try {
        fs.writeFileSync(fileUri.fsPath, updatedContent, 'utf-8');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to save: ${err}`);
      }
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────

function readFileContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return `*Error: could not read ${filePath}*`;
  }
}

/**
 * Replaces the content of a markdown section identified by its header.
 * This is a best-effort replacement — it finds the section and swaps its body.
 */
function updateSectionInMarkdown(
  content: string,
  sectionHeader: string,
  newValue: string,
): string {
  // Build a regex that matches from the section header to the next heading or end-of-string
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(${escaped})\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
    'i',
  );
  return content.replace(pattern, `$1\n${newValue}`);
}
