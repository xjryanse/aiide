import * as vscode from 'vscode';
import { AgentProcess } from './agentProcess';
import { ChatPanelProvider } from './panel';

let agent: AgentProcess | null = null;
let panel: ChatPanelProvider | null = null;
let output: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('axsl-aiide');
  context.subscriptions.push(output);
  output.appendLine(`[activate] axsl-aiide 扩展已激活  extensionPath=${context.extensionUri.fsPath}`);
  output.show(true);

  agent = new AgentProcess(output);
  context.subscriptions.push({ dispose: () => agent?.dispose() });

  panel = new ChatPanelProvider(context.extensionUri, agent, output);
  context.subscriptions.push({ dispose: () => panel?.dispose() });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  output.appendLine(`[activate] WebviewViewProvider(${ChatPanelProvider.viewType}) 已注册`);

  const cfg = vscode.workspace.getConfiguration('axslAiide');
  if (cfg.get<boolean>('autoStartAgent', true)) {
    output.appendLine('[activate] autoStartAgent=true, 尝试拉起 Python 后端…');
    agent
      .ensureRunning(cfg, context.extensionUri.fsPath)
      .catch((e) => output?.appendLine(`[activate] agent start failed: ${e}`));
  } else {
    output.appendLine('[activate] autoStartAgent=false, 跳过自动启动');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('axslAiide.openChat', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.axslAiide');
      panel?.reveal();
    }),
    vscode.commands.registerCommand('axslAiide.newSession', () => panel?.newSession()),
    vscode.commands.registerCommand('axslAiide.restartAgent', async () => {
      const conf = vscode.workspace.getConfiguration('axslAiide');
      try {
        await agent?.restart(conf, context.extensionUri.fsPath);
        vscode.window.showInformationMessage('axsl-aiide: Agent 已重启');
      } catch (e: any) {
        vscode.window.showErrorMessage(`axsl-aiide: 重启失败 ${e?.message || e}`);
      }
    })
  );
}

export function deactivate(): void {
  agent?.dispose();
}
