import {
  type DeepSeekRequest,
  type DeepSeekStreamChunk,
  type DeepSeekToolCall,
  type DeepSeekUsage,
  type StreamCallbacks,
} from '../types';
import { Logger } from '../logger';
import { httpError, networkError, unknownError, type DeepSeekErrorResult } from './error';
import { writeFailureDump } from '../deepseekFailures';

/**
 * Cap on accumulated text content (content + reasoning_content) in characters.
 * Raw wire bytes fluctuate wildly due to JSON framing (~200 bytes per token event),
 * so we cap on meaningful content instead. 4M chars ≈ 1M tokens of output, which
 * is far beyond any reasonable response.
 */
const ACCUMULATED_CONTENT_CAP = 4_000_000;

/**
 * DeepSeek requires `reasoning_content` on every previous assistant turn when the
 * request carries `tools`. Host-synthesized tool turns (e.g. an automatic terminal
 * read) and turns where thinking was disabled have none, so a marker is sent in
 * their place instead of letting the API reject the whole request.
 */
const MISSING_REASONING_CONTENT = '(no reasoning recorded for this turn)';

/**
 * Zero-dependency SSE streaming client for DeepSeek Chat Completions API.
 * Uses Node.js built-in fetch.
 */
export class DeepSeekClient {
  private baseUrl: string;
  private log: Logger;

  constructor(baseUrl: string, log: Logger) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.log = log;
  }

  toWireRequest(request: DeepSeekRequest): Record<string, unknown> {
    return normalizeRequestForApi(request);
  }

  formatWirePayload(payload: Record<string, unknown>, truncate: boolean = false): string {
    return formatPayloadForLog(payload, truncate);
  }

  async streamChatCompletion(
    request: DeepSeekRequest,
    apiKey: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseUrl}/chat/completions`;
    const wireRequest = this.toWireRequest(request);
    const requestBody = JSON.stringify(wireRequest);
    this.log.info(`DeepSeek request POST ${url}\n${this.formatWirePayload(wireRequest, false)}`);

    let failureDumped = false;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
        signal,
      });

      if (!response.ok) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        this.log.error(
          `DeepSeek request failed status=${response.status} statusText=${response.statusText}\n` +
          `responseBody=${bodyText || '<empty>'}`,
        );
        const err = httpError(response.status, bodyText);
        writeFailureDump(
          {
            source: 'copilot',
            model: request.model,
            url,
            status: response.status,
            statusText: response.statusText,
            error: err.userMessage,
            requestBody,
            responseBody: bodyText,
          },
          this.log,
        );
        failureDumped = true;
        callbacks.onError(new Error(err.userMessage));
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        writeFailureDump(
          {
            source: 'copilot',
            model: request.model,
            url,
            status: response.status,
            statusText: response.statusText,
            error: 'Response body has no readable stream.',
            requestBody,
            responseBody: '',
          },
          this.log,
        );
        failureDumped = true;
        callbacks.onError(new Error('Response body has no readable stream.'));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let totalContentLength = 0;
      const pendingToolCalls = new Map<number, DeepSeekToolCall>();
      let usage: DeepSeekUsage | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines from buffer
          while (buffer.includes('\n')) {
            const newlineIdx = buffer.indexOf('\n');
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);

            if (!line) continue;
            if (!line.startsWith('data: ')) continue;
            callbacks.onSseData?.(line);

            const data = line.slice(6);
            if (data === '[DONE]') {
              flushToolCalls(pendingToolCalls, callbacks);
              if (usage) callbacks.onUsage?.(usage);
              callbacks.onDone();
              return;
            }

            try {
              const chunk: DeepSeekStreamChunk = JSON.parse(data);
              processChunk(chunk, pendingToolCalls, callbacks, (u) => { usage = u; });

              // Cap on accumulated text content, not raw wire bytes
              const delta = chunk.choices?.[0]?.delta;
              if (delta) {
                totalContentLength += (delta.content?.length ?? 0) + (delta.reasoning_content?.length ?? 0);
                if (totalContentLength > ACCUMULATED_CONTENT_CAP) {
                  callbacks.onError(new Error('Response content exceeded 4 MB cap. Please shorten your request or start a new conversation.'));
                  reader.cancel();
                  return;
                }
              }
            } catch {
              // Malformed JSON line — skip
              this.log.warn('Malformed SSE line:', line);
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          flushToolCalls(pendingToolCalls, callbacks);
          callbacks.onDone();
          return;
        }
        throw err;
      }

      // Tail bytes after stream ends
      if (buffer.trim()) {
        const data = buffer.trim();
        if (data.startsWith('data: ')) {
          callbacks.onSseData?.(data);
          const json = data.slice(6);
          if (json !== '[DONE]') {
            try {
              const chunk: DeepSeekStreamChunk = JSON.parse(json);
              processChunk(chunk, pendingToolCalls, callbacks, (u) => { usage = u; });
            } catch {
              // ignore
            }
          }
        }
      }

      flushToolCalls(pendingToolCalls, callbacks);
      if (usage) callbacks.onUsage?.(usage);
      callbacks.onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        callbacks.onDone();
        return;
      }
      const result: DeepSeekErrorResult = err instanceof Error && 'code' in err
        ? networkError(err as Error & { code?: string })
        : unknownError(err);
      if (!failureDumped) {
        writeFailureDump(
          {
            source: 'copilot',
            model: request.model,
            url,
            error: result.userMessage,
            requestBody,
            responseBody: '',
          },
          this.log,
        );
      }
      callbacks.onError(new Error(result.userMessage));
    }
  }
}

function formatPayloadForLog(payload: Record<string, unknown>, truncate: boolean = false): string {
  try {
    const pretty = JSON.stringify(payload, null, 2);
    if (!truncate) {
      return pretty;
    }
    return pretty.length > 40_000
      ? `${pretty.slice(0, 40_000)}\n... <truncated ${pretty.length - 40_000} chars>`
      : pretty;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `<failed to serialize request payload: ${detail}>`;
  }
}

function normalizeRequestForApi(request: DeepSeekRequest): Record<string, unknown> {
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
  const normalized: Record<string, unknown> = {
    model: request.model,
    messages: normalizeMessages(request.messages, hasTools),
    stream: true,
  };

  if (request.thinking) {
    normalized.thinking = { type: request.thinking.type };
  }

  if (request.reasoning_effort) {
    normalized.reasoning_effort = request.reasoning_effort;
  }

  if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) {
    normalized.temperature = request.temperature;
  }

  if (hasTools) {
    normalized.tools = request.tools;
    normalized.tool_choice = request.tool_choice ?? 'auto';
  }

  if (typeof request.max_tokens === 'number' && request.max_tokens > 0) {
    normalized.max_tokens = request.max_tokens;
  }

  if (request.stream_options?.include_usage) {
    normalized.stream_options = { include_usage: true };
  }

  return normalized;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');

  // Accept both base origins and full chat completion endpoints from settings.
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed.slice(0, -'/chat/completions'.length);
  }

  return trimmed;
}

function normalizeMessages(
  messages: DeepSeekRequest['messages'],
  requireReasoningContent: boolean,
): Record<string, unknown>[] {
  const normalized: Record<string, unknown>[] = [];
  const declaredToolCallIds = new Set<string>();

  for (const message of messages) {
    if (!message || (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')) {
      continue;
    }

    const msg: Record<string, unknown> = { role: message.role };

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const seenIds = new Set<string>();
      const toolCalls = message.tool_calls.filter((tc) => {
        const valid =
          tc &&
          typeof tc.id === 'string' &&
          tc.id.length > 0 &&
          !seenIds.has(tc.id) &&
          tc.type === 'function' &&
          tc.function &&
          typeof tc.function.name === 'string' &&
          tc.function.name.length > 0 &&
          typeof tc.function.arguments === 'string';
        if (valid) {
          seenIds.add(tc.id);
          declaredToolCallIds.add(tc.id);
        }
        return valid;
      });

      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
    }

    if (message.role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      // DeepSeek requires every tool result to match a tool call declared by an
      // earlier assistant message, and exactly once. Orphans are a 400.
      if (!toolCallId || !declaredToolCallIds.has(toolCallId)) {
        continue;
      }
      declaredToolCallIds.delete(toolCallId);
      msg.tool_call_id = toolCallId;
    }

    // `content` is a required (nullable) field for every role. Omitting it on
    // assistant tool-call turns has been accepted historically but violates the
    // schema, so always send a string.
    const content = typeof message.content === 'string' ? message.content : '';
    msg.content = content;

    if (message.role === 'assistant') {
      // With `tools` in the request DeepSeek requires reasoning_content from all
      // previous assistant turns; dropping it yields "Request body format error".
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        msg.reasoning_content = message.reasoning_content;
      } else if (requireReasoningContent) {
        msg.reasoning_content = MISSING_REASONING_CONTENT;
      }

      if (!Array.isArray(msg.tool_calls) && content.trim().length === 0) {
        continue;
      }
    }

    if (typeof message.name === 'string' && message.name.length > 0) {
      msg.name = message.name;
    }

    normalized.push(msg);
  }

  return pruneUnansweredToolCalls(normalized, declaredToolCallIds);
}

/**
 * Drop tool calls that never received a result. DeepSeek requires every tool call
 * on an assistant message to be answered; leaving one unanswered (a cancelled or
 * lost tool result) is another "Request body format error".
 */
function pruneUnansweredToolCalls(
  messages: Record<string, unknown>[],
  unanswered: Set<string>,
): Record<string, unknown>[] {
  if (unanswered.size === 0) {
    return messages;
  }

  const pruned: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const kept = (message.tool_calls as DeepSeekToolCall[]).filter((call) => !unanswered.has(call.id));
      if (kept.length !== message.tool_calls.length) {
        if (kept.length === 0) {
          const content = typeof message.content === 'string' ? message.content : '';
          if (content.trim().length === 0) {
            continue;
          }
          delete message.tool_calls;
        } else {
          message.tool_calls = kept;
        }
      }
    }
    pruned.push(message);
  }

  return pruned;
}

function processChunk(
  chunk: DeepSeekStreamChunk,
  pendingToolCalls: Map<number, DeepSeekToolCall>,
  callbacks: StreamCallbacks,
  setUsage: (usage: DeepSeekUsage) => void,
): void {
  const choice = chunk.choices?.[0];
  if (!choice) {
    if (chunk.usage) {
      setUsage(chunk.usage);
    }
    return;
  }

  const delta = choice.delta;

  if (delta.content) {
    callbacks.onContent(delta.content);
  }

  if (delta.reasoning_content) {
    callbacks.onThinking?.(delta.reasoning_content);
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      let existing = pendingToolCalls.get(tc.index);
      if (!existing) {
        existing = {
          id: tc.id ?? '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        pendingToolCalls.set(tc.index, existing);
      }
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.function.name += tc.function.name;
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
    }
  }

  if (choice.finish_reason === 'tool_calls') {
    flushToolCalls(pendingToolCalls, callbacks);
  }

  if (chunk.usage) {
    setUsage(chunk.usage);
  }
}

function flushToolCalls(
  pending: Map<number, DeepSeekToolCall>,
  callbacks: StreamCallbacks,
): void {
  if (pending.size === 0) return;
  for (const tc of pending.values()) {
    tc.function.arguments = tc.function.arguments || '{}';
    callbacks.onToolCall(tc);
  }
  pending.clear();
}
