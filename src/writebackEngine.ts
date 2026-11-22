import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from './vaultManager';
import { VaultIndex, buildIndex } from './indexEngine';

export interface CodeBlock {
  language: string;
  content: string;
}

export interface NoteWriteOp {
  id: string;
  tags: string[];
  type?: string;
  content: string;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface UnifiedDiffPatch {
  oldPath: string;
  newPath: string;
  hunks: UnifiedDiffHunk[];
}

/**
 * Parse fenced code blocks from a model response.
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\r?\n([\s\S]*?)\r?\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || 'text', content: match[2] });
  }
  return blocks;
}

function normalizeDiffPath(rawPath: string): string {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === '/dev/null') {
    return trimmed;
  }
  const withoutTimestamp = trimmed.split('\t')[0].trim();
  const withoutPrefix = withoutTimestamp.replace(/^[ab]\//, '');
  return withoutPrefix.replace(/\\/g, '/');
}

function normalizePotentialHunkHeader(line: string): string {
  const text = String(line || '');
  // Some model outputs space-separate '@@' as '@ @'; normalize it so hunk parsing still works.
  return text.replace(/^@\s*@/, '@@').replace(/@\s*@(?=\s|$)/, '@@');
}

function parseDiffBlock(blockContent: string): UnifiedDiffPatch[] {
  const lines = String(blockContent || '').split(/\r?\n/);
  const patches: UnifiedDiffPatch[] = [];
  let i = 0;

  while (i < lines.length) {
    const oldHeader = lines[i]?.match(/^---\s+(.+)$/);
    if (!oldHeader) {
      i += 1;
      continue;
    }
    const newHeader = lines[i + 1]?.match(/^\+\+\+\s+(.+)$/);
    if (!newHeader) {
      i += 1;
      continue;
    }
    const patch: UnifiedDiffPatch = {
      oldPath: normalizeDiffPath(oldHeader[1]),
      newPath: normalizeDiffPath(newHeader[1]),
      hunks: []
    };
    i += 2;

    while (i < lines.length) {
      const nextOldHeader = lines[i]?.match(/^---\s+(.+)$/);
      if (nextOldHeader) {
        break;
      }
      const hunkHeader = normalizePotentialHunkHeader(lines[i] || '').match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);
      if (!hunkHeader) {
        i += 1;
        continue;
      }
      const hunk: UnifiedDiffHunk = {
        oldStart: Number(hunkHeader[1]),
        oldCount: Number(hunkHeader[2] || '1'),
        newStart: Number(hunkHeader[3]),
        newCount: Number(hunkHeader[4] || '1'),
        lines: []
      };
      i += 1;

      while (i < lines.length) {
        const line = lines[i] || '';
        if (/^(?:@@|@\s*@)\s*-/.test(line) || /^---\s+/.test(line)) {
          break;
        }
        if (line.startsWith('\\ No newline at end of file')) {
          i += 1;
          continue;
        }
        if (/^[ +\-]/.test(line)) {
          hunk.lines.push(line);
          i += 1;
          continue;
        }
        // End this hunk when content no longer looks like diff data.
        // This prevents markdown prose (e.g. list items) from being parsed as '-' lines.
        break;
      }
      patch.hunks.push(hunk);
    }

    if (patch.hunks.length > 0 && (patch.oldPath || patch.newPath)) {
      patches.push(patch);
    }
  }

  return patches;
}

export function parseUnifiedDiffPatches(text: string): UnifiedDiffPatch[] {
  const allPatches: UnifiedDiffPatch[] = [];

  // Also scan inside [READY_TO_IMPLEMENT] blocks for raw diffs.
  const readyBlockRegex = /\[READY_TO_IMPLEMENT\]([\s\S]*?)(?:\[\/READY_TO_IMPLEMENT\]|$)/gi;
  let readyMatch: RegExpExecArray | null;
  while ((readyMatch = readyBlockRegex.exec(text)) !== null) {
    allPatches.push(...parseDiffBlock(readyMatch[1] || ''));
  }

  // Also scan whole message for unfenced unified diffs.
  allPatches.push(...parseDiffBlock(text));

  for (const block of parseCodeBlocks(text)) {
    const language = String(block.language || '').toLowerCase();
    if (language === 'diff' || language === 'patch') {
      allPatches.push(...parseDiffBlock(block.content));
    } else if ((!language || language === 'text' || language === 'plaintext') && /^---\s+/m.test(block.content)) {
      // Untagged or plain-text code block that looks like a unified diff.
      allPatches.push(...parseDiffBlock(block.content));
    }
  }

  // Deduplicate: if the same file pair appears more than once (e.g. raw diff inside
  // [READY_TO_IMPLEMENT] block was also wrapped in a ```diff fence), keep the first.
  const seen = new Set<string>();
  const patches: UnifiedDiffPatch[] = [];
  for (const p of allPatches) {
    const key = `${p.oldPath}|${p.newPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      patches.push(p);
    }
  }
  return patches;
}

function stripTrailingEol(text: string): { body: string; hadTrailingEol: boolean } {
  if (text.endsWith('\r\n')) {
    return { body: text.slice(0, -2), hadTrailingEol: true };
  }
  if (text.endsWith('\n')) {
    return { body: text.slice(0, -1), hadTrailingEol: true };
  }
  return { body: text, hadTrailingEol: false };
}

function normalizeLine(s: string): string {
  return s.replace(/\r$/, '');
}

function sameLine(a: string, b: string): boolean {
  return normalizeLine(a) === normalizeLine(b);
}

function findHunkPosition(lines: string[], oldSegment: string[], hintStart: number): number {
  // Try exact hint position first
  if (segmentMatches(lines, oldSegment, hintStart)) {
    return hintStart;
  }
  // Fuzzy search: expand outward from hint by up to 50 lines
  const maxDelta = 50;
  for (let delta = 1; delta <= maxDelta; delta++) {
    if (segmentMatches(lines, oldSegment, hintStart + delta)) { return hintStart + delta; }
    if (segmentMatches(lines, oldSegment, hintStart - delta)) { return hintStart - delta; }
  }
  return -1;
}

function segmentMatches(lines: string[], segment: string[], start: number): boolean {
  if (start < 0 || start + segment.length > lines.length) { return false; }
  return segment.every((seg, i) => sameLine(lines[start + i], seg));
}

function applyPatchToText(original: string, patch: UnifiedDiffPatch): string {
  const originalInfo = stripTrailingEol(original);
  let lines = originalInfo.body.split(/\r?\n/);
  if (originalInfo.body.length === 0) {
    lines = [];
  }

  const hunks = [...patch.hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of hunks) {
    const hintStart = Math.max(0, hunk.oldStart - 1);
    const oldSegment: string[] = [];
    const newSegment: string[] = [];
    for (const hunkLine of hunk.lines) {
      const marker = hunkLine[0];
      const content = normalizeLine(hunkLine.slice(1));
      if (marker === ' ' || marker === '-') {
        oldSegment.push(content);
      }
      if (marker === ' ' || marker === '+') {
        newSegment.push(content);
      }
    }

    const start = findHunkPosition(lines, oldSegment, hintStart);
    if (start === -1) {
      throw new Error(`Hunk context mismatch for ${patch.newPath || patch.oldPath} near line ${hunk.oldStart}`);
    }
    lines.splice(start, oldSegment.length, ...newSegment);
  }

  const rebuilt = lines.join('\n');
  if (originalInfo.hadTrailingEol) {
    return `${rebuilt}\n`;
  }
  return rebuilt;
}

/**
 * Parse [CREATE_NOTE ...] markers from a model response.
 */
export function parseNoteOps(text: string): NoteWriteOp[] {
  const ops: NoteWriteOp[] = [];
  const regex = /\[CREATE_NOTE\s+(.*?)\]([\s\S]*?)\[END_NOTE\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const attrStr = match[1];
    const content = match[2].trim();
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)=([^\s\]]+)/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    const id = attrs['id'] || 'unnamed';
    const tags = (attrs['tags'] || '').split(',').filter(Boolean);
    const type = attrs['type'] || undefined;
    ops.push({ id, tags, type, content });
  }
  return ops;
}

/**
 * Build a Markdown file with YAML frontmatter for a vault note.
 */
function buildNoteFile(op: NoteWriteOp): string {
  const lines = ['---', `id: ${op.id}`];
  if (op.tags.length > 0) {
    lines.push('tags:');
    for (const tag of op.tags) {
      lines.push(`  - ${tag}`);
    }
  }
  if (op.type) {
    lines.push(`type: ${op.type}`);
  }
  lines.push('---', '', op.content);
  return lines.join('\n');
}

export class WritebackEngine {
  private vaultManager: VaultManager;
  private log: vscode.OutputChannel;

  constructor(vaultManager: VaultManager, log: vscode.OutputChannel) {
    this.vaultManager = vaultManager;
    this.log = log;
  }

  /**
   * Apply code blocks from a response with user-facing actions.
   */
  async applyCodeBlock(block: CodeBlock, preferredAction?: string): Promise<void> {
    const normalizedAction = String(preferredAction || '').toLowerCase();
    const quickPickNeeded = !normalizedAction;
    const pick = quickPickNeeded
      ? await vscode.window.showQuickPick(
        [
          { label: '$(insert) Insert at cursor', value: 'cursor' },
          { label: '$(diff) Open as diff in new editor', value: 'diff' },
          { label: '$(replace) Replace selection', value: 'replace' }
        ],
        { placeHolder: `Apply code block (${block.language})` }
      )
      : ({
        value: normalizedAction.includes('replace')
          ? 'replace'
          : (normalizedAction.includes('diff') ? 'diff' : 'cursor')
      });

    if (!pick) {
      return;
    }

    const editor = vscode.window.activeTextEditor;

    if (pick.value === 'cursor') {
      if (!editor) {
        vscode.window.showWarningMessage('No active editor. Cannot insert at cursor.');
        return;
      }
      await editor.edit(editBuilder => {
        editBuilder.insert(editor.selection.active, block.content);
      });
    } else if (pick.value === 'replace') {
      if (!editor) {
        vscode.window.showWarningMessage('No active editor. Cannot replace selection.');
        return;
      }
      await editor.edit(editBuilder => {
        editBuilder.replace(editor.selection, block.content);
      });
    } else if (pick.value === 'diff') {
      const doc = await vscode.workspace.openTextDocument({ content: block.content, language: block.language });
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  }

  /**
   * Write vault notes from a model's CREATE_NOTE operations.
   */
  writeNoteOps(ops: NoteWriteOp[], index: VaultIndex): VaultIndex {
    for (const op of ops) {
      // Determine folder from type using monorepo vault placement rules
      let folder = '01-memory-ops';
      if (op.type === 'component' || op.type === 'workflow' || op.type === 'rule') {
        folder = '20-shared-systems';
      }

      const relPath = path.join(folder, `${op.id}.md`);
      const fileContent = buildNoteFile(op);
      try {
        this.vaultManager.writeNote(relPath, fileContent);
        this.log.appendLine(`WritebackEngine: wrote note ${relPath}`);
      } catch (err) {
        this.log.appendLine(`WritebackEngine: failed to write ${relPath}: ${err}`);
      }
    }
    return buildIndex(this.vaultManager);
  }

  async applyUnifiedDiffPatches(patches: UnifiedDiffPatch[]): Promise<string[]> {
    // NOTE: The active apply path goes through prompt-apply.ts → applySimplePatch()
    // from shared/vscode-components/objective-workflow/helpers.ts, which includes
    // automatic hunk verification and fixing via verifyAndFixPatch().
    // This method (applyPatchToText) is a legacy copy kept for reference.
    // If re-enabling this path, replace applyPatchToText with the shared
    // applySimplePatch + verifyAndFixPatch to keep fix-status tracking in sync.

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      throw new Error('No workspace folder is open.');
    }
    const touchedFiles: string[] = [];
    const uniqueByPath = new Map<string, UnifiedDiffPatch[]>();

    for (const patch of patches) {
      const targetPath = patch.newPath === '/dev/null' ? patch.oldPath : patch.newPath;
      const normalizedTargetPath = String(targetPath || '').replace(/\\/g, '/').trim();
      if (!normalizedTargetPath || normalizedTargetPath === '/dev/null') {
        continue;
      }
      const existing = uniqueByPath.get(normalizedTargetPath) || [];
      existing.push(patch);
      uniqueByPath.set(normalizedTargetPath, existing);
    }

    for (const [relativePath, filePatches] of uniqueByPath.entries()) {
      const uri = vscode.Uri.joinPath(workspaceRoot, relativePath);
      let original = '';
      try {
        original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        throw new Error(`Cannot apply diff: file not found in workspace (${relativePath}).`);
      }
      let updated = original;
      for (const patch of filePatches) {
        updated = applyPatchToText(updated, patch);
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
      touchedFiles.push(relativePath);
    }

    return touchedFiles;
  }
}
