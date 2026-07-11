"""运行时设置(存储在 storage/settings.json)。

设计原则:
- 单一事实源: storage/settings.json;
- 每次调用 load_settings() 都会重读文件(便于运行时热切换模型);
- 环境变量 (.env / 系统环境) 作为兜底默认值,当 settings.json 没有对应字段时使用。

字段结构:
{
    "active_profile": "default",
    "profiles": [
        {
            "id": "default",
            "name": "DeepSeek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "sk-...",
            "model": "deepseek-chat"
        }
    ],
    "params": {
        "max_steps": 20,
        "shell_timeout": 60,
        "max_output_chars": 8000,
        "max_tokens": 0     # 0 或缺省表示不传, 让服务端用默认
    }
}
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _settings_path() -> Path:
    # storage 目录: 通过 STORAGE_DIR 环境变量或默认 ../storage
    base = os.getenv("STORAGE_DIR") or (Path(__file__).resolve().parents[2] / "storage")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p / "settings.json"


def _default_settings() -> dict[str, Any]:
    return {
        "active_profile": "default",
        "profiles": [
            {
                "id": "default",
                "name": "默认",
                "base_url": os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                "api_key": os.getenv("OPENAI_API_KEY", ""),
                "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            }
        ],
        "params": {
            "max_steps": int(os.getenv("AGENT_MAX_STEPS", "20") or 20),
            "shell_timeout": int(os.getenv("AGENT_SHELL_TIMEOUT", "60") or 60),
            "max_output_chars": int(os.getenv("AGENT_MAX_OUTPUT_CHARS", "8000") or 8000),
            "max_tokens": 0,
        },
    }


def load_settings() -> dict[str, Any]:
    """读取当前设置,不存在则返回默认值(不写盘)。"""
    p = _settings_path()
    if not p.exists():
        return _default_settings()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return _default_settings()
    # 补齐缺失字段(前向兼容)
    base = _default_settings()
    base.update({k: v for k, v in raw.items() if v is not None})
    # 合并 params
    params = dict(base.get("params") or {})
    params.update((raw.get("params") or {}))
    base["params"] = params
    # 保证至少一个 profile
    if not base.get("profiles"):
        base["profiles"] = _default_settings()["profiles"]
    return base


def save_settings(data: dict[str, Any]) -> dict[str, Any]:
    """校验并写入 settings.json,返回落盘后的完整对象。"""
    cur = load_settings()
    # 允许部分更新
    if "active_profile" in data:
        cur["active_profile"] = str(data["active_profile"])
    if "profiles" in data and isinstance(data["profiles"], list):
        # 去重 & 规范化
        seen: set[str] = set()
        cleaned = []
        for p in data["profiles"]:
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or p.get("name") or "").strip()
            if not pid or pid in seen:
                continue
            seen.add(pid)
            cleaned.append({
                "id": pid,
                "name": str(p.get("name") or pid),
                "base_url": str(p.get("base_url") or "").strip(),
                "api_key": str(p.get("api_key") or ""),
                "model": str(p.get("model") or "").strip(),
            })
        if cleaned:
            cur["profiles"] = cleaned
    if "params" in data and isinstance(data["params"], dict):
        params = dict(cur.get("params") or {})
        src = data["params"]
        for k in ("max_steps", "shell_timeout", "max_output_chars", "max_tokens"):
            if k in src:
                try:
                    params[k] = int(src[k] or 0)
                except Exception:
                    pass
        cur["params"] = params
    # active_profile 必须存在
    ids = {p["id"] for p in cur["profiles"]}
    if cur["active_profile"] not in ids:
        cur["active_profile"] = cur["profiles"][0]["id"]

    p = _settings_path()
    p.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
    return cur


def active_profile() -> dict[str, Any]:
    s = load_settings()
    aid = s.get("active_profile")
    for prof in s.get("profiles", []):
        if prof.get("id") == aid:
            return prof
    return s["profiles"][0]


def get_param(name: str, default: int = 0) -> int:
    s = load_settings()
    try:
        v = int((s.get("params") or {}).get(name, default) or 0)
    except Exception:
        v = default
    return v if v else default


def public_view() -> dict[str, Any]:
    """返回给前端的视图,把 api_key 打码。"""
    s = load_settings()
    profiles = []
    for p in s.get("profiles", []):
        pp = dict(p)
        key = pp.get("api_key") or ""
        if key:
            if len(key) <= 8:
                pp["api_key_masked"] = "*" * len(key)
            else:
                pp["api_key_masked"] = key[:4] + "*" * (len(key) - 8) + key[-4:]
        else:
            pp["api_key_masked"] = ""
        # 不返回明文 key
        pp.pop("api_key", None)
        profiles.append(pp)
    return {
        "active_profile": s.get("active_profile"),
        "profiles": profiles,
        "params": s.get("params") or {},
    }
