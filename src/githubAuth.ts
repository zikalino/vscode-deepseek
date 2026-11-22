// GitHub sign-in through VS Code's built-in authentication provider.
//
// VS Code owns the OAuth flow, token storage and refresh, so the extension never sees a client
// secret and never stores a personal access token. The `repo` scope is what publishing a gallery
// tool needs; the account identity comes from the session itself. The token is handed to the engine
// worker at startup and never sent to the webview.

import * as vscode from 'vscode';

export const GITHUB_AUTH_PROVIDER = 'github';

/**
 * `repo` covers pushing a gallery branch and opening its pull request. Identity comes from the
 * session's account, so no extra scope is needed; a narrower list also improves session reuse.
 */
export const GITHUB_SCOPES: readonly string[] = ['repo'];

export interface GitHubIdentity {
  /** The stable account id GitHub reports. */
  id: string;
  /** The label VS Code shows for the account (usually the login name). */
  label: string;
}

/** Thin wrapper over `vscode.authentication` for the built-in GitHub provider. */
export class GitHubAuth {
  constructor(private readonly scopes: readonly string[] = GITHUB_SCOPES) {}

  /** The current session without prompting. Undefined when signed out or no provider is available. */
  async getSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, this.scopes, {
        createIfNone: false,
      });
    } catch {
      return undefined;
    }
  }

  /** The access token for API and git calls, or undefined when signed out. */
  async getToken(): Promise<string | undefined> {
    return (await this.getSession())?.accessToken;
  }

  /** The signed-in account, or undefined when signed out. */
  async getIdentity(): Promise<GitHubIdentity | undefined> {
    const session = await this.getSession();
    if (session === undefined) {
      return undefined;
    }
    return { id: session.account.id, label: session.account.label };
  }

  /**
   * Prompt for sign-in. Returns undefined when the user cancels or no provider is available.
   * An existing session with the requested scopes is reused, so this doubles as a status check.
   */
  async signIn(): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, this.scopes, {
        createIfNone: true,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Sign out of the account VS Code currently prefers for this provider. The stable API has no
   * removeSession, so this invokes the same internal command the Accounts menu uses, then verifies
   * that the session is gone.
   */
  async signOut(): Promise<boolean> {
    const identity = await this.getIdentity();
    if (identity === undefined) {
      return true;
    }
    try {
      await vscode.commands.executeCommand('_signOutOfAccount', {
        providerId: GITHUB_AUTH_PROVIDER,
        accountLabel: identity.label,
      });
    } catch {
      return false;
    }
    const after = await this.getIdentity();
    return after === undefined || after.id !== identity.id;
  }

  /** Fires for GitHub sign-in, sign-out and token changes, but not for other providers. */
  onDidChangeSessions(listener: () => void): vscode.Disposable {
    return vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === GITHUB_AUTH_PROVIDER) {
        listener();
      }
    });
  }
}
