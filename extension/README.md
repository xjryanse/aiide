# axsl-aiide (VSCode / Cursor 扩展)

轻量编程 Agent 的 VSCode 侧边栏面板。启动时自动拉起同仓库的 Python Agent 后端(`../agent`),然后通过 SSE 与它对话。

## 开发调试(F5 运行)

```powershell
cd d:\phpstudy_pro\WWW\axsl_aiide\extension
npm install
```

然后在 **VSCode / Cursor** 里打开这个 `extension/` 目录,按 `F5`,会弹出一个"扩展宿主"窗口:

1. 在新窗口里 **打开任意一个项目文件夹**(这个文件夹就是 Agent 的沙箱工作区)
2. 侧边活动栏出现 `axsl-aiide` 图标,点开就是聊天面板
3. 首次会自动 spawn Python 后端;若 `agent/.venv` 不存在或未装依赖,请先运行:
   ```powershell
   cd d:\phpstudy_pro\WWW\axsl_aiide
   .\scripts\start-agent.ps1   # 让脚本帮你建 venv + 装依赖 + 填 .env
   ```
   之后可以关掉这个手动进程,交给扩展自动拉起。

## 配置项(Settings → axsl-aiide)

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `axslAiide.agentBaseUrl` | `http://127.0.0.1:8100` | Python Agent 服务地址 |
| `axslAiide.autoStartAgent` | `true` | 扩展激活时自动 spawn 本地 Python 进程 |
| `axslAiide.agentDir` | `""` | agent/ 目录绝对路径(留空则相对扩展目录 `../agent`) |
| `axslAiide.pythonPath` | `""` | Python 解释器(留空则用 `agent/.venv` 或系统 `python`) |
| `axslAiide.workspaceOverride` | `""` | 覆盖 Agent 沙箱路径(留空 = 当前打开的工作区) |

## 命令

- `axsl-aiide: 打开聊天面板`
- `axsl-aiide: 新建会话`
- `axsl-aiide: 重启 Agent 后端`

## 打包发布

```powershell
npm i -g @vscode/vsce
cd d:\phpstudy_pro\WWW\axsl_aiide\extension
npm run package    # 产出 axsl-aiide-0.1.0.vsix
```

然后在 VSCode/Cursor 里 `Extensions → ... → Install from VSIX...` 选择该文件即可。
