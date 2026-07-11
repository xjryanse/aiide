"""Shell 工具:在 workspace 内执行命令,带超时、输出截断、危险命令黑名单。"""
from __future__ import annotations

import asyncio
import os
import re

from .sandbox import workspace_root


def _default_timeout() -> int:
    """每次调用重新读取,支持通过设置页面热更新。"""
    try:
        from ..settings import get_param
        v = get_param("shell_timeout", int(os.getenv("AGENT_SHELL_TIMEOUT", "60") or 60))
    except Exception:
        v = int(os.getenv("AGENT_SHELL_TIMEOUT", "60") or 60)
    return v or 60


def _max_output() -> int:
    try:
        from ..settings import get_param
        v = get_param("max_output_chars", int(os.getenv("AGENT_MAX_OUTPUT_CHARS", "8000") or 8000))
    except Exception:
        v = int(os.getenv("AGENT_MAX_OUTPUT_CHARS", "8000") or 8000)
    return v or 8000

# 简单粗暴的黑名单;不追求完备,只挡明显破坏性命令
_DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\s+/",
    r"\bmkfs\b",
    r"\bformat\s+[a-zA-Z]:",
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bdel\s+/[sf]\s+/q\s+[a-zA-Z]:\\",
    r"reg\s+delete",
    r"\bdiskpart\b",
    r":\(\)\s*\{\s*:\|:&\s*\};:",  # fork bomb
]


def _is_dangerous(cmd: str) -> str | None:
    for pat in _DANGEROUS_PATTERNS:
        if re.search(pat, cmd, flags=re.IGNORECASE):
            return pat
    return None


def _truncate(s: str) -> tuple[str, bool]:
    max_output = _max_output()
    if len(s) <= max_output:
        return s, False
    head = s[: max_output // 2]
    tail = s[-max_output // 2 :]
    return head + f"\n\n... [已截断 {len(s) - max_output} 字符] ...\n\n" + tail, True


async def run_shell(command: str, timeout: int | None = None) -> dict:
    """在 workspace 目录内执行 shell 命令。

    支持 `cd <root_name>[/子目录] && <cmd>` 语法:
    - 会把 cwd 切到对应 root 的绝对路径下(仍受沙箱限制,不允许逃出);
    - 其余命令原样交给系统 shell,支持 && / || / ; 等复合语法。
    未显式 cd 时,cwd = 当前 workspace 的 default_cwd root。
    """
    if not command or not command.strip():
        return {"ok": False, "error": "空命令"}

    hit = _is_dangerous(command)
    if hit:
        return {"ok": False, "error": f"命令被安全策略拒绝(匹配规则: {hit})"}

    cwd, real_cmd = _extract_cwd(str(command))
    to = int(timeout or _default_timeout())

    # 平台相关的 shell 选择:
    #   Windows: 走系统默认(cmd.exe),兼容 .bat / dir / type 等
    #   Linux/macOS: 显式指定 /bin/bash,兼容 source / [[ ]] / 数组等 bash-only 语法;
    #     若系统没有 bash 则回退到 /bin/sh(POSIX 默认)。
    #   可通过环境变量 AGENT_SHELL_EXECUTABLE 强制覆盖。
    _shell_exec: str | None = os.getenv("AGENT_SHELL_EXECUTABLE") or None
    if _shell_exec is None and os.name != "nt":
        for _cand in ("/bin/bash", "/usr/bin/bash", "/bin/sh"):
            if os.path.exists(_cand):
                _shell_exec = _cand
                break

    try:
        proc = await asyncio.create_subprocess_shell(
            real_cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            executable=_shell_exec,  # Windows 上为 None → 走默认 cmd.exe,行为不变
        )
    except Exception as e:
        return {"ok": False, "error": f"启动进程失败: {e}"}

    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=to)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.communicate(), timeout=2)
        except Exception:
            pass
        return {
            "ok": False,
            "error": f"命令超时(>{to}s)已被强制终止",
            "command": command,
        }

    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")
    stdout, out_trunc = _truncate(stdout)
    stderr, err_trunc = _truncate(stderr)

    return {
        "ok": proc.returncode == 0,
        "command": command,
        "cwd": cwd,
        "exit_code": proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_truncated": out_trunc,
        "stderr_truncated": err_trunc,
    }


def _extract_cwd(command: str) -> tuple[str, str]:
    """识别形如 `cd <root>[/子目录] && rest` 的前缀,返回 (cwd_abs, real_command)。

    - 若匹配失败或路径越权,原样命令 + default_cwd 兜底。
    - 只识别一次前缀 cd;后续 cd 交给 shell 自己解析(但因不是子进程 chdir 而是 shell 内部,
      我们不会追踪它,仅初始 cwd 由这里决定)。
    """
    from .sandbox import workspace_roots, resolve_safe
    import re as _re
    m = _re.match(r"^\s*cd\s+([^\s&|;]+)\s*(?:&&|;)\s*(.+)$", command, _re.DOTALL)
    default_cwd = str(workspace_root())
    if not m:
        return default_cwd, command
    target = m.group(1).strip().strip("'\"")
    rest = m.group(2)
    # 只处理"看起来像 root 前缀"的目标,避免误吃 `cd ../xxx` 这类
    head = target.replace("\\", "/").split("/", 1)[0]
    if head not in workspace_roots():
        return default_cwd, command
    try:
        abs_target = resolve_safe(target)
    except PermissionError:
        return default_cwd, command
    if not abs_target.exists() or not abs_target.is_dir():
        return default_cwd, command
    return str(abs_target), rest
