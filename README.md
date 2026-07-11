# axsl-aiide

轻量编程 Agent。PHP 前端 + Python(FastAPI)Agent 内核 + OpenAI 兼容 LLM,可自主读写文件、执行 shell 命令、看错误自动修复。

## 📸 界面预览

<!--
  截图请放到 docs/images/ 目录下,文件名保持一致即可自动生效。
  命名与体积建议见 docs/images/README.md。
-->

<p align="center">
  <img src="docs/images/main-ui.png" alt="axsl-aiide 主界面" width="820" />
</p>

<!-- 如果准备了浅色/深色两套截图,可以启用下面这段,GitHub 会根据用户主题自动切换:
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="docs/images/main-ui-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/main-ui.png">
    <img alt="axsl-aiide 主界面" src="docs/images/main-ui.png" width="820">
  </picture>
</p>
-->

| 计划面板 | 演示动图 |
| :---: | :---: |
| <img src="docs/images/plan-panel.png" alt="计划面板" width="400" /> | <img src="docs/images/demo.gif" alt="演示动图" width="400" /> |

## 运行环境要求

本项目由三部分组成,按你实际用到的入口安装对应环境即可(**Agent 服务是核心,必装**;PHP 和 VSCode 扩展二选一或都装)。

### 一、必装:Python Agent 服务(`agent/`)

| 组件 | 版本要求 | 说明 |
| --- | --- | --- |
| **Python** | **3.10 +**(推荐 3.10 ~ 3.12) | 需加入系统 PATH。启动脚本会自动 `python -m venv .venv` 建虚拟环境 |
| **pip** | 随 Python 附带 | 首次启动会自动升级并安装依赖 |
| **网络** | 可访问 LLM 接口 | OpenAI / DeepSeek / 通义千问 / 本地 Ollama 任选其一 |
| **磁盘** | ≥ 2 GB 空闲 | `sentence-transformers` + `chromadb` 会下载嵌入模型(首次约 400 MB) |

Python 依赖(自动安装,见 `agent/requirements.txt`):

```text
fastapi>=0.110.0
uvicorn[standard]>=0.27.0
openai>=1.30.0
python-dotenv>=1.0.0
pydantic>=2.6.0
aiosqlite>=0.19.0
chromadb>=0.4.24
sentence-transformers>=2.5.0
```

> ⚠️ **Windows 注意**:`sentence-transformers` 依赖 PyTorch,首次安装耗时较长(约 2~5 分钟,视网速)。如需 GPU 加速,自行安装对应 CUDA 版 torch。

### 二、可选入口 A:PHP Web UI(`public/`)

| 组件 | 版本要求 | 说明 |
| --- | --- | --- |
| **PHP** | **7.4 +**(推荐 8.0 ~ 8.2) | 通过 phpStudy / XAMPP / 独立 PHP 均可 |
| **PHP 扩展** | `curl` 必开 | 用于流式转发到 Agent 服务(`public/api/stream.php`) |
| **Web 服务器** | Nginx 或 Apache | phpStudy 默认已带,把站点根指向 `public/` |

### 三、可选入口 B:VSCode / Cursor 扩展(`extension/`)

| 组件 | 版本要求 | 说明 |
| --- | --- | --- |
| **VSCode** | **1.85 +** | 或 Cursor 等兼容 VSCode API 的编辑器 |
| **Node.js** | **18 +** | 仅开发/打包扩展时需要;安装后使用无需 Node |
| **npm** | 随 Node 附带 | 用于 `npm install` 和 `npm run package` |

扩展开发依赖(见 `extension/package.json`):

```text
typescript ^5.3.0
esbuild    ^0.20.0
@types/vscode ^1.85.0
@types/node   ^20.10.0
```

### 四、操作系统

- **Windows 10 / 11**:一等公民,`scripts/*.bat` 和 `*.ps1` 开箱即用
- **macOS / Linux**:使用 `scripts/start-agent.sh`;PHP 部分需自行搭建 Nginx + PHP-FPM

### 五、LLM API Key

至少准备一份 **OpenAI 兼容** 的 API Key,填入 `agent/.env`:

| 提供商 | BASE_URL | 备注 |
| --- | --- | --- |
| OpenAI 官方 | `https://api.openai.com/v1` | 需海外网络 |
| DeepSeek | `https://api.deepseek.com/v1` | 推荐,便宜好用 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 国内直连 |
| Ollama(本地) | `http://127.0.0.1:11434/v1` | 完全离线,API Key 随便填 |

### 六、端口占用

| 端口 | 用途 | 可否修改 |
| --- | --- | --- |
| `8100` | Agent FastAPI 服务 | 可,改 `agent/.env` 的 `AGENT_PORT` |
| `80` / `443` | PHP Web 站点 | 由 Web 服务器决定 |

## 目录结构

```text
axsl_aiide/
├── public/              PHP Web UI(浏览器入口,phpStudy 站点根)
├── extension/           VSCode / Cursor 扩展(推荐入口,详见 extension/README.md)
├── agent/               Python Agent 服务(FastAPI + ReAct 循环)
├── workspace/           默认沙箱(Web UI 用);扩展则用 VSCode 当前工作区
├── storage/             SQLite 会话数据库
├── config/              PHP 端配置
└── scripts/             Windows 启动脚本
```

**两种入口任选其一,或同时使用**:
- **VSCode 扩展**(推荐):在 `extension/` 目录按 F5 调试,或 `npm run package` 打包 .vsix 安装。参见 [`extension/README.md`](extension/README.md)。
- **浏览器 Web UI**:把 phpStudy 站点根指向 `public/`。

## 快速开始

### 1. 启动 Python Agent 服务

首次运行会自动建 venv、装依赖、并弹出记事本让你填 `OPENAI_API_KEY`。

```powershell
# PowerShell
.\scripts\start-agent.ps1
```
或
```bat
:: cmd
scripts\start-agent.bat
```

服务默认监听 `http://127.0.0.1:8100`。

### 2. 配置 phpStudy 站点

将站点根目录指向 `d:\phpstudy_pro\WWW\axsl_aiide\public`,启动 Nginx/Apache 后访问:

```
http://localhost/    (或你在 phpStudy 里绑定的域名)
```

### 3. 编辑 `agent/.env`

支持任意 OpenAI 兼容接口(改 `OPENAI_BASE_URL` 即可):

```env
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=deepseek-chat
```

## 架构说明

```text
浏览器 ── fetch(POST) ──▶ public/api/stream.php ── curl 流式转发 ──▶
FastAPI /v1/chat/stream ── ReAct 循环 ──▶ LLM (streaming)
                                     └── tool_calls ──▶ 工具执行器
                                              ├── list_dir / read_file / write_file / apply_patch(限沙箱)
                                              └── run_shell(cwd=workspace,60s 超时,黑名单过滤)
```

- 会话与消息持久化到 `storage/sessions.db`
- Agent 单次对话最多 20 步(可在 `.env` 里调 `AGENT_MAX_STEPS`)
- 所有文件路径必须落在 `workspace/` 内,越权自动拒绝

## 常用示例

在聊天框里直接说:
- "在 workspace 里用 Python 写一个 fibonacci.py,并跑一下验证前 10 项"
- "读一下 workspace/app.py,把里面的 print 全部改成 logging.info"
- "初始化一个最小 Flask 项目并启动它(后台不要阻塞)"

## 常见问题

**Q: 页面显示 "Agent 服务不可达"?**
A: 请先启动 `scripts\start-agent.bat`,确认 `http://127.0.0.1:8100/v1/health` 能访问。

**Q: PHP 报 `curl_init` 未定义?**
A: 在 phpStudy 里为当前 PHP 版本启用 `php_curl` 扩展。

**Q: 想接本地模型?**
A: 装 Ollama,启动 `ollama serve`,然后 `.env` 改成:
```env
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5-coder:7b
```

## 后续可扩展的方向

- [ ] `search_code`(ripgrep 语义搜索)
- [ ] Git 工具(diff / commit / branch)
- [ ] 多会话侧边栏切换
- [ ] 前端 diff 高亮显示 write_file / apply_patch 的改动
- [ ] 用户确认门槛:高危工具需要点确认才执行
- [ ] MCP 协议支持

## 冒烟测试

不需要 API Key,验证所有本地工具、沙箱、SQLite 是否正常:

```powershell
cd d:\phpstudy_pro\WWW\axsl_aiide\agent
.\.venv\Scripts\python.exe smoke_test.py
```

预期输出:`PASS - 所有离线冒烟测试通过`(10/10)。
