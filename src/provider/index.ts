import * as vscode from 'vscode';
import { MODELS, VENDOR_ID, SECRET_KEY, SETTINGS_NS, COPILOT_SETTINGS_NS, DEFAULT_CHARS_PER_TOKEN, EMA_ALPHA, MAX_TOOLS } from '../consts';
import {
  type ModelDefinition,
  type DeepSeekRequest,
  type ReasoningEntry,
  type ReasoningHistoryState,
  type DeepSeekTool,
  type DeepSeekUsage,
  type CacheDiagnostics,
  type ToolListChange,
} from '../types';
import { Logger } from '../logger';
import { AuthManager } from '../auth';
import { accountManager } from '../account/account';
import { DeepSeekClient } from '../client/core';
import {
  convertMessages,
  convertTools,
  getConfiguredTemperature,
  getConfiguredThinkingEffort,
  countMessageChars,
} from './convert';
import {
  hashText,
  pruneReasoningCache as pruneReasoningEntries,
  reasoningIndexKey,
  reasoningTextKey,
  reasoningToolCallKey,
} from './reasoningCache';
import { classifyRequest } from './debug/classifier';
import {
  buildCacheDiagnostics,
  compareMessagePrefix,
  summarizeRequestSections,
  type MessagePrefixComparison,
} from './debug/diagnostics';
import { buildCacheMissRecord, shouldRecordCacheMiss, writeCacheMissRecord } from './debug/cacheMissLog';
import { ReplayEngine } from './replay/engine';
import { ToolStabilizer, enforceToolLimit, sortToolsDeterministically } from './tools/flow';
import { VisionProxy } from './vision/proxy';
import { getDebugMode } from './schema';
import { recordApiUsage } from '../usage';

const REASONING_STORAGE_KEY = 'deepseek.reasoningHistory';

function normalizeToolInput(rawArgs: string): Record<string, unknown> {
  const trimmed = (rawArgs ?? '').trim();
  if (!trimmed) {
    return {};
  }

  let value: unknown = trimmed;
  // Some models emit double-encoded arguments (JSON string containing JSON).
  for (let i = 0; i < 3; i++) {
    if (typeof value !== 'string') {
      break;
    }

    const candidate = value.trim();
    if (!candidate) {
      return {};
    }

    try {
      value = JSON.parse(candidate);
    } catch {
      // Non-JSON content is not valid tool input for VS Code's tool API.
      return {};
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (Array.isArray(value)) {
    return { items: value };
  }

  return { value };
}

/**
 * VS Code passes a provider group's resolved settings to
 * `provideLanguageModelChatInformation`, but the runtime API is newer than the
 * bundled typings, so keep the shape local and feature-detect it.
 */
interface ProviderGroupConfiguration {
  readonly apiKey?: unknown;
}

type ProviderInformationOptions = vscode.PrepareLanguageModelChatModelOptions & {
  readonly configuration?: ProviderGroupConfiguration;
};

export class DeepSeekChatProvider implements vscode.LanguageModelChatProvider {
  private log: Logger;
  private auth: AuthManager;
  private client: DeepSeekClient;
  private replay: ReplayEngine;
  private stabilizer: ToolStabilizer;
  private vision: VisionProxy;
  private charsPerToken: number = DEFAULT_CHARS_PER_TOKEN;
  private reasoningCache: Map<string, ReasoningEntry> = new Map();
  private prevMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined;
  /** Ordered tool names from the previous request, for cache-miss diagnostics. */
  private prevToolNames: string[] | undefined;
  /** Fingerprint of the previous request's normalized system message. */
  private prevSystemHash: string | undefined;
  private context: vscode.ExtensionContext;
  private clientBaseUrl: string;
  /** Key from VS Code's model-provider settings, when the user configured one there. */
  private configuredApiKey: string | undefined;
  private _onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this._onDidChange.event;

  constructor(context: vscode.ExtensionContext, auth: AuthManager, log: Logger) {
    this.log = log;
    this.auth = auth;
    this.context = context;
    this.clientBaseUrl = this.configuredBaseUrl();
    this.client = new DeepSeekClient(this.clientBaseUrl, log);
    this.replay = new ReplayEngine(log);
    this.stabilizer = new ToolStabilizer(log);
    this.vision = new VisionProxy(log);

    // Restore reasoning cache from workspace state
    this.restoreReasoningCache(context);

    // Listen for config changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTINGS_NS)) {
          this._onDidChange.fire();
          if (e.affectsConfiguration(`${SETTINGS_NS}.visionModel`)) {
            this.vision.resetCache();
          }
          if (e.affectsConfiguration(`${SETTINGS_NS}.baseUrl`)) {
            this.ensureClient(this.configuredBaseUrl());
          }
        }
      }),
    );

    // Listen for SecretStorage changes (cross-window)
    context.subscriptions.push(
      this.auth.onDidChangeApiKey(() => {
        this._onDidChange.fire();
      }),
    );

    // A hosted session changes which endpoint and key the next request uses.
    context.subscriptions.push(
      accountManager(context).onDidChange(() => {
        this._onDidChange.fire();
      }),
    );
  }

  private configuredBaseUrl(): string {
    return vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('baseUrl', 'https://api.deepseek.com');
  }

  /** Rebuild the client when a session (or the setting) changes the base URL. */
  private ensureClient(baseUrl: string): DeepSeekClient {
    if (this.clientBaseUrl !== baseUrl) {
      this.clientBaseUrl = baseUrl;
      this.client = new DeepSeekClient(baseUrl, this.log);
    }
    return this.client;
  }

  // ── provideLanguageModelChatInformation ─────────────────────

  /** Ask VS Code to re-resolve this vendor's model list (e.g. right after registration). */
  notifyModelsChanged(): void {
    this._onDidChange.fire();
  }

  /**
   * Remember the key entered in VS Code's provider settings (Manage Models).
   * VS Code omits `configuration` for its silent discovery call and includes the
   * resolved group settings — including secrets — for each configured group. A
   * chat request does not identify its group, so the most recently resolved key
   * is used (the normal single-group setup is unambiguous).
   */
  private captureProviderConfiguration(options: vscode.PrepareLanguageModelChatModelOptions): void {
    const configuration = (options as ProviderInformationOptions).configuration;
    if (configuration === undefined) {
      return;
    }
    const apiKey = configuration.apiKey;
    this.configuredApiKey =
      typeof apiKey === 'string' && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    this.captureProviderConfiguration(options);
    const hasKey =
      this.configuredApiKey !== undefined ||
      (await accountManager(this.context).getAccess()) !== undefined ||
      (await this.auth.getApiKey()) !== undefined;

    return MODELS.map((model) => {
      const info: any = {
        id: model.id,
        family: VENDOR_ID,
        name: model.name,
        version: '0.5.3',
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
          imageInput: model.supportsImageInput,
          // Reporting a number here tells VS Code the per-request tool budget, so it
          // trims the tool list before calling us instead of us having to drop tools.
          toolCalling: model.supportsToolCalling ? MAX_TOOLS : false,
        },
      };

      // VS Code caches the first (configuration-less) resolution and ignores the
      // later per-group duplicates, so only hint on a non-silent pass.
      if (!hasKey && !options.silent) {
        info.detail = 'Set a key in Manage Models or run "DeepSeek: Set API Key".';
      }

      return info as vscode.LanguageModelChatInformation;
    });
  }

  // ── provideLanguageModelChatResponse ────────────────────────

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // 1. Auth: a hosted allowance session wins, then a key configured in VS Code's
    // provider settings, then the extension's shared secret/setting.
    const account = await accountManager(this.context).getAccess();
    const apiKey = account?.apiKey ?? this.configuredApiKey ?? (await this.auth.getApiKey());
    if (!apiKey) {
      throw new Error(
        'DeepSeek API key not configured. Set a key in Manage Models, run ' +
          '"DeepSeek: Set API Key", or run "DeepSeek: Sign In for Free Tokens".',
      );
    }
    const client = this.ensureClient(account?.baseUrl ?? this.configuredBaseUrl());

    // 2. Model lookup
    const modelDef = MODELS.find((m) => m.id === modelInfo.id);
    if (!modelDef) {
      throw new Error(`Unknown model: ${modelInfo.id}`);
    }

    // 3. Debug mode check
    const debugMode = getDebugMode();

    // 4. Segment / replay marker extraction
    const segmentId = this.resolveSegmentId(messages);

    // 5. Classify request
    const kind = classifyRequest(messages, options.tools);

    // 6. Message-prefix diagnostics (the system and tool blocks are measured
    //    after conversion, once their wire form is known)
    const prefix = compareMessagePrefix(this.prevMessages, messages, {
      normalizeSessionContext: this.stabilizePromptCache(),
    });
    this.prevMessages = messages;

    // 7. Vision proxy
    const { resolvedMessages: visionMessages } = await this.vision.resolveImages(messages);

    // 8. Tool flow
    const vsCodeTools = options.tools ?? [];
    let deepseekTools: DeepSeekTool[] | undefined;
    let processedMessages: readonly vscode.LanguageModelChatRequestMessage[] = visionMessages;
    if (modelDef.supportsToolCalling && vsCodeTools.length > 0) {
      deepseekTools = convertTools(vsCodeTools) ?? [];
      deepseekTools = enforceToolLimit(deepseekTools, this.log);
      // Registration order is not stable across a session resume; sorting keeps
      // the cached prefix independent of MCP connect timing.
      deepseekTools = sortToolsDeterministically(deepseekTools);

      // Tool stabilization
      const stabilizeEnabled = vscode.workspace
        .getConfiguration(SETTINGS_NS)
        .get<boolean>('experimental.stabilizeToolList', false);

      const { preflightCalls, driftNotice } = this.stabilizer.process(
        messages,
        deepseekTools,
        stabilizeEnabled,
      );

      // Emit preflight tool calls
      for (const pc of preflightCalls) {
        const toolCallPart = new (vscode as any).LanguageModelToolCallPart(
          pc.id,
          pc.name,
          normalizeToolInput(pc.args),
        );
        progress.report(toolCallPart);
      }

      if (driftNotice) {
        processedMessages = this.injectDriftNotice(visionMessages, driftNotice);
      }
    }

    // 9. Build request
    const conversationId = this.conversationId(messages);
    const request = await this.buildRequest(modelDef, processedMessages, deepseekTools, options, kind, conversationId);

    // 10. Cache diagnostics, then stream
    const diagnostics = this.collectCacheDiagnostics(
      kind,
      segmentId,
      messages,
      request,
      prefix,
      debugMode,
    );
    await this.streamResponse(client, request, apiKey, modelDef, progress, token, kind, diagnostics, conversationId);
  }

  /** Measure the wire request and attribute any cache miss to the block that changed. */
  private collectCacheDiagnostics(
    kind: string,
    segmentId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    request: DeepSeekRequest,
    prefix: MessagePrefixComparison | undefined,
    debugMode: string,
  ): CacheDiagnostics {
    const sections = summarizeRequestSections(request);
    const toolListChange = this.describeToolChange(sections.toolNames);
    const systemChanged =
      this.prevSystemHash !== undefined && this.prevSystemHash !== sections.systemHash;
    this.prevSystemHash = sections.systemHash;

    const diagnostics = buildCacheDiagnostics(segmentId, 'markerMissing', messages);
    diagnostics.prefixOverlapRatio = prefix?.ratio;
    diagnostics.toolCount = sections.toolNames.length;
    diagnostics.toolsChars = sections.toolsChars;
    diagnostics.toolsHash = sections.toolsHash;
    diagnostics.systemChars = sections.systemChars;
    diagnostics.systemHash = sections.systemHash;
    diagnostics.messageChars = sections.messageChars;
    diagnostics.toolListChange = toolListChange;
    diagnostics.systemChanged = systemChanged;

    if (debugMode !== 'minimal') {
      const details: string[] = [
        `[${kind}] segment=${segmentId} msgs=${messages.length} tools=${sections.toolNames.length}`,
        `toolChars=${sections.toolsChars}`,
        `sysChars=${sections.systemChars}`,
        `msgChars=${sections.messageChars}`,
      ];
      if (toolListChange.changed) {
        const order = toolListChange.reordered ? ' reordered' : '';
        details.push(
          `toolsChanged(+${toolListChange.added.length}/-${toolListChange.removed.length}${order})`,
        );
      }
      if (systemChanged) {
        details.push('systemChanged');
      }
      if (prefix) {
        details.push(`prefixOverlap=${prefix.ratio.toFixed(2)}`);
        details.push(`msgsPrev=${prefix.previousCount}`);
        if (prefix.divergedAt) {
          const d = prefix.divergedAt;
          details.push(
            `divergedAt=#${d.index}(${d.previousRole}->${d.currentRole} ${d.previousChars}->${d.currentChars} chars)`,
          );
        } else if (prefix.currentCount < prefix.previousCount) {
          details.push('contextShrank');
        }
      }
      this.log.info(details.join(' '));
    }

    return diagnostics;
  }

  /** Compare the sent tool names with the previous request's list. */
  private describeToolChange(toolNames: string[]): ToolListChange {
    const previous = this.prevToolNames;
    this.prevToolNames = toolNames;
    if (previous === undefined) {
      return { added: [], removed: [], reordered: false, changed: false };
    }

    const previousSet = new Set(previous);
    const currentSet = new Set(toolNames);
    const added = toolNames.filter((name) => !previousSet.has(name));
    const removed = previous.filter((name) => !currentSet.has(name));
    const reordered =
      added.length === 0 && removed.length === 0 && previous.join('\n') !== toolNames.join('\n');
    return {
      added,
      removed,
      reordered,
      changed: added.length > 0 || removed.length > 0 || reordered,
    };
  }

  // ── provideTokenCount ───────────────────────────────────────

  async provideTokenCount(
    _modelInfo: vscode.LanguageModelChatInformation,
    textOrMessage: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    let text: string;
    if (typeof textOrMessage === 'string') {
      text = textOrMessage;
    } else {
      text = this.getMessageText(textOrMessage);
    }
    return Math.ceil(text.length / this.charsPerToken);
  }

  // ── Internal methods ────────────────────────────────────────

  private resolveSegmentId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const marker = this.replay.extractMarker(messages);
    return marker?.segmentId ?? crypto.randomUUID();
  }

  private async buildRequest(
    modelDef: ModelDefinition,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    tools: DeepSeekTool[] | undefined,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    _kind: string,
    conversationId: string,
  ): Promise<DeepSeekRequest> {
    // Message conversion
    const deepseekMessages = convertMessages(messages, this.reasoningCache, {
      normalizeSessionContext: this.stabilizePromptCache(),
      conversationId,
    });
    if (deepseekMessages.length === 0) {
      const messageShapeSummary = messages.map((m, idx) => {
        const role = String((m as any).role);
        const parts = Array.isArray((m as any).content) ? (m as any).content : [];
        const partTypes = parts.map((p: any) => String(p?.type ?? 'unknown')).join(',');
        return `#${idx}{role=${role},parts=[${partTypes}]}`;
      }).join(' ');

      this.log.error(
        `Converted DeepSeek message list is empty. rawMessages=${messages.length} shapes=${messageShapeSummary}`,
      );
      throw new Error('No chat messages were converted for the DeepSeek request. Check message conversion logs.');
    }

    // Temperature
    const temperature = getConfiguredTemperature(options);

    const request: DeepSeekRequest = {
      model: modelDef.apiModel,
      messages: deepseekMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (temperature !== undefined) {
      request.temperature = temperature;
    }

    // DeepSeek enables thinking when `thinking`/`reasoning_effort` are omitted.
    // Make the model configuration explicit so the picker actually takes effect.
    const configuredEffort = getConfiguredThinkingEffort(options);
    let thinkingEnabled = configuredEffort !== 'none';
    const thinkingEffort: 'high' | 'max' = configuredEffort === 'max' ? 'max' : 'high';

    if (tools && tools.length > 0) {
      request.tools = tools;
      // VS Code requires providers to honour toolMode. Required is used by agent flows
      // that need a tool call; ignoring it makes those turns look like a model failure.
      const toolModeEnum: any = (vscode as any).LanguageModelChatToolMode;
      const requiresToolCall =
        !!toolModeEnum && (options as any)?.toolMode === toolModeEnum.Required;
      request.tool_choice = requiresToolCall ? 'required' : 'auto';

      // DeepSeek rejects `tool_choice: "required"` (and named tool choices) in
      // thinking mode with HTTP 400. Disable thinking for these turns only.
      if (requiresToolCall && thinkingEnabled) {
        this.log.info(
          'toolMode=Required requested: disabling thinking for this turn because DeepSeek does not support required tool_choice in thinking mode.',
        );
        thinkingEnabled = false;
      }
    } else {
      const toolModeEnum: any = (vscode as any).LanguageModelChatToolMode;
      if (toolModeEnum && (options as any)?.toolMode === toolModeEnum.Required) {
        this.log.warn('toolMode=Required was requested but no tools were provided.');
      }
    }

    request.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };
    if (thinkingEnabled) {
      request.reasoning_effort = thinkingEffort;
    }

    // Max tokens
    const maxTokens = vscode.workspace.getConfiguration(SETTINGS_NS).get<number>('maxTokens', 0);
    if (maxTokens > 0) {
      request.max_tokens = maxTokens;
    }

    return request;
  }

  private async streamResponse(
    client: DeepSeekClient,
    request: DeepSeekRequest,
    apiKey: string,
    modelDef: ModelDefinition,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    kind: string,
    diagnostics: CacheDiagnostics,
    conversationId: string,
  ): Promise<void> {
    // Track reasoning text for caching
    let fullReasoningText = '';
    // Positional fallback: the response becomes the next request's assistant
    // message with this index.
    const assistantTurnIndex = request.messages.filter((m) => m.role === 'assistant').length;
    const toolCallIds: string[] = [];
    // Track response for history logging
    let fullResponseContent = '';
    let lastUsage: DeepSeekUsage | undefined;

    const abortController = new AbortController();
    const disposable = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const callbacks = {
        onContent: (text: string) => {
          fullResponseContent += text;
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onThinking: (text: string) => {
          fullReasoningText += text;
          try {
            const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
            if (ThinkingPart) {
              progress.report(new ThinkingPart(text));
            }
          } catch {
            // Thinking part API may not be available
          }
        },
        onToolCall: (toolCall: { id: string; type: string; function: { name: string; arguments: string } }) => {
          if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
            toolCallIds.push(toolCall.id);
          }
          try {
            const ToolCallPart = (vscode as any).LanguageModelToolCallPart;
            if (ToolCallPart) {
              progress.report(
                new ToolCallPart(
                  toolCall.id,
                  toolCall.function.name,
                  normalizeToolInput(toolCall.function.arguments),
                ),
              );
            }
          } catch {
            // ToolCallPart may not be available
          }
        },
        onError: (error: Error) => {
          this.log.error('Stream error:', error);
          // Error is surfaced to the user via the thrown promise
          throw error;
        },
        onDone: () => {
          // Cache reasoning text for multi-turn coherence. DeepSeek requires it
          // to be echoed back whenever `tools` is present.
          if (fullReasoningText) {
            const entry: ReasoningEntry = {
              text: fullReasoningText,
              timestamp: Date.now(),
            };
            this.reasoningCache.set(reasoningIndexKey(conversationId, assistantTurnIndex), entry);
            for (const id of toolCallIds) {
              this.reasoningCache.set(reasoningToolCallKey(id), entry);
            }
            if (toolCallIds.length === 0 && fullResponseContent.trim()) {
              this.reasoningCache.set(reasoningTextKey(fullResponseContent), entry);
            }
            pruneReasoningEntries(this.reasoningCache);
            this.persistReasoningCache(this.context);
          }
        },
        onUsage: (usage: DeepSeekUsage) => {
          lastUsage = usage;
          this.handleUsage(usage, request);
          const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
          const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
          const completion = usage.completion_tokens;
          const prompt = usage.prompt_tokens || cacheHit + cacheMiss;
          const hitRate = prompt > 0 ? (cacheHit / prompt) * 100 : 0;
          if (getDebugMode() !== 'minimal') {
            this.log.info(
              `[${kind}] M:${cacheMiss} H:${cacheHit}/${prompt} (${hitRate.toFixed(1)}%) ` +
              `O:${completion} temp: ${request.temperature ?? 'default'}`,
            );
          }
          // A large miss is kept on disk: the output channel rotates, and the
          // request that follows a session resume is exactly the one whose
          // diagnostics must survive.
          if (shouldRecordCacheMiss(usage)) {
            writeCacheMissRecord(
              buildCacheMissRecord(diagnostics, usage, request.model, kind),
              this.log,
            );
          }
        },
      };

      await client.streamChatCompletion(request, apiKey, callbacks, abortController.signal);
    } finally {
      disposable.dispose();
    }
  }

  private handleUsage(usage: DeepSeekUsage, request: DeepSeekRequest): void {
    recordApiUsage({
      source: 'copilot',
      model: request.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cacheHitTokens: usage.prompt_cache_hit_tokens,
      cacheMissTokens: usage.prompt_cache_miss_tokens,
    });
    const totalRequestChars = countMessageChars(request.messages);
    const totalTokens = usage.prompt_tokens + usage.completion_tokens;
    if (totalTokens > 0 && totalRequestChars > 0) {
      const observed = totalRequestChars / totalTokens;
      // Exponential moving average
      this.charsPerToken = this.charsPerToken * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
    }
  }

  private injectDriftNotice(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    notice: string,
  ): readonly vscode.LanguageModelChatRequestMessage[] {
    const msgs = [...messages];
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if ((msgs[i] as any).role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    // Prepend notice to the last user message
    if (lastUserIdx >= 0) {
      const msg = msgs[lastUserIdx] as any;
      const parts = [...(msg.content ?? [])];
      parts.unshift({ type: 'text', value: notice + '\n' });
      msgs[lastUserIdx] = { ...msg, content: parts };
    }
    return msgs;
  }

  private getMessageText(msg: vscode.LanguageModelChatRequestMessage): string {
    const parts = (msg as any).content ?? [];
    return parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.value ?? '')
      .join(' ');
  }

  /** Keep the system-prompt prefix stable across conversations (prompt caching). */
  private stabilizePromptCache(): boolean {
    return vscode.workspace
      .getConfiguration(COPILOT_SETTINGS_NS)
      .get<boolean>('stabilizePromptCache', true);
  }

  /**
   * Stable id for the conversation, used only to scope positional reasoning.
   * The shared environment preamble is identical in every conversation and is
   * skipped; the first real user turn is unique and never changes while the
   * conversation grows.
   */
  private conversationId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    for (const msg of messages) {
      if (String((msg as any).role).toLowerCase() !== 'user') {
        continue;
      }
      const text = this.getMessageText(msg).trim();
      if (!text) {
        continue;
      }
      if (/^<system_reminder>[\s\S]*<\/system_reminder>$/.test(text)) {
        continue;
      }
      return hashText(text).slice(0, 16);
    }
    return '';
  }

  private restoreReasoningCache(context: vscode.ExtensionContext): void {
    try {
      const stored = context.workspaceState.get<ReasoningHistoryState>(REASONING_STORAGE_KEY);
      const entries = (stored?.entries ?? []) as [unknown, ReasoningEntry][];
      for (const [key, entry] of entries) {
        if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) {
          continue;
        }
        // Positional keys are only valid for the conversation that produced them,
        // so they are never persisted (and legacy numeric keys are ignored).
        const normalizedKey = typeof key === 'number' ? '' : String(key);
        if (!normalizedKey || normalizedKey.startsWith('idx:')) {
          continue;
        }
        this.reasoningCache.set(normalizedKey, entry);
      }
      if (this.reasoningCache.size > 0) {
        this.log.info(`Restored ${this.reasoningCache.size} reasoning entries from workspace state.`);
      }
    } catch {
      // ignore
    }
  }

  private persistReasoningCache(context: vscode.ExtensionContext): void {
    const state: ReasoningHistoryState = {
      nextReasoningTurnIndex: this.reasoningCache.size,
      entries: Array.from(this.reasoningCache.entries())
        .filter(([key]) => !key.startsWith('idx:')),
    };
    void context.workspaceState.update(REASONING_STORAGE_KEY, state);
  }
}
