import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, streamChat } from './agentClient';
import { AgentProcess } from './agentProcess';

interface OutgoingMessage {
  type: 'send' | 'newSession' | 'ready' | 'openFile' | 'openDiff';
  [k: string]: any;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'axslAiide.chat';

  private view?: vscode.WebviewView;
  private currentAbort?: AbortController;
  private sessionId: string | null = null;
  private shellChannel: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentProcess,
    private readonly output: vscode.OutputChannel
  ) {
    this.shellChannel = vscode.window.createOutputChannel('axsl-aiide: Shell');
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: OutgoingMessage) => {
      this.handleMessage(msg).catch((e) => this.output.appendLine(`[panel error] ${e}`));
    });
  }

  public newSession(): void {
    this.sessionId = null;
    this.post({ type: 'sessionReset' });
  }

  public reveal(): void {
    this.view?.show?.(true);
  }

  private post(payload: any): void {
    this.view?.webview.postMessage(payload);
  }

  private async handleMessage(msg: OutgoingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.pushStatus();
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'send':
        await this.doSend(msg.text || '', msg.mode);
        break;
      case 'openFile':
        await this.openFile(msg.path);
        break;
      case 'openDiff':
        await this.openDiffFromWebview(msg.path, msg.oldContent, !!msg.isNewFile);
        break;
    }
  }

  private async pushStatus(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('axslAiide');
    const base = cfg.get<string>('agentBaseUrl') || 'http://127.0.0.1:8100';
    try {
      const info = await getConfig(base);
      this.post({ type: 'status', ok: true, info, base });
    } catch (e: any) {
      this.post({ type: 'status', ok: false, error: String(e?.message || e), base });
    }
  }

  private resolveWorkspace(): string | null {
    const cfg = vscode.workspace.getConfiguration('axslAiide');
    const override = (cfg.get<string>('workspaceOverride') || '').trim();
    if (override) return override;
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : null;
  }

  private async doSend(text: string, mode?: string): Promise<void> {
    text = text.trim();
    if (!text) return;

    // 归一化 mode
    const m = (mode || 'agent').toLowerCase();
    const chatMode: 'ask' | 'agent' | 'debug' =
      m === 'ask' || m === 'debug' ? m : 'agent';

    const cfg = vscode.workspace.getConfiguration('axslAiide');
    const base = cfg.get<string>('agentBaseUrl') || 'http://127.0.0.1:8100';

    try {
      await this.agent.ensureRunning(cfg, this.extensionUri.fsPath);
    } catch (e: any) {
      this.post({ type: 'assistantMsg', role: 'error', text: `Agent 未启动: ${e?.message || e}` });
      return;
    }

    const workspace = this.resolveWorkspace();
    if (!workspace) {
      this.post({
        type: 'assistantMsg',
        role: 'error',
        text: '当前 VSCode 没有打开工作区,请先打开一个文件夹再对话。',
      });
      return;
    }

    this.currentAbort?.abort();
    this.currentAbort = new AbortController();
    const controller = this.currentAbort;

    this.post({ type: 'userMsg', text, mode: chatMode });

    try {
      for await (const evt of streamChat(
        base,
        { session_id: this.sessionId, message: text, workspace, mode: chatMode },
        controller.signal
      )) {
        await this.dispatchEvent(evt.event, evt.data, workspace);
        if (controller.signal.aborted) break;
      }
    } catch (e: any) {
      this.post({ type: 'assistantMsg', role: 'error', text: `请求失败: ${e?.message || e}` });
    } finally {
      this.post({ type: 'turnEnd' });
    }
  }

  private async dispatchEvent(event: string, data: any, workspace: string): Promise<void> {
    switch (event) {
      case 'session':
        this.sessionId = data.session_id;
        this.post({ type: 'session', sessionId: this.sessionId });
        break;
      case 'workspace':
        this.post({ type: 'workspaceInfo', path: data.path });
        break;
      case 'assistant_delta':
        this.post({ type: 'assistantDelta', text: data.text || '' });
        break;
      case 'assistant_message':
        this.post({ type: 'assistantEnd' });
        break;
      case 'tool_call':
        this.post({ type: 'toolCall', name: data.name, args: data.arguments, id: data.id });
        break;
      case 'tool_result':
        this.post({ type: 'toolResult', name: data.name, result: data.result, id: data.id });
        await this.handleToolSideEffects(data.name, data.result, workspace);
        break;
      case 'error':
        this.post({
          type: 'assistantMsg',
          role: 'error',
          text: `[${data.where || 'agent'}] ${data.message || JSON.stringify(data)}`,
        });
        break;
      case 'done':
        this.post({ type: 'done', reason: data?.reason });
        break;
    }
  }

  private async handleToolSideEffects(name: string, result: any, workspace: string): Promise<void> {
    if (!result || result.ok === false) return;

    if ((name === 'write_file' || name === 'apply_patch') && result.path) {
      const realUri = vscode.Uri.file(path.join(workspace, result.path));
      // 若后端带回 old_content / new_content,使用原生 diff 视图对比
      const hasDiff = typeof result.old_content === 'string' && typeof result.new_content === 'string';
      if (hasDiff && !result.diff_too_large) {
        try {
          await this.showNativeDiff(result.path, result.old_content, realUri, !!result.is_new_file);
        } catch (e) {
          this.output.appendLine(`[diff] ${e}`);
          // 兜底:直接打开新文件
          try { await vscode.window.showTextDocument(realUri, { preview: true }); } catch { /* noop */ }
        }
      } else {
        // 没有 diff 内容(过大 / 旧格式) → 退回单文件预览
        try { await vscode.window.showTextDocument(realUri, { preview: true }); } catch { /* noop */ }
      }
      return;
    }

    if (name === 'run_shell') {
      const line = `\n$ ${result.command}\n[exit=${result.exit_code}] cwd=${result.cwd}\n`;
      this.shellChannel.append(line);
      if (result.stdout) this.shellChannel.append(result.stdout);
      if (result.stderr) this.shellChannel.append('\n[stderr]\n' + result.stderr);
      this.shellChannel.append('\n');
      if (!result.ok) this.shellChannel.show(true);
    }
  }

  /**
   * 用 VSCode 原生 diff 视图展示 write_file / apply_patch 的变更。
   * 左侧:修改前(把 old_content 写入临时文件),右侧:修改后(工作区里的真实文件)。
   */
  private async showNativeDiff(
    relPath: string,
    oldContent: string,
    newUri: vscode.Uri,
    isNewFile: boolean
  ): Promise<void> {
    // 把 old 内容写入扩展全局存储下的临时目录,保证 uri 稳定 + 每次覆盖
    // (使用 relPath 作为文件名的一部分,便于用户在标签页看到)
    const safeName = relPath.replace(/[\\\/:]/g, '_');
    const tmpDir = vscode.Uri.joinPath(this.extensionUri, '.diff-tmp');
    try { await vscode.workspace.fs.createDirectory(tmpDir); } catch { /* ignore */ }
    const oldUri = vscode.Uri.joinPath(tmpDir, `old__${Date.now()}__${safeName}`);
    await vscode.workspace.fs.writeFile(oldUri, Buffer.from(oldContent, 'utf-8'));

    const title = isNewFile
      ? `${relPath} (新增文件)`
      : `${relPath} (修改前 ↔ 修改后)`;
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, {
      preview: true,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private async openFile(rel: string): Promise<void> {
    const workspace = this.resolveWorkspace();
    if (!workspace || !rel) return;
    try {
      const uri = vscode.Uri.file(path.join(workspace, rel));
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch (e) {
      this.output.appendLine(`[openFile] ${e}`);
    }
  }

  /** 处理 webview 里"打开对比视图"按钮的点击 */
  private async openDiffFromWebview(rel: string, oldContent: string, isNewFile: boolean): Promise<void> {
    const workspace = this.resolveWorkspace();
    if (!workspace || !rel || typeof oldContent !== 'string') return;
    const newUri = vscode.Uri.file(path.join(workspace, rel));
    try {
      await this.showNativeDiff(rel, oldContent, newUri, isNewFile);
    } catch (e) {
      this.output.appendLine(`[openDiff] ${e}`);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src *`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>axsl-aiide</title>
</head>
<body>
  <div id="status" class="status">正在连接 Agent…</div>
  <div id="mode-bar" class="mode-bar" role="tablist" aria-label="对话模式">
    <button type="button" class="mode-btn" data-mode="ask" role="tab" aria-selected="false" title="只做问答,不修改任何文件">
      <span class="mode-ico">💬</span><span class="mode-label">Ask</span>
    </button>
    <button type="button" class="mode-btn is-active" data-mode="agent" role="tab" aria-selected="true" title="智能修改:允许调用全部工具">
      <span class="mode-ico">🤖</span><span class="mode-label">Agent</span>
    </button>
    <button type="button" class="mode-btn" data-mode="debug" role="tab" aria-selected="false" title="修复 Bug 专用:定位根因 + 最小改动 + 验证">
      <span class="mode-ico">🐞</span><span class="mode-label">Debug</span>
    </button>
  </div>
  <div id="chat" class="chat"></div>
  <footer class="composer">
    <textarea id="input" rows="3" placeholder="告诉 Agent 你想让它做什么 (Ctrl+Enter 发送)"></textarea>
    <div class="row">
      <button id="btn-new" class="secondary">新会话</button>
      <button id="btn-send" class="primary">发送</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.currentAbort?.abort();
    this.shellChannel.dispose();
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
