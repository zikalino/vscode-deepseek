import type { ModelDefinition } from './types';

export const MODELS: ModelDefinition[] = [
  {
    id: 'deepseek-v4-flash',
    apiModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    maxInputTokens: 655_360,
    maxOutputTokens: 393_216,
    requiresThinkingParam: true,
    supportsToolCalling: true,
    supportsVision: true,
    supportsImageInput: false,
  },
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    maxInputTokens: 655_360,
    maxOutputTokens: 393_216,
    requiresThinkingParam: true,
    supportsToolCalling: true,
    supportsVision: true,
    supportsImageInput: false,
  },
];

export const VENDOR_ID = 'deepseek';
export const VSCODE_LM_VENDOR = 'deepseek';

/** SecretStorage key for the DeepSeek API key */
export const SECRET_KEY = 'deepseek.apiKey';

/** SecretStorage key for the GitHub token obtained by the device flow. */
export const SECRET_ACCOUNT_GITHUB_TOKEN = 'deepseek.account.githubToken';

/** SecretStorage key for the quota-service session issued in exchange for the GitHub token. */
export const SECRET_ACCOUNT_SESSION = 'deepseek.account.session';

/** Default quota-service URL; `deepseek.account.proxyUrl` overrides it. */
export const DEFAULT_ACCOUNT_PROXY_URL = 'http://localhost:8787';

/** Settings namespace */
export const SETTINGS_NS = 'deepseek';

/** Settings namespace for Copilot-specific diagnostics (debugMode, dumpRequests) */
export const COPILOT_SETTINGS_NS = 'deepseek-copilot';

/** Maximum allowed tool functions per request (DeepSeek API limit) */
export const MAX_TOOLS = 128;

/** Default vision proxy prompt */
export const IMAGE_DESCRIPTION_PROMPT = `You are an image description assistant.
Your task is to describe all images in the user's message in detail.
Focus on: text content, UI elements, code snippets, diagrams, and any visual information relevant to a programming task.
Format the description as plain text, starting with "[Image Description:".`;

/** Chars-per-token ratio initial value */
export const DEFAULT_CHARS_PER_TOKEN = 4.0;

/** Chars-per-token EMA update factor */
export const EMA_ALPHA = 0.3;
