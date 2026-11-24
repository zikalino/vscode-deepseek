import * as vscode from 'vscode';

type Language = 'en' | 'zh-cn';
type MessageKey =
  | 'setApiKeyTitle'
  | 'clearApiKeyTitle'
  | 'showLogsTitle'
  | 'openSettingsTitle'
  | 'setVisionModelTitle'
  | 'getApiKeyTitle'
  | 'noApiKeyDetail'
  | 'apiKeyAuthFailure'
  | 'insufficientBalance'
  | 'rateLimitExceeded'
  | 'serverError'
  | 'serverOverloaded'
  | 'requestFormatError'
  | 'invalidRequestParams'
  | 'serviceError'
  | 'dnsError'
  | 'unreachableError'
  | 'timeoutError'
  | 'interruptedError'
  | 'tlsError'
  | 'abortedError'
  | 'protocolError'
  | 'configurationError'
  | 'networkGeneric';

const MESSAGES: Record<Language, Record<MessageKey, string>> = {
  en: {
    setApiKeyTitle: 'DeepSeek: Set API Key',
    clearApiKeyTitle: 'DeepSeek: Clear API Key',
    showLogsTitle: 'DeepSeek: Show Logs',
    openSettingsTitle: 'DeepSeek: Open Settings',
    setVisionModelTitle: 'DeepSeek: Set Vision Proxy Model',
    getApiKeyTitle: 'DeepSeek: Get API Key',
    noApiKeyDetail: 'Please run DeepSeek: Set API Key to configure.',
    apiKeyAuthFailure: 'DeepSeek API key authentication failed. [Create API Key](https://platform.deepseek.com/api-keys)',
    insufficientBalance: 'DeepSeek API: Insufficient balance. Please add credits to your account.',
    rateLimitExceeded: 'DeepSeek API: Rate limit exceeded. Please wait and try again.',
    serverError: 'DeepSeek API: Server internal fault. Please try again later.',
    serverOverloaded: 'DeepSeek API: Server overloaded. Please try again later.',
    requestFormatError: 'DeepSeek API: Request body format error.',
    invalidRequestParams: 'DeepSeek API: Invalid request parameters.',
    serviceError: 'DeepSeek API: Service returned an error ({0}).',
    dnsError: 'Could not resolve DeepSeek API hostname. Check your network connection.',
    unreachableError: 'Could not reach DeepSeek API. Check your network or proxy settings.',
    timeoutError: 'Connection to DeepSeek API timed out. Try again later or check your network.',
    interruptedError: 'Connection to DeepSeek API was interrupted.',
    tlsError: 'TLS/SSL connection to DeepSeek API failed. Check your network or proxy settings.',
    abortedError: 'Request was cancelled.',
    protocolError: 'Unexpected response protocol from DeepSeek API.',
    configurationError: 'DeepSeek extension configuration error.',
    networkGeneric: 'Network error when connecting to DeepSeek API: {0}',
  },
  'zh-cn': {
    setApiKeyTitle: 'DeepSeek：设置 API 密钥',
    clearApiKeyTitle: 'DeepSeek：清除 API 密钥',
    showLogsTitle: 'DeepSeek：显示日志',
    openSettingsTitle: 'DeepSeek：打开设置',
    setVisionModelTitle: 'DeepSeek：设置视觉代理模型',
    getApiKeyTitle: 'DeepSeek：获取 API 密钥',
    noApiKeyDetail: '请运行 DeepSeek：设置 API 密钥 进行配置。',
    apiKeyAuthFailure: 'DeepSeek API 密钥认证失败。[创建 API 密钥](https://platform.deepseek.com/api-keys)',
    insufficientBalance: 'DeepSeek API：余额不足。请为账户充值。',
    rateLimitExceeded: 'DeepSeek API：超出速率限制。请稍后重试。',
    serverError: 'DeepSeek API：服务器内部错误。请稍后重试。',
    serverOverloaded: 'DeepSeek API：服务器过载。请稍后重试。',
    requestFormatError: 'DeepSeek API：请求体格式错误。',
    invalidRequestParams: 'DeepSeek API：请求参数无效。',
    serviceError: 'DeepSeek API：服务返回错误 ({0})。',
    dnsError: '无法解析 DeepSeek API 主机名。请检查网络连接。',
    unreachableError: '无法连接到 DeepSeek API。请检查网络或代理设置。',
    timeoutError: 'DeepSeek API 连接超时。请稍后重试或检查网络。',
    interruptedError: 'DeepSeek API 连接中断。',
    tlsError: 'DeepSeek API 的 TLS/SSL 连接失败。请检查网络或代理设置。',
    abortedError: '请求已取消。',
    protocolError: '来自 DeepSeek API 的意外响应协议。',
    configurationError: 'DeepSeek 扩展配置错误。',
    networkGeneric: '连接到 DeepSeek API 时出现网络错误：{0}',
  },
};

export function getMessage(key: MessageKey, ...args: string[]): string {
  const lang = detectLanguage();
  let msg = MESSAGES[lang][key] ?? MESSAGES.en[key];
  args.forEach((arg, i) => {
    msg = msg.replace(`{${i}}`, arg);
  });
  return msg;
}

function detectLanguage(): Language {
  const lang = vscode.env.language;
  if (lang === 'zh-cn') return 'zh-cn';
  return 'en';
}
