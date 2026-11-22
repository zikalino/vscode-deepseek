import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { VaultNote } from './vaultManager';
import * as vscode from 'vscode';

export interface ContextNote {
  id: string;
  path: string;
  tags: string[];
  type: 'memory' | 'workspace';
  related?: string[];
  content: string;
}

export interface ContextBundle {
  activeTags: string[];
  notes: ContextNote[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface DeepSeekClientOptions {
  mode: 'api' | 'local';
  apiKey: string;
  apiEndpoint: string;
  model: string;
  systemPromptOverride?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

function buildSystemPrompt(customPrompt?: string): string {
  if (customPrompt) {
    return customPrompt;
  }
  return [
    'You are DeepSeek assisting a developer in a VS Code project.',
    'You have access to a persistent project memory stored as Markdown notes.',
    'Each note has tags and metadata. Use them as authoritative context.',
    'Respect the active context tags. Prefer information from the provided notes over guesses.',
    'When modifying code or notes, be explicit and structured. If unsure, ask for clarification.',
    '',
    '## Interaction Protocol',
    '',
    '### Requesting Additional Information via Workflow Execution Plans',
    'If you need more information (files, clarification) before implementing, return a new',
    'workflow execution plan in a fenced yaml code block (see the @base vault note for the',
    'exact 5-step workflow shape: Objective, Additional Request, File Request, Submit, Response).',
    'Use the `inputs`-based pattern for steps that collect user input, not `extension-api` commands.',
    'The "Additional Request" step uses `inputs` with `type: text` to collect extra guidance,',
    'not `extensionCommand: deepseek.api.addRequestText`.',
    '',
    '### Proposing File Changes',
    'To propose a change to an existing workspace file, output a unified diff inside a',
    'fenced code block tagged `diff`. Include the file path in the diff header.',
    'Prefer minimal, targeted diffs. One diff block per file.',
    'Explain the change briefly before each diff block.',
    '',
    '### Creating or Updating Vault Notes',
    'To create a new vault note, use:',
    '[CREATE_NOTE id=<id> tags=<tag1,tag2> type=<type>]',
    '# Note content here',
    '[END_NOTE]'
  ].join('\n');
}

function formatNoteForMessage(note: ContextNote): string {
  const meta = [
    `id: ${note.id}`,
    `path: ${note.path}`,
    `tags: ${note.tags.join(', ')}`,
    `type: ${note.type}`,
    note.related?.length ? `related: ${note.related.join(', ')}` : null
  ].filter(Boolean).join(' | ');
  return `--- [${meta}] ---\n${note.content}\n`;
}

export class DeepSeekClient {
  private options: DeepSeekClientOptions;
  private log: vscode.OutputChannel;

  constructor(options: DeepSeekClientOptions, log: vscode.OutputChannel) {
    this.options = options;
    this.log = log;
  }

  updateOptions(options: DeepSeekClientOptions): void {
    this.options = options;
  }

  notesToContextNotes(notes: VaultNote[]): ContextNote[] {
    return notes.map(n => ({
      id: n.id,
      path: n.filePath,
      tags: n.tags,
      type: n.type === 'workspace' ? 'workspace' as const : 'memory' as const,
      related: n.related,
      content: n.content
    }));
  }

  /**
   * Simple non-streaming chat. Returns the full response text.
   * Does NOT open any webview or interact with the UI.
   */
  async chatOnce(
    contextBundle: ContextBundle,
    chatHistory: ChatMessage[],
    userMessage: string,
    systemPromptOverride?: string,
    modelOverride?: string
  ): Promise<{ text: string; error?: string; usage?: TokenUsage; querySizeBytes?: number; rawBody?: string }> {
    const systemContent = buildSystemPrompt(systemPromptOverride);
    const tagLine = contextBundle.activeTags.length > 0
      ? `Active context tags: ${contextBundle.activeTags.map(t => `@${t}`).join(', ')}`
      : '';

    // Separate notes by type
    const memoryNotes = contextBundle.notes.filter(n => n.type === 'memory');
    const workspaceNotes = contextBundle.notes.filter(n => n.type === 'workspace');

    // Build messages: system, memory files, workspace files, chat history, user
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent + (tagLine ? '\n\n' + tagLine : '') },
      ...memoryNotes.map(n => ({ role: 'user' as const, content: `[Memory File: ${n.path}]\n${formatNoteForMessage(n)}` })),
      ...workspaceNotes.map(n => ({ role: 'user' as const, content: `[Workspace File: ${n.path}]\n${n.content}` })),
      ...chatHistory,
      { role: 'user', content: userMessage }
    ];

    const modelName = modelOverride || this.options.model || 'deepseek-v4-flash';
    const body = JSON.stringify({
      model: modelName,
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 4096
    });

    const querySizeBytes = Buffer.byteLength(body);

    // (history files removed — use prompt webview Raw Request/Response tabs instead)

    const apiKey = this.options.apiKey || process.env['DEEPSEEK_API_KEY'] || '';
    if (!apiKey) {
      return { text: '', error: 'DeepSeek API key is not configured.' };
    }

    const endpoint = this.options.apiEndpoint;
    let urlObj: URL;
    try {
      urlObj = new URL(endpoint);
    } catch {
      return { text: '', error: `Invalid API endpoint: ${endpoint}` };
    }

    const reqOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const transport = urlObj.protocol === 'https:' ? https : http;

    return new Promise(resolve => {
      const req = transport.request(reqOptions, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode !== 200) {
            let detail = '';
            try {
              const parsed = JSON.parse(responseBody);
              detail = parsed?.error?.message || parsed?.message || responseBody;
            } catch {
              detail = responseBody || `HTTP ${res.statusCode}`;
            }
            resolve({ text: '', querySizeBytes, error: `DeepSeek API error (HTTP ${res.statusCode}): ${detail}` });
            return;
          }
          try {
            const parsed = JSON.parse(responseBody);
            const text = parsed?.choices?.[0]?.message?.content || '';
            const usage: TokenUsage | undefined = parsed?.usage
              ? { prompt_tokens: parsed.usage.prompt_tokens ?? 0, completion_tokens: parsed.usage.completion_tokens ?? 0, total_tokens: parsed.usage.total_tokens ?? 0, prompt_cache_hit_tokens: parsed.usage.prompt_cache_hit_tokens, prompt_cache_miss_tokens: parsed.usage.prompt_cache_miss_tokens }
              : undefined;
            resolve({ text, usage, querySizeBytes, rawBody: responseBody });
          } catch {
            resolve({ text: '', querySizeBytes, error: 'Failed to parse DeepSeek response.' });
          }
        });
        res.on('error', (err) => { resolve({ text: '', querySizeBytes, error: `HTTP response error: ${err.message}` }); });
      });
      req.on('error', (err) => { resolve({ text: '', querySizeBytes, error: `Request error: ${err.message}` }); });
      req.write(body);
      req.end();
    });
  }

  streamChat(
    contextBundle: ContextBundle,
    chatHistory: ChatMessage[],
    userMessage: string,
    systemPromptOverride: string | undefined,
    onToken: (token: string) => void,
    onDone: (fullText: string) => void,
    onError: (err: string) => void
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const systemContent = buildSystemPrompt(systemPromptOverride);
      const tagLine = contextBundle.activeTags.length > 0
        ? `Active context tags: ${contextBundle.activeTags.map(t => `@${t}`).join(', ')}`
        : '';

      const memoryNotes = contextBundle.notes.filter(n => n.type === 'memory');
      const workspaceNotes = contextBundle.notes.filter(n => n.type === 'workspace');

      const messages: ChatMessage[] = [
        { role: 'system', content: systemContent + (tagLine ? '\n\n' + tagLine : '') },
        ...memoryNotes.map(n => ({ role: 'user' as const, content: `[Memory File: ${n.path}]\n${formatNoteForMessage(n)}` })),
        ...workspaceNotes.map(n => ({ role: 'user' as const, content: `[Workspace File: ${n.path}]\n${n.content}` })),
        ...chatHistory,
        { role: 'user', content: userMessage }
      ];

      const modelName = this.options.model || 'deepseek-v4-flash';
      const body = JSON.stringify({
        model: modelName,
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: 4096
      });

      const apiKey = this.options.apiKey || process.env['DEEPSEEK_API_KEY'] || '';
      if (!apiKey) {
        onError('DeepSeek API key is not configured. Set deepseek.apiKey in settings or the DEEPSEEK_API_KEY environment variable.');
        resolve();
        return;
      }

      const endpoint = this.options.apiEndpoint;
      let urlObj: URL;
      try {
        urlObj = new URL(endpoint);
      } catch {
        onError(`Invalid API endpoint: ${endpoint}`);
        resolve();
        return;
      }

      const reqOptions: http.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + (urlObj.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const transport = urlObj.protocol === 'https:' ? https : http;
      let fullText = '';

      const req = transport.request(reqOptions, (res) => {
        res.setEncoding('utf8');
        let buffer = '';

        if (res.statusCode && res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', (chunk: string) => { errorBody += chunk; });
          res.on('end', () => {
            let detail = '';
            try {
              const parsed = JSON.parse(errorBody);
              detail = parsed?.error?.message || parsed?.message || errorBody;
            } catch {
              detail = errorBody || `HTTP ${res.statusCode}`;
            }
            onError(`DeepSeek API error (HTTP ${res.statusCode}): ${detail}`);
            resolve();
          });
          return;
        }

        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) {
              continue;
            }
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                fullText += delta;
                onToken(delta);
              }
            } catch {
              // ignore malformed SSE
            }
          }
        });
        res.on('end', () => {
          onDone(fullText);
          resolve();
        });
        res.on('error', (err) => {
          onError(`HTTP response error: ${err.message}`);
          resolve();
        });
      });

      req.on('error', (err) => {
        onError(`Request error: ${err.message}`);
        resolve();
      });

      req.write(body);
      req.end();
    });
  }
}
