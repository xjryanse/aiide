"""路径沙箱: 所有工具访问的路径必须落在 workspace 的某个 root 下。

多根设计:
- workspace 里定义 N 个 root(name -> abs_path);
- 工具收到的 path 参数应形如 "<root_name>/<rel>";
- 若 path 未带任何已知 root 名前缀,视为"落在 default_cwd 那个 root 上"的相对路径(向后兼容);
- 绝对路径 / 含 ".." 逃逸 会被 resolve_safe 校验拦截。

ContextVar 允许每个请求覆盖当前 workspace_id / 显式 roots 映射,
未覆盖时读取 storage/workspaces.json 里的 active workspace。
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path


# 当前请求覆盖用: (workspace_id, roots_map_or_None)
# roots_map 允许调用方直接注入(比如 CLI 显式传单目录),否则由 workspaces.py 解析。
_ctx_ws_id: ContextVar[str | None] = ContextVar("ws_id", default=None)
_ctx_roots: ContextVar[dict[str, Path] | None] = ContextVar("roots", default=None)


def _active_roots() -> dict[str, Path]:
    """返回当前生效的 {root_name: abs_path},顺序即 workspaces.json 中定义顺序。"""
    roots = _ctx_roots.get()
    if roots:
        return roots
    # 惰性引用,避免循环 import
    from ..workspaces import resolve_roots
    return resolve_roots(_ctx_ws_id.get())


def _default_root_path() -> Path:
    """default_cwd root 的绝对路径。"""
    roots = _ctx_roots.get()
    if roots:
        return next(iter(roots.values()))
    from ..workspaces import default_cwd
    return default_cwd(_ctx_ws_id.get())


# ---- 对外 API ----

def workspace_roots() -> dict[str, Path]:
    """所有 root 的 {name: abs_path}。"""
    return dict(_active_roots())


def workspace_root() -> Path:
    """兼容旧接口: 返回默认 cwd(第一个/被标 default_cwd 的 root)。"""
    return _default_root_path()


def split_root(path_str: str) -> tuple[str, str]:
    """把工具收到的 path 拆成 (root_name, relative)。

    规则:
    - 若第一段命中已知 root 名 => (root, rest)
    - 否则视为落在 default_cwd root 上,root 名 = default 的名字。
    """
    roots = _active_roots()
    if not path_str:
        # 空串: 视为 default root 的根
        default_name = _default_root_name()
        return default_name, ""
    s = str(path_str).replace("\\", "/").lstrip("/")
    parts = s.split("/", 1)
    head = parts[0]
    rest = parts[1] if len(parts) > 1 else ""
    if head in roots:
        return head, rest
    # 未命中 => 走默认 root,path 整体作为相对路径
    return _default_root_name(), s


def _default_root_name() -> str:
    roots = _active_roots()
    # 找 default_cwd 的名字
    default_abs = _default_root_path().resolve()
    for name, p in roots.items():
        if p.resolve() == default_abs:
            return name
    return next(iter(roots.keys()))


def resolve_safe(path_str: str) -> Path:
    """把 '<root>/rel' 或 'rel' 解析到绝对路径,并校验不越出对应 root。"""
    root_name, rel = split_root(path_str)
    roots = _active_roots()
    if root_name not in roots:
        raise PermissionError(f"unknown workspace root: {root_name}")
    base = roots[root_name].resolve()
    if not base.exists():
        base.mkdir(parents=True, exist_ok=True)
    # 显式绝对路径也当作相对处理(逃逸兜底)
    rel_norm = rel.lstrip("/\\") if rel else ""
    target = (base / rel_norm).resolve() if rel_norm else base
    try:
        target.relative_to(base)
    except ValueError:
        raise PermissionError(f"path escapes root '{root_name}': {path_str}")
    return target


def to_display(abs_path: Path) -> str:
    """把绝对路径转回 '<root>/rel' 形式(仅用于日志/回显)。"""
    ap = Path(abs_path).resolve()
    for name, root in _active_roots().items():
        try:
            rel = ap.relative_to(Path(root).resolve())
            rel_s = rel.as_posix()
            return f"{name}/{rel_s}" if rel_s else name
        except ValueError:
            continue
    return str(ap)


# 旧名字保留一段时间(别处仍在用 to_rel)
to_rel = to_display


# ---- ContextVar 管理 ----

@contextmanager
def use_workspace(target: str | os.PathLike | None = None, roots: dict[str, Path] | None = None):
    """在 async 上下文里覆盖当前 workspace。

    target 智能识别:
      - None => 使用 storage/workspaces.json 中的 active workspace;
      - 已知的 workspace_id (在 workspaces.json 中存在) => 按 id 切换;
      - 一个存在的目录路径 (绝对/相对) => 单 root 模式(兼容旧 API);
      - 其它字符串 => 当作 workspace_id 尝试 (若不存在则回落到 active)。
    roots: 显式注入 {name: Path},优先级最高。
    """
    ws_id: str | None = None
    inject_roots = roots
    if inject_roots is None and target:
        target_str = str(target)
        # 1) 先尝试当作 workspace_id
        try:
            from ..workspaces import load as _load_ws
            data = _load_ws()
            known_ids = {w["id"] for w in data.get("workspaces", [])}
        except Exception:
            known_ids = set()
        if target_str in known_ids:
            ws_id = target_str
        else:
            # 2) 当作目录路径(兼容旧调用)
            p = Path(target_str).expanduser()
            if p.exists() and p.is_dir():
                inject_roots = {"workspace": p.resolve()}
            else:
                # 3) 未匹配任何 -> 当 ws_id 处理(下游 fallback 到 active)
                ws_id = target_str

    t1 = _ctx_ws_id.set(ws_id)
    t2 = _ctx_roots.set(inject_roots)
    try:
        yield
    finally:
        _ctx_ws_id.reset(t1)
        _ctx_roots.reset(t2)


@contextmanager
def use_workspace_dir(path: str | os.PathLike):
    """兼容旧接口: 用单目录覆盖(等价于单 root 的 workspace)。"""
    p = Path(path).expanduser().resolve()
    with use_workspace(roots={"workspace": p}):
        yield
