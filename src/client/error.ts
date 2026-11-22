import { getMessage } from '../i18n';

/** Categorized network error kinds */
export type NetworkErrorKind =
  | 'dns'
  | 'unreachable'
  | 'interrupted'
  | 'timeout'
  | 'tls'
  | 'aborted'
  | 'protocol'
  | 'configuration'
  | 'generic';

/** Structured error result from the client */
export interface DeepSeekErrorResult {
  kind: 'http' | 'network' | 'unknown';
  status?: number;
  message: string;
  userMessage: string;
  actions?: DeepLinkAction[];
}

export interface DeepLinkAction {
  uri: string;
  label: string;
}

/** Categorize Node.js/undici error codes into our taxonomy */
export function categorizeNetworkError(error: Error & { code?: string; name?: string }): NetworkErrorKind {
  const code = error.code ?? '';
  const name = error.name ?? '';

  // Node.js error codes
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'unreachable';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'interrupted';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'tls';
  if (code === 'ABORT_ERR' || name === 'AbortError') return 'aborted';

  // undici error names
  if (name === 'ConnectTimeoutError') return 'timeout';
  if (name === 'BodyTimeoutError') return 'timeout';
  if (name === 'DNSResolveError') return 'dns';
  if (name === 'ConnectionError') return 'unreachable';
  if (name === 'InterruptError') return 'interrupted';
  if (name === 'ResponseStatusCodeError') return 'protocol';

  return 'generic';
}

/** Build a user-facing DeepSeekErrorResult from an HTTP status code */
export function httpError(status: number, body?: string): DeepSeekErrorResult {
  const statusMessages: Record<number, { message: string; actions?: DeepLinkAction[] }> = {
    400: { message: getMessage('requestFormatError') },
    401: {
      message: getMessage('apiKeyAuthFailure'),
      actions: [
        { uri: 'vscode://Vizards.deepseek-v4-for-copilot/setApiKey', label: 'Set API Key' },
      ],
    },
    402: { message: getMessage('insufficientBalance') },
    422: { message: getMessage('invalidRequestParams') },
    429: { message: getMessage('rateLimitExceeded') },
    500: { message: getMessage('serverError') },
    503: { message: getMessage('serverOverloaded') },
  };

  const entry = statusMessages[status];
  const message = entry?.message ?? getMessage('serviceError', String(status));

  return {
    kind: 'http',
    status,
    message: body ?? `HTTP ${status}`,
    userMessage: message,
    actions: entry?.actions,
  };
}

/** Build a user-facing error from a network error */
export function networkError(error: Error): DeepSeekErrorResult {
  const kind = categorizeNetworkError(error);
  const userMessages: Record<NetworkErrorKind, string> = {
    dns: getMessage('dnsError'),
    unreachable: getMessage('unreachableError'),
    timeout: getMessage('timeoutError'),
    interrupted: getMessage('interruptedError'),
    tls: getMessage('tlsError'),
    aborted: getMessage('abortedError'),
    protocol: getMessage('protocolError'),
    configuration: getMessage('configurationError'),
    generic: getMessage('networkGeneric', error.message),
  };

  return {
    kind: 'network',
    message: error.message,
    userMessage: userMessages[kind],
  };
}

/** Build an unknown error result */
export function unknownError(error: unknown): DeepSeekErrorResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'unknown',
    message,
    // streamChatCompletion re-wraps errors thrown by onError, so avoid
    // producing "DeepSeek API: DeepSeek API: ..." for already-prefixed messages.
    userMessage: message.startsWith('DeepSeek API') ? message : `DeepSeek API: ${message}`,
  };
}

/** Format a DeepSeekErrorResult into a user-visible error message (with optional deep links) */
export function formatErrorForUser(result: DeepSeekErrorResult): string {
  let msg = result.userMessage;
  if (result.actions && result.actions.length > 0) {
    const links = result.actions
      .map((a) => `[${a.label}](command:${a.uri.replace(/^vscode:\/\//, '')})`)
      .join(' | ');
    msg += `\n\n${links}`;
  }
  return msg;
}
