// Commands for the hosted token allowance: GitHub device-flow sign-in, sign-out, and a usage card.
//
// Signing in is optional. Without a session the extension keeps using the user's own DeepSeek key,
// so these commands only add the free/sponsor allowance — they never remove an existing path.

import * as vscode from 'vscode';

import { accountManager } from './account';

export function registerAccountCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  const account = accountManager(context);

  const signIn = vscode.commands.registerCommand('deepseek.account.signIn', async () => {
    if (account.clientId.length === 0) {
      const action = await vscode.window.showErrorMessage(
        'GitHub sign-in needs an OAuth app client id. Create one under GitHub Settings → ' +
          'Developer settings → OAuth Apps, enable "Device Flow", then set ' +
          '"deepseek.account.githubClientId".',
        'Open Settings',
      );
      if (action === 'Open Settings') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'deepseek.account.githubClientId',
        );
      }
      return;
    }

    try {
      const device = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitHub: requesting a sign-in code…' },
        () => account.startDeviceFlow(),
      );

      void vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));
      void vscode.window
        .showInformationMessage(
          `GitHub sign-in: enter code ${device.userCode} at ${device.verificationUri}`,
          'Copy Code',
        )
        .then((action) => {
          if (action === 'Copy Code') {
            void vscode.env.clipboard.writeText(device.userCode);
          }
        });

      const info = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `GitHub: waiting for authorization (code ${device.userCode})…`,
          cancellable: true,
        },
        (_progress, token) => account.finishDeviceFlow(device, () => token.isCancellationRequested),
      );

      void vscode.window.showInformationMessage(
        `Signed in as ${info.login} — ${tierLabel(info.tier)}. ` +
          `${formatNumber(info.quota.remaining)} of ${formatNumber(info.quota.limit)} tokens left.`,
      );
    } catch (error) {
      void vscode.window.showWarningMessage(`GitHub: ${errorMessage(error)}`);
    }
  });

  const signOut = vscode.commands.registerCommand('deepseek.account.signOut', async () => {
    const info = await account.getAccount();
    await account.signOut();
    void vscode.window.showInformationMessage(
      info === undefined
        ? 'GitHub: not signed in for the token allowance.'
        : `GitHub: signed out ${info.login}.`,
    );
  });

  const showUsage = vscode.commands.registerCommand('deepseek.account.showUsage', async () => {
    const info = await account.refreshUsage();
    if (info === undefined) {
      const action = await vscode.window.showInformationMessage(
        'Not signed in. Sign in with GitHub to get the free monthly token allowance.',
        'Sign In',
      );
      if (action === 'Sign In') {
        await vscode.commands.executeCommand('deepseek.account.signIn');
      }
      return;
    }
    const resets = info.quota.resetsAt.length > 0 ? new Date(info.quota.resetsAt) : undefined;
    const resetText =
      resets === undefined || Number.isNaN(resets.getTime())
        ? ''
        : ` Resets ${resets.toLocaleDateString()}.`;
    void vscode.window.showInformationMessage(
      `${info.login} — ${tierLabel(info.tier)}: ` +
        `${formatNumber(info.quota.used)} of ${formatNumber(info.quota.limit)} tokens used ` +
        `(${formatNumber(info.quota.remaining)} left).${resetText}`,
    );
  });

  return [signIn, signOut, showUsage];
}

function tierLabel(tier: 'free' | 'sponsor'): string {
  return tier === 'sponsor' ? 'Sponsor allowance' : 'Free allowance';
}

function formatNumber(value: number): string {
  return Math.max(0, value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
