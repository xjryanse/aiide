"""多根工作区管理 (存储在 storage/workspaces.json)。

数据模型:
{
  "active_id": "ws_xxx",
  "workspaces": [
    {
      "id": "ws_xxx",
      "name": "订单全链路",
      "roots": [
        {"name": "gateway", "path": "D:/proj/gw",  "default_cwd": true},
        {"name": "order",   "path": "D:/proj/svc-order"}
      ]
    }
  ]
}

约定:
- root.name 必须是合法标识符([A-Za-z0-9_.-]+),不能包含分隔符,避免与相对路径冲突。
- 每个 workspace 至少 1 个 root。
- default_cwd 只能有一个;若都没标,取第一个。
- 老的环境变量 WORKSPACE_DIR 作为"未配置任何 workspace 时"的兜底默认 workspace(单 root)。
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any


_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _storage_dir() -> Path:
    base = os.getenv("STORAGE_DIR") or (Path(__file__).resolve().parents[2] / "storage")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _file() -> Path:
    return _storage_dir() / "workspaces.json"


def _default_root_from_env() -> dict[str, Any]:
    """把环境变量 WORKSPACE_DIR 包装成一个默认 root。"""
    raw = os.getenv("WORKSPACE_DIR") or str(
        Path(__file__).resolve().parents[2] / "workspace"
    )
    p = Path(raw).resolve()
    return {"name": "workspace", "path": str(p), "default_cwd": True}


def _default_data() -> dict[str, Any]:
    root = _default_root_from_env()
    ws_id = "ws_default"
    return {
        "active_id": ws_id,
        "workspaces": [
            {
                "id": ws_id,
                "name": "默认工作区",
                "roots": [root],
            }
        ],
    }


def load() -> dict[str, Any]:
    f = _file()
    if not f.exists():
        return _default_data()
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return _default_data()
    if not raw.get("workspaces"):
        return _default_data()
    # 补 active_id
    ids = [w.get("id") for w in raw["workspaces"] if w.get("id")]
    if raw.get("active_id") not in ids:
        raw["active_id"] = ids[0]
    return raw


def _normalize_root(r: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(r, dict):
        return None
    name = str(r.get("name") or "").strip()
    path = str(r.get("path") or "").strip()
    if not name or not path:
        return None
    if not _NAME_RE.match(name):
        return None
    try:
        abs_path = str(Path(path).expanduser().resolve())
    except Exception:
        return None
    out = {"name": name, "path": abs_path}
    if r.get("default_cwd"):
        out["default_cwd"] = True
    return out


def _normalize_workspace(w: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(w, dict):
        return None
    wid = str(w.get("id") or "").strip() or ("ws_" + uuid.uuid4().hex[:10])
    name = str(w.get("name") or "").strip() or wid
    roots_in = w.get("roots") or []
    if not isinstance(roots_in, list):
        return None
    roots: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for r in roots_in:
        rr = _normalize_root(r)
        if not rr:
            continue
        if rr["name"] in seen_names:
            continue
        seen_names.add(rr["name"])
        roots.append(rr)
    if not roots:
        return None
    # default_cwd 只保留一个
    picked = False
    for r in roots:
        if r.get("default_cwd") and not picked:
            picked = True
        else:
            r.pop("default_cwd", None)
    if not picked:
        roots[0]["default_cwd"] = True
    return {"id": wid, "name": name, "roots": roots}


def save(data: dict[str, Any]) -> dict[str, Any]:
    """整体覆盖式写入。会做校验/规范化。"""
    cur = load()
    incoming_list = data.get("workspaces")
    if isinstance(incoming_list, list):
        cleaned: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for w in incoming_list:
            ww = _normalize_workspace(w)
            if not ww:
                continue
            if ww["id"] in seen_ids:
                ww["id"] = "ws_" + uuid.uuid4().hex[:10]
            seen_ids.add(ww["id"])
            cleaned.append(ww)
        if cleaned:
            cur["workspaces"] = cleaned
    if "active_id" in data:
        cur["active_id"] = str(data["active_id"])
    ids = [w["id"] for w in cur["workspaces"]]
    if cur.get("active_id") not in ids:
        cur["active_id"] = ids[0]
    _file().write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
    return cur


def active_workspace() -> dict[str, Any]:
    data = load()
    aid = data["active_id"]
    for w in data["workspaces"]:
        if w["id"] == aid:
            return w
    return data["workspaces"][0]


def get_workspace(ws_id: str | None) -> dict[str, Any]:
    if not ws_id:
        return active_workspace()
    data = load()
    for w in data["workspaces"]:
        if w["id"] == ws_id:
            return w
    return active_workspace()


def resolve_roots(ws_id: str | None = None) -> dict[str, Path]:
    """返回 {root_name: absolute_Path},保持顺序(用 dict 3.7+ 保序)。"""
    w = get_workspace(ws_id)
    return {r["name"]: Path(r["path"]) for r in w["roots"]}


def default_cwd(ws_id: str | None = None) -> Path:
    w = get_workspace(ws_id)
    for r in w["roots"]:
        if r.get("default_cwd"):
            return Path(r["path"])
    return Path(w["roots"][0]["path"])
