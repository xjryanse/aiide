# axsl-aiide Linux 测试服部署手册

> 目标环境:Ubuntu 22.04 / Debian 12 / CentOS Stream 9 之类的现代 Linux
> 目标架构:同机部署 Nginx + php-fpm(Web)+ Uvicorn(Agent 127.0.0.1:8100)
>
> 如果是 CentOS 7 / Ubuntu 18 等老系统,注意 SQLite 版本 ≥ 3.35(chromadb 要求),
> 老版本请 `pip install pysqlite3-binary` 并在代码里注入替换。

---

## 0. 部署前必读:安全提醒

本项目允许 LLM **在服务器上执行任意 shell 命令**(`agent/tools/shell.py`),
并能读写 workspace 目录里的任意文件。因此:

1. **绝不能把 Agent(8100)或 Web(80)直接暴露到公网**,至少要加 basic auth 或 IP 白名单
2. **必须用独立系统账号**运行 Agent,不要用 root、也别复用 www-data
3. **API Key 一定要在服务器上重发一份**,不要沿用本地开发用的 key(见第 3 步)

---

## 1. 安装系统依赖

**Ubuntu / Debian**:
```bash
sudo apt update
sudo apt install -y \
    python3 python3-venv python3-pip \
    php8.1-cli php8.1-fpm php8.1-curl php8.1-mbstring \
    nginx git rsync lsof \
    build-essential
```

**CentOS / RHEL**(用 dnf 对应替换即可,略)。

设置时区(可选但建议):
```bash
sudo timedatectl set-timezone Asia/Shanghai
```

---

## 2. 创建独立系统账号 & 拉代码

```bash
# 建独立账号(不允许登录)
sudo useradd -r -m -d /opt/axsl_aiide -s /usr/sbin/nologin axsl

# 拉代码(或 rsync 上传)
sudo -u axsl git clone <你的仓库地址> /opt/axsl_aiide
# 或者从本地:  rsync -av --exclude '.venv' --exclude 'storage/sessions.db' \
#                       --exclude 'storage/vectors' \
#                       ./ user@server:/opt/axsl_aiide/

# 修正权限
sudo chown -R axsl:axsl /opt/axsl_aiide
sudo chmod -R 750 /opt/axsl_aiide
# 让 www-data(Nginx/php-fpm)能读 public/
sudo chmod 755 /opt/axsl_aiide
sudo chmod -R o+rX /opt/axsl_aiide/public
# storage 需要 php-fpm 写(比如 settings.json),做个补丁:
sudo usermod -aG axsl www-data
sudo chmod -R g+rwX /opt/axsl_aiide/storage /opt/axsl_aiide/workspace
```

---

## 3. **配置 API Key(重要,不要沿用本地 key)**

在**方舟控制台**(或对应 LLM 平台)**新建一条只给这台测试服用的 key**,然后:

```bash
sudo -u axsl cp /opt/axsl_aiide/agent/.env.example /opt/axsl_aiide/agent/.env
sudo -u axsl vi /opt/axsl_aiide/agent/.env
```

`.env` 里至少改这些:
```ini
# 新申请的 key,不要用本地那条
OPENAI_API_KEY=<新 key>
OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
OPENAI_MODEL=<你用的模型名>

# 监听地址(同机部署保持 127.0.0.1;分机部署改 0.0.0.0 且必须加防火墙)
AGENT_HOST=127.0.0.1
AGENT_PORT=8100

# CORS 白名单:默认 *,生产建议改成具体域名
AGENT_CORS_ORIGINS=http://test.example.com

# 可选:HuggingFace 镜像,服务器无外网时用
# HF_ENDPOINT=https://hf-mirror.com
```

收紧权限:
```bash
sudo chmod 600 /opt/axsl_aiide/agent/.env
sudo chmod 600 /opt/axsl_aiide/storage/settings.json 2>/dev/null || true
```

> **本地 `agent/.env` 里的 key 不受影响**,继续本地开发即可。
> 本次部署改造**没有动**你本地的 `.env` 文件。

---

## 4. 准备 Python 依赖

**推荐方式:先在本地锁一份版本,上传到服务器**。

本地执行(在你的 Windows 开发机上):
```powershell
cd D:\phpstudy_pro\WWW\axsl_aiide\agent
.\.venv\Scripts\activate
pip freeze > requirements.lock.txt
```
把 `agent/requirements.lock.txt` 一起上传。

服务器上:
```bash
cd /opt/axsl_aiide
sudo -u axsl bash scripts/start-agent.sh
# ↑ 第一次运行会自动创建 .venv 并安装依赖,然后启动 uvicorn
# 观察启动无报错后 Ctrl+C,后续用 systemd 托管
```

**如果服务器无外网**:先在本地 `pip download` 全部 wheel 打包上传,再 `pip install --no-index --find-links=./wheels -r requirements.lock.txt`。

---

## 5. embedding 模型准备(避免首次索引卡死)

`sentence-transformers` 首次使用会从 HuggingFace 拉几百 MB 模型。两种方案:

**方案 A:服务器有外网 + HF 镜像**
```bash
# 已经在 .env 里配了 HF_ENDPOINT=https://hf-mirror.com,直接启动即可
```

**方案 B:服务器无外网,离线上传**
```bash
# 本地:直接把整个 storage/models/ rsync 过去
rsync -av storage/models/ user@server:/opt/axsl_aiide/storage/models/
```

---

## 6. 清理本地测试数据(可选,推荐)

`storage/sessions.db` 是你的本地会话,不要带到测试服:
```bash
sudo -u axsl rm -f /opt/axsl_aiide/storage/sessions.db
# 首次访问 Agent 时 init_db() 会自动重建
```

向量索引同理,让用户在 Web UI 里点"重建索引"即可。

---

## 7. 用 systemd 托管 Agent

```bash
sudo cp /opt/axsl_aiide/deploy/axsl-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now axsl-agent
sudo systemctl status axsl-agent
sudo journalctl -u axsl-agent -f     # 实时日志,Ctrl+C 退出
```

验证 Agent:
```bash
curl http://127.0.0.1:8100/v1/health
# 应返回 JSON,含 profile 信息
```

---

## 8. 配置 Nginx + php-fpm

```bash
sudo cp /opt/axsl_aiide/deploy/nginx-axsl.conf /etc/nginx/sites-available/axsl
# 编辑 server_name 改成你自己的域名/IP
sudo vi /etc/nginx/sites-available/axsl
sudo ln -sf /etc/nginx/sites-available/axsl /etc/nginx/sites-enabled/axsl
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable --now php8.1-fpm
```

**强烈建议**加 basic auth(参考 `nginx-axsl.conf` 里的注释)。

---

## 9. 收尾验证

```bash
# 1. Agent 健康
curl http://127.0.0.1:8100/v1/health

# 2. Web 首页
curl -I http://test.example.com/

# 3. 打开浏览器,访问 http://test.example.com/
#    - 加载 UI
#    - 选择 workspace,点"重建索引"
#    - 发一句测试对话,看 SSE 是否流式返回(不是一次性吐出)
```

---

## 10. 日常运维

| 操作 | 命令 |
|---|---|
| 重启 Agent | `sudo systemctl restart axsl-agent` |
| 查看 Agent 日志 | `sudo journalctl -u axsl-agent -f` |
| 更新代码 | `sudo -u axsl git -C /opt/axsl_aiide pull && sudo systemctl restart axsl-agent` |
| 更新 Python 依赖 | 进 venv 后 `pip install -r requirements.lock.txt`,再重启 |
| 手动停 Agent | `sudo bash /opt/axsl_aiide/scripts/stop-agent.sh` |
| 清会话 | `sudo -u axsl rm /opt/axsl_aiide/storage/sessions.db && sudo systemctl restart axsl-agent` |

---

## 11. 常见问题排查

- **`curl 127.0.0.1:8100/v1/health` 连不上** → `journalctl -u axsl-agent -n 100` 看报错,通常是依赖装漏、`.env` 没配 key、或 SQLite 版本过低。
- **SSE 一次性输出 / 卡半天才出** → Nginx 侧 `fastcgi_buffering off`、`gzip off` 没生效,检查 `deploy/nginx-axsl.conf`。
- **索引时卡在 "downloading model"** → 服务器没外网/没配 `HF_ENDPOINT`,按第 5 步离线上传。
- **`Permission denied` 写 storage** → 第 2 步的 `usermod -aG axsl www-data` + `chmod g+rwX storage/` 漏了。
- **LLM 执行 shell 报 `command not found: source`** → 确认 `agent/tools/shell.py` 已经是新版(自动选 `/bin/bash`),或在 `.env` 里 `AGENT_SHELL_EXECUTABLE=/bin/bash` 强制指定。

---

## 附:本次为部署做的代码调整清单

| 文件 | 改动 | 兼容性 |
|---|---|---|
| `agent/tools/shell.py` | Linux 下自动选 `/bin/bash`,支持 `AGENT_SHELL_EXECUTABLE` 覆盖 | Windows 行为不变(executable=None → cmd.exe) |
| `agent/main.py` | CORS 支持从 `AGENT_CORS_ORIGINS` 读白名单 | 未设置该变量时默认 `*`,与旧版一致 |
| `scripts/start-agent.sh` `stop-agent.sh` `start-web.sh` | Linux 版启动/停止脚本 | 新增文件,不影响 Windows 的 `.bat` |
| `deploy/axsl-agent.service` | systemd unit | 新增 |
| `deploy/nginx-axsl.conf` | Nginx 站点模板 | 新增 |
| `deploy/README.md` | 本文档 | 新增 |
