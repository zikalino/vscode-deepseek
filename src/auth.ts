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

  /** Show an input box to prompt the user for their API key (password-masked). */
  async promptForApiKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: 'DeepSeek API Key',
      prompt: 'Enter your DeepSeek API key (sk-...)',
      password: true,
      placeHolder: 'sk-...',
      validateInput: (value: string) => {
        if (!value || value.trim().length === 0) {
          return 'API key cannot be empty.';
        }
        return null;
      },
      ignoreFocusOut: true,
    });
    if (!key) return undefined;
    const trimmed = key.trim();
    await this.setApiKey(trimmed);
    return trimmed;
  }
}
