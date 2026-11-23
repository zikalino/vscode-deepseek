import * as vscode from 'vscode';
import { SECRET_KEY, SETTINGS_NS } from './consts';
import { Logger } from './logger';

export class AuthManager {
  private secrets: vscode.SecretStorage;
  private log: Logger;
  private _onDidChangeApiKey = new vscode.EventEmitter<void>();
  readonly onDidChangeApiKey: vscode.Event<void> = this._onDidChangeApiKey.event;

  constructor(secrets: vscode.SecretStorage, log: Logger) {
    this.secrets = secrets;
    this.log = log;
  }

  /** Get the API key from SecretStorage (primary) or settings (fallback). */
  async getApiKey(): Promise<string | undefined> {
    const fromSecrets = await this.secrets.get(SECRET_KEY);
    if (fromSecrets && fromSecrets.length > 0) {
      return fromSecrets;
    }
    const fromSettings = vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('apiKey');
    if (fromSettings && fromSettings.length > 0) {
      return fromSettings;
    }
    return undefined;
  }

  /** Store API key in SecretStorage (never in settings). */
  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key);
    this._onDidChangeApiKey.fire();
    this.log.info('API key stored in SecretStorage.');
  }

  /** Remove API key from SecretStorage. */
  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this._onDidChangeApiKey.fire();
    this.log.info('API key removed from SecretStorage.');
  }

  /** Check if an API key is available (fast, no async). */
  hasApiKey(): boolean {
    // We can't synchronously check SecretStorage, so we check settings synchronously
    const fromSettings = vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('apiKey');
    return !!fromSettings;
  }

  /**
   * Show an input box to prompt the user for their API key (password-masked).
   *
   * An existing key is pre-filled so the dialog can be used to review or replace it rather than
   * retype it. Submitting an empty value clears the key: `''` is returned then, `undefined` when
   * the dialog was dismissed, and the stored key otherwise.
   */
  async promptForApiKey(): Promise<string | undefined> {
    const existing = await this.getApiKey();
    const key = await vscode.window.showInputBox({
      title: 'DeepSeek API Key',
      prompt: existing
        ? 'A key is already set. Edit it, or submit an empty value to clear it.'
        : 'Enter your DeepSeek API key (sk-...)',
      password: true,
      placeHolder: 'sk-...',
      value: existing ?? '',
      validateInput: (value: string) => {
        // With a key already stored, an empty value means "clear it", so only a first key is required.
        if (!value || value.trim().length === 0) {
          return existing === undefined ? 'API key cannot be empty.' : null;
        }
        return null;
      },
      ignoreFocusOut: true,
    });
    if (key === undefined) return undefined;
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      await this.deleteApiKey();
      return '';
    }
    await this.setApiKey(trimmed);
    return trimmed;
  }
}
