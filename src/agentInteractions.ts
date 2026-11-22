import * as vscode from 'vscode';

export async function sendMessageToAgent(text: string): Promise<void> {
  if (!text) {
    await vscode.commands.executeCommand('workbench.action.chat.open');
    vscode.window.showInformationMessage('Open DeepSeek chat and paste your prompt content.');
    return;
  }
  await vscode.commands.executeCommand('workbench.action.chat.open');
  await vscode.commands.executeCommand('deepseek.api.addRequestText', text);
  vscode.window.showInformationMessage('Prompt content added to DeepSeek chat.');
}
