import * as vscode from 'vscode';

export class Logger {
  private channel: vscode.LogOutputChannel;

  constructor(name: string = 'DeepSeek') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  private formatArgs(...args: unknown[]): string {
    return args
      .map((arg) => {
        if (arg instanceof Error) {
          return arg.stack ?? arg.message;
        }
        if (typeof arg === 'object' && arg !== null) {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');
  }

  info(...args: unknown[]): void {
    this.channel.info(this.formatArgs(...args));
  }

  warn(...args: unknown[]): void {
    this.channel.warn(this.formatArgs(...args));
  }

  error(...args: unknown[]): void {
    this.channel.error(this.formatArgs(...args));
  }

  debug(...args: unknown[]): void {
    this.channel.debug(this.formatArgs(...args));
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
