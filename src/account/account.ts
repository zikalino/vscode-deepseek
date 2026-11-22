// The hosted token allowance: GitHub device-flow sign-in, then a session issued by the quota
// service (see `server/`). When a session exists the extension talks to the proxy with the session
// token instead of a user-supplied DeepSeek key; when it does not, the caller falls back to the
// existing BYO-key path, so signing in is never required to use the extension.

import * as vscode from 'vscode';

import {
  DEFAULT_ACCOUNT_PROXY_URL,
  SECRET_ACCOUNT_GITHUB_TOKEN,
  SECRET_ACCOUNT_SESSION,
} from '../consts';
import { DeviceCodeInfo, pollForAccessToken, requestDeviceCode } from './deviceFlow';

export type AccountTier = 'free' | 'sponsor';

export interface AccountQuota {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}

export interface AccountInfo {
  id: string;
  login: string;
  tier: AccountTier;
  quota: AccountQuota;
}

export interface AccountAccess {
  apiKey: string;
  /** Base URL the DeepSeek client appends `/chat/completions` to. */
  baseUrl: string;
  /** Full chat-completions URL for the Advance engine, which takes an endpoint. */
  chatUrl: string;
}

interface StoredSession {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  account: AccountInfo;
}

const SETTINGS_NS = 'deepseek.account';
/** Refresh a little before expiry so a request never races the boundary. */
const REFRESH_MARGIN_MS = 60_000;

export class AccountManager {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** The OAuth app client id, or "" when the user has not configured one. */
  get clientId(): string {
    return vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('githubClientId', '').trim();
  }

  /** The quota service base URL, without a trailing slash. */
  get proxyUrl(): string {
    const configured = vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('proxyUrl', '');
    const trimmed = (configured || DEFAULT_ACCOUNT_PROXY_URL).trim().replace(/\/+$/, '');
    return trimmed.length > 0 ? trimmed : DEFAULT_ACCOUNT_PROXY_URL;
  }

  private get apiBase(): string {
    return `${this.proxyUrl}/v1`;
  }

  /** Refresh the session if it is missing or nearly expired. Undefined means "not signed in". */
  async getSession(force = false): Promise<StoredSession | undefined> {
    if (!force) {
      const existing = await this.readSession();
      if (existing !== undefined && existing.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
        return existing;
      }
    }
    const githubToken = await this.context.secrets.get(SECRET_ACCOUNT_GITHUB_TOKEN);
    if (githubToken === undefined || githubToken.length === 0) {
      return undefined;
    }
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken }),
      });
    } catch {
      // Offline or the proxy is down: keep the BYO-key path usable instead of throwing.
      return undefined;
    }
    if (response.status === 401) {
      // The GitHub token was revoked or expired; the user has to sign in again.
      await this.clearAll();
      return undefined;
    }
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as Record<string, unknown>;
    const session: StoredSession = {
      token: String(data.token ?? ''),
      expiresAt: Date.parse(String(data.expiresAt ?? '')) || Date.now() + 3_600_000,
      account: normalizeAccount(data),
    };
    if (session.token.length === 0) {
      return undefined;
    }
    await this.writeSession(session);
    this.changed.fire();
    return session;
  }

  /** The key and URL to use when a session exists; undefined means fall back to the BYO key. */
  async getAccess(): Promise<AccountAccess | undefined> {
    const session = await this.getSession();
    if (session === undefined) {
      return undefined;
    }
    return {
      apiKey: session.token,
      baseUrl: this.apiBase,
      chatUrl: `${this.apiBase}/chat/completions`,
    };
  }

  /** The cached account, without touching the network. */
  async getAccount(): Promise<AccountInfo | undefined> {
    return (await this.getSession())?.account;
  }

  /** Re-read quota from the service; falls back to the cached copy when the service is unreachable. */
  async refreshUsage(): Promise<AccountInfo | undefined> {
    const session = await this.getSession();
    if (session === undefined) {
      return undefined;
    }
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/usage`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
    } catch {
      return session.account;
    }
    if (response.status === 401) {
      await this.context.secrets.delete(SECRET_ACCOUNT_SESSION);
      return (await this.getSession(true))?.account;
    }
    if (!response.ok) {
      return session.account;
    }
    const account = normalizeAccount((await response.json()) as Record<string, unknown>);
    await this.writeSession({ ...session, account });
    this.changed.fire();
    return account;
  }

  /** Request a device code. Throws when the OAuth app client id is not configured. */
  async startDeviceFlow(): Promise<DeviceCodeInfo> {
    const clientId = this.clientId;
    if (clientId.length === 0) {
      throw new Error(
        'No GitHub OAuth app configured. Set "deepseek.account.githubClientId" to the client id ' +
          'of an OAuth app with Device Flow enabled.',
      );
    }
    return requestDeviceCode(clientId);
  }

  /** Wait for authorization, store the GitHub token, then exchange it for a quota session. */
  async finishDeviceFlow(
    device: DeviceCodeInfo,
    isCancelled: () => boolean = () => false,
  ): Promise<AccountInfo> {
    const githubToken = await pollForAccessToken(this.clientId, device, isCancelled);
    await this.context.secrets.store(SECRET_ACCOUNT_GITHUB_TOKEN, githubToken);
    await this.context.secrets.delete(SECRET_ACCOUNT_SESSION);
    const session = await this.getSession(true);
    if (session === undefined) {
      throw new Error(
        'The quota service rejected the GitHub sign-in. Check that the proxy is running and ' +
          'that this GitHub account is eligible.',
      );
    }
    return session.account;
  }

  async signOut(): Promise<void> {
    await this.clearAll();
    this.changed.fire();
  }

  private async readSession(): Promise<StoredSession | undefined> {
    const raw = await this.context.secrets.get(SECRET_ACCOUNT_SESSION);
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as StoredSession;
      if (typeof parsed?.token === 'string' && typeof parsed?.expiresAt === 'number') {
        return parsed;
      }
    } catch {
      // A corrupt entry is just a missing session.
    }
    return undefined;
  }

  private async writeSession(session: StoredSession): Promise<void> {
    await this.context.secrets.store(SECRET_ACCOUNT_SESSION, JSON.stringify(session));
  }

  private async clearAll(): Promise<void> {
    await Promise.all([
      this.context.secrets.delete(SECRET_ACCOUNT_GITHUB_TOKEN),
      this.context.secrets.delete(SECRET_ACCOUNT_SESSION),
    ]);
  }
}

function normalizeAccount(data: Record<string, unknown>): AccountInfo {
  const user = (data.user ?? {}) as Record<string, unknown>;
  const quota = (data.quota ?? {}) as Record<string, unknown>;
  return {
    id: String(user.id ?? ''),
    login: String(user.login ?? ''),
    tier: data.tier === 'sponsor' ? 'sponsor' : 'free',
    quota: {
      limit: Number(quota.limit) || 0,
      used: Number(quota.used) || 0,
      remaining: Number(quota.remaining) || 0,
      resetsAt: String(quota.resetsAt ?? ''),
    },
  };
}

const managers = new WeakMap<vscode.ExtensionContext, AccountManager>();

/** One manager per context, so providers and panels see the same change events. */
export function accountManager(context: vscode.ExtensionContext): AccountManager {
  let manager = managers.get(context);
  if (manager === undefined) {
    manager = new AccountManager(context);
    managers.set(context, manager);
  }
  return manager;
}
