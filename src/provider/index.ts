import * as vscode from 'vscode';
import { MODELS, VENDOR_ID, SECRET_KEY, SETTINGS_NS, COPILOT_SETTINGS_NS, DEFAULT_CHARS_PER_TOKEN, EMA_ALPHA, MAX_TOOLS } from '../consts';
import {
  type ModelDefinition,
  type DeepSeekRequest,
  type ReasoningEntry,
  type ReasoningHistoryState,
  type DeepSeekTool,
  type DeepSeekUsage,
} from '../types';
import { Logger } from '../logger';
import { AuthManager } from '../auth';
import { DeepSeekClient } from '../client/core';
import {
  convertMessages,
  convertTools,
  getConfiguredTemperature,
  getConfiguredThinkingEffort,
  countMessageChars,
  reasoningIndexKey,
  reasoningTextKey,
  reasoningToolCallKey,
} from './convert';
import { classifyRequest } from './debug/classifier';
import { buildCacheDiagnostics, computePrefixOverlapRatio } from './debug/diagnostics';
import { RequestDumper } from './debug/dump';
import { ReplayEngine } from './replay/engine';
import { ToolStabilizer, enforceToolLimit } from './tools/flow';
import { VisionProxy } from './vision/proxy';
import { getDebugMode } from './schema';
import { writeHistoryEntry } from '../deepseekLogBrowser';

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

export class DeepSeekChatProvider implements vscode.LanguageModelChatProvider {
  private log: Logger;
  private auth: AuthManager;
  private client: DeepSeekClient;
  private replay: ReplayEngine;
  private stabilizer: ToolStabilizer;
  private dumper: RequestDumper;
  private vision: VisionProxy;
  private charsPerToken: number = DEFAULT_CHARS_PER_TOKEN;
  private reasoningCache: Map<string, ReasoningEntry> = new Map();
  private prevMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined;
  private context: vscode.ExtensionContext;
  private _onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this._onDidChange.event;

  constructor(context: vscode.ExtensionContext, auth: AuthManager, log: Logger) {
    this.log = log;
    this.auth = auth;
    this.context = context;
    this.client = new DeepSeekClient(
      vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('baseUrl', 'https://api.deepseek.com'),
      log,
    );
    this.replay = new ReplayEngine(log);
    this.stabilizer = new ToolStabilizer(log);
    this.dumper = new RequestDumper(context, log);
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
            this.client = new DeepSeekClient(
              vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('baseUrl', 'https://api.deepseek.com'),
              this.log,
            );
          }
        }
        if (
          e.affectsConfiguration(`${COPILOT_SETTINGS_NS}.debugMode`) ||
          e.affectsConfiguration(`${COPILOT_SETTINGS_NS}.dumpRequests`)
        ) {
          this.syncDebugSettings();
        }
      }),
    );

    // Listen for SecretStorage changes (cross-window)
    context.subscriptions.push(
      this.auth.onDidChangeApiKey(() => {
        this._onDidChange.fire();
      }),
    );
  }

  // ── provideLanguageModelChatInformation ─────────────────────

  /** Ask VS Code to re-resolve this vendor's model list (e.g. right after registration). */
  notifyModelsChanged(): void {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasKey = await this.auth.getApiKey();

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

      if (!hasKey) {
        info.detail = 'Please run DeepSeek: Set API Key to configure.';
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
    // 1. Auth
    const apiKey = await this.auth.getApiKey();
    if (!apiKey) {
      throw new Error('DeepSeek API key not configured. Run the "DeepSeek: Set API Key" command.');
    }

    // 2. Model lookup
    const modelDef = MODELS.find((m) => m.id === modelInfo.id);
    if (!modelDef) {
      throw new Error(`Unknown model: ${modelInfo.id}`);
    }

    // 3. Debug mode check
    const debugMode = this.syncDebugSettings();

    // 4. Segment / replay marker extraction
    const segmentId = this.resolveSegmentId(messages);

    // Dump raw Copilot payload to workspace .dump/ when deepseek-copilot.dumpRequests is on
    this.dumper.dumpCopilotFlat({
      modelInfo,
      messages: messages.map((m) => ({
        role: (m as any).role,
        content: (m as any).content,
      })),
      options: {
        tools: (options.tools ?? []).map((t: any) => {
          const def = t?.definition ?? t;
          return { name: def?.name, description: def?.description, inputSchema: def?.inputSchema ?? def?.parameters };
        }),
        modelConfiguration: (options as any)?.modelConfiguration,
      },
    });

    if (debugMode === 'verbose') {
      await this.dumper.dumpCopilotOriginalPayload(segmentId, {
        modelInfo,
        messages,
        options,
      });
      await this.dumper.dumpProviderInput(segmentId, {
        modelInfo,
        messages: messages.map((m) => ({
          role: m.role,
          parts: (m as any).content?.map((p: any) => ({ type: p.type, ...p })),
        })),
      });
      await this.dumper.dumpCopilotMessages(segmentId, {
        modelInfo,
        messages: messages.map((m) => ({
          role: m.role,
          parts: (m as any).content?.map((p: any) => ({ type: p.type, ...p })),
        })),
        options: {
          tools: (options.tools ?? []).map((t: any) => {
            const def = t?.definition ?? t;
            return {
              name: def?.name,
              description: def?.description,
              inputSchema: def?.inputSchema ?? def?.parameters,
            };
          }),
          modelConfiguration: (options as any)?.modelConfiguration,
          configuration: (options as any)?.configuration,
        },
      });
    }

    // 5. Classify request
    const kind = classifyRequest(messages, options.tools);

    // 6. Build cache diagnostics
    const diagnostics = buildCacheDiagnostics(segmentId, 'markerMissing', messages);
    if (debugMode !== 'minimal') {
      this.log.info(`[${kind}] segment=${segmentId} msgs=${messages.length}`);
    }

    // 7. Vision proxy
    const { resolvedMessages: visionMessages, stats: visionStats } = await this.vision.resolveImages(messages);

    // 8. Tool flow
    const vsCodeTools = options.tools ?? [];
    let deepseekTools: DeepSeekTool[] | undefined;
    if (modelDef.supportsToolCalling && vsCodeTools.length > 0) {
      deepseekTools = convertTools(vsCodeTools) ?? [];
      deepseekTools = enforceToolLimit(deepseekTools, this.log);

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

      // Add drift notice
      const processedMessages = driftNotice
        ? this.injectDriftNotice(visionMessages, driftNotice)
        : visionMessages;

      // 9. Build request
      const request = await this.buildRequest(modelDef, processedMessages, deepseekTools, options, kind);
      const wireRequest = this.client.toWireRequest(request);
      // Opt-in: deepseek-copilot.dumpRequests writes this payload to workspace .dump/
      this.dumper.dumpDeepSeekOutFlat(wireRequest);
      if (debugMode === 'verbose') {
        await this.dumper.dumpRequestPayload(segmentId, request);
        await this.dumper.dumpWireRequestPayload(segmentId, wireRequest);
        await this.dumper.dumpWireRequestLogFull(segmentId, this.client.formatWirePayload(wireRequest, false));
      }

      // 10. Stream
      await this.streamResponse(request, apiKey, modelDef, progress, token, segmentId, kind);
    } else {
      // No tools — simplified path
      const request = await this.buildRequest(modelDef, visionMessages, deepseekTools, options, kind);
      const wireRequest = this.client.toWireRequest(request);
      // Opt-in: deepseek-copilot.dumpRequests writes this payload to workspace .dump/
      this.dumper.dumpDeepSeekOutFlat(wireRequest);
      if (debugMode === 'verbose') {
        await this.dumper.dumpRequestPayload(segmentId, request);
        await this.dumper.dumpWireRequestPayload(segmentId, wireRequest);
        await this.dumper.dumpWireRequestLogFull(segmentId, this.client.formatWirePayload(wireRequest, false));
      }
      await this.streamResponse(request, apiKey, modelDef, progress, token, segmentId, kind);
    }
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

  private syncDebugSettings(): string {
    const debugMode = getDebugMode();
    this.dumper.setEnabled(debugMode === 'verbose');
    this.dumper.setFlatEnabled(
      vscode.workspace.getConfiguration(COPILOT_SETTINGS_NS).get<boolean>('dumpRequests', false),
    );
    return debugMode;
  }

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
  ): Promise<DeepSeekRequest> {
    // Reasoning cache management — clear if this is turn 0 or 1 (new session)
    if (messages.length <= 2) {
      this.reasoningCache.clear();
    }

    // Message conversion
    const deepseekMessages = convertMessages(messages, this.reasoningCache);
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
    request: DeepSeekRequest,
    apiKey: string,
    modelDef: ModelDefinition,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    segmentId: string,
    _kind: string,
  ): Promise<void> {
    // Track reasoning text for caching
    let fullReasoningText = '';
    // Positional fallback: the response becomes the next request's assistant
    // message with this index.
    const assistantTurnIndex = request.messages.filter((m) => m.role === 'assistant').length;
    const toolCallIds: string[] = [];
    const inboundSseData: string[] = [];
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
        onSseData: (line: string) => {
          inboundSseData.push(line);
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
            this.reasoningCache.set(reasoningIndexKey(assistantTurnIndex), entry);
            for (const id of toolCallIds) {
              this.reasoningCache.set(reasoningToolCallKey(id), entry);
            }
            if (toolCallIds.length === 0 && fullResponseContent.trim()) {
              this.reasoningCache.set(reasoningTextKey(fullResponseContent), entry);
            }
            this.pruneReasoningCache();
            this.persistReasoningCache(this.context);
          }
          // Log Copilot request to history
          this.logCopilotHistory(request, fullResponseContent, lastUsage);
        },
        onUsage: (usage: DeepSeekUsage) => {
          lastUsage = usage;
          this.handleUsage(usage, request);
          const debugMode = getDebugMode();
          if (debugMode !== 'minimal') {
            const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
            const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
            const completion = usage.completion_tokens;
            this.log.info(
              `M:${cacheMiss} H:${cacheHit} O:${completion} ` +
              `temp: ${request.temperature ?? 'default'}`,
            );
          }
        },
      };

      await this.client.streamChatCompletion(request, apiKey, callbacks, abortController.signal);
    } finally {
      this.dumper.dumpDeepSeekInFlat({
        model: request.model,
        receivedAt: new Date().toISOString(),
        sseData: inboundSseData,
      });
      disposable.dispose();
    }
  }

  private handleUsage(usage: DeepSeekUsage, _request: DeepSeekRequest): void {
    const totalRequestChars = countMessageChars(_request.messages);
    const totalTokens = usage.prompt_tokens + usage.completion_tokens;
    if (totalTokens > 0 && totalRequestChars > 0) {
      const observed = totalRequestChars / totalTokens;
      // Exponential moving average
      this.charsPerToken = this.charsPerToken * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
    }
  }

  /** Log Copilot requests to the history directory. */
  private logCopilotHistory(
    request: DeepSeekRequest,
    responseContent: string,
    usage?: DeepSeekUsage,
  ): void {
    const ts = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const timestamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const model = request.model;
    const reqBody = JSON.stringify(request);
    const pt = usage?.prompt_tokens ?? 0;
    const ct = usage?.completion_tokens ?? 0;
    const ch = usage?.prompt_cache_hit_tokens ?? 0;
    const cm = usage?.prompt_cache_miss_tokens ?? 0;
    const pricing: Record<string, { input: number; inputCacheHit: number; output: number }> = {
      'deepseek-v4-flash': { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },
      'deepseek-v4-pro':   { input: 0.435, inputCacheHit: 0.003625, output: 0.87 },
      'deepseek-chat':     { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },
      'deepseek-reasoner': { input: 0.14, inputCacheHit: 0.0028, output: 0.28 },
    };
    const pr = pricing[model] || { input: 0.435, inputCacheHit: 0.003625, output: 0.87 };
    const firstUserMsg = request.messages?.find(m => m.role === 'user');
    const requestSummary = typeof firstUserMsg?.content === 'string'
      ? firstUserMsg.content.slice(0, 500)
      : '';
    // Reconstruct a full JSON response from the streaming data
    const responseJson: Record<string, unknown> = {
      choices: [{
        message: {
          content: responseContent,
        },
        finish_reason: 'stop',
      }],
    };
    if (usage) {
      responseJson.usage = {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        prompt_cache_hit_tokens: ch,
        prompt_cache_miss_tokens: cm,
      };
    }
    const responseBodyJson = JSON.stringify(responseJson, null, 2);
    try {
      writeHistoryEntry({
        timestamp,
        model,
        source: 'copilot',
        requestSummary,
        requestBody: reqBody,
        responseBody: responseBodyJson,
        requestSizeBytes: Buffer.byteLength(reqBody, 'utf8'),
        responseSizeBytes: Buffer.byteLength(responseBodyJson, 'utf8'),
        totalTokens: pt + ct,
        promptTokens: pt,
        completionTokens: ct,
        cacheHitTokens: ch,
        cacheMissTokens: cm,
        costUsd: (cm / 1_000_000) * pr.input + (ch / 1_000_000) * pr.inputCacheHit + (ct / 1_000_000) * pr.output,
        hadError: false,
        correlationId: timestamp,
      });
    } catch {
      // silently fail
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

  private pruneReasoningCache(): void {
    const MAX_ENTRIES = 200;
    if (this.reasoningCache.size <= MAX_ENTRIES) {
      return;
    }
    const entries = Array.from(this.reasoningCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const overflow = this.reasoningCache.size - MAX_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      this.reasoningCache.delete(entries[i][0]);
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
