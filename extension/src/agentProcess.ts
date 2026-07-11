import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class AgentProcess {
  private proc: cp.ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private output: vscode.OutputChannel;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async ensureRunning(cfg: vscode.WorkspaceConfiguration, extensionPath: string): Promise<void> {
    if (!cfg.get<boolean>('autoStartAgent', true)) {
      return;
    }
    if (this.running) return;
    if (this.starting) return this.starting;

    this.starting = this._spawn(cfg, extensionPath)
      .catch((e) => {
        this.output.appendLine(`[启动失败] ${e}`);
        throw e;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private resolveAgentDir(cfg: vscode.WorkspaceConfiguration, extensionPath: string): string {
    const custom = (cfg.get<string>('agentDir') || '').trim();
    if (custom) return custom;
    return path.resolve(extensionPath, '..', 'agent');
  }

  private resolvePython(cfg: vscode.WorkspaceConfiguration, agentDir: string): string {
    const custom = (cfg.get<string>('pythonPath') || '').trim();
    if (custom) return custom;
    const venv = process.platform === 'win32'
      ? path.join(agentDir, '.venv', 'Scripts', 'python.exe')
      : path.join(agentDir, '.venv', 'bin', 'python');
    if (fs.existsSync(venv)) return venv;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private async _spawn(cfg: vscode.WorkspaceConfiguration, extensionPath: string): Promise<void> {
    const agentDir = this.resolveAgentDir(cfg, extensionPath);
    if (!fs.existsSync(path.join(agentDir, 'main.py'))) {
      throw new Error(`未找到 agent/main.py: ${agentDir}`);
    }
    const python = this.resolvePython(cfg, agentDir);
    this.output.appendLine(`[spawn] ${python} main.py  (cwd=${agentDir})`);

    const proc = cp.spawn(python, ['main.py'], {
      cwd: agentDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    this.proc = proc;

    proc.stdout?.on('data', (b) => this.output.append(b.toString()));
    proc.stderr?.on('data', (b) => this.output.append(b.toString()));
    proc.on('exit', (code, sig) => {
      this.output.appendLine(`[exit] code=${code} signal=${sig}`);
      this.proc = null;
    });

    const base = cfg.get<string>('agentBaseUrl') || 'http://127.0.0.1:8100';
    await this.waitReady(base, 20_000);
  }

  private async waitReady(base: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${base}/v1/health`);
        if (resp.ok) {
          this.output.appendLine(`[ready] agent @ ${base}`);
          return;
        }
      } catch {
        // 尚未就绪,继续等
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`Agent 启动 ${timeoutMs}ms 未就绪(${base})`);
  }

  async restart(cfg: vscode.WorkspaceConfiguration, extensionPath: string): Promise<void> {
    await this.stop();
    await this.ensureRunning(cfg, extensionPath);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try {
      if (process.platform === 'win32' && p.pid) {
        cp.exec(`taskkill /pid ${p.pid} /T /F`);
      } else {
        p.kill('SIGTERM');
      }
    } catch (e) {
      this.output.appendLine(`[stop error] ${e}`);
    }
  }

  dispose(): void {
    void this.stop();
  }
}
