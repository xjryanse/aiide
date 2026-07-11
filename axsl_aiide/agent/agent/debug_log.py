"""进程内的 LLM API 调用日志(ring buffer,不落盘)。

记录每次发送给 OpenAI 兼容接口的 request(messages + tools)和收到的 response
(累积的 assistant text / tool_calls / usage),用于本地调试观察实际输入输出。

关键点:
- 内存 ring buffer,进程重启即清空;
- 每条记录都有独立 id,便于按需拉取详情;
- 大 content 不做截断,由前端渲染时自行处理(想看啥都能看到)。
"""
from __future__ import annotations

import copy
import itertools
import os
import time
from collections import deque
from threading import Lock
from typing import Any


_MAX_ENTRIES = int(os.getenv("AGENT_DEBUG_LOG_MAX", "50"))

_entries: deque[dict[str, Any]] = deque(maxlen=_MAX_ENTRIES)
_lock = Lock()
_id_seq = itertools.count(1)


def _now_ms() -> int:
    return int(time.time() * 1000)


def record_start(
    session_id: str | None,
    step: int,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    model: str | None,
) -> int:
    """在调 chat.completions 之前调用,返回 entry_id 供 record_finish 使用。"""
    entry_id = next(_id_seq)
    entry = {
        "id": entry_id,
        "session_id": session_id,
        "step": step,
        "model": model,
        "started_at": _now_ms(),
        "finished_at": None,
        "status": "running",
        # deepcopy 防止后续 messages 变动污染快照
        "request": {
            "messages": copy.deepcopy(messages),
            "tools": copy.deepcopy(tools) if tools else None,
        },
        "response": None,
        "error": None,
    }
    with _lock:
        _entries.append(entry)
    return entry_id


def record_finish(
    entry_id: int,
    *,
    assistant_text: str = "",
    tool_calls: list[dict[str, Any]] | None = None,
    usage: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    with _lock:
        for e in _entries:
            if e["id"] == entry_id:
                e["finished_at"] = _now_ms()
                e["status"] = "error" if error else "ok"
                e["error"] = error
                e["response"] = {
                    "assistant_text": assistant_text,
                    "tool_calls": tool_calls or [],
                    "usage": usage or {},
                }
                return


def list_entries() -> list[dict[str, Any]]:
    """返回摘要列表(不含完整 messages,减小传输)。"""
    with _lock:
        out = []
        for e in _entries:
            req = e.get("request") or {}
            msgs = req.get("messages") or []
            resp = e.get("response") or {}
            usage = resp.get("usage") or {}
            out.append({
                "id": e["id"],
                "session_id": e.get("session_id"),
                "step": e.get("step"),
                "model": e.get("model"),
                "status": e.get("status"),
                "started_at": e.get("started_at"),
                "finished_at": e.get("finished_at"),
                "duration_ms": (e["finished_at"] - e["started_at"]) if e.get("finished_at") else None,
                "msg_count": len(msgs),
                "tool_count": len(req.get("tools") or []),
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "cached_tokens": usage.get("cached_tokens") or usage.get("cached"),
                "assistant_preview": ((resp.get("assistant_text") or "")[:80]),
                "tool_calls_count": len(resp.get("tool_calls") or []),
                "error": e.get("error"),
            })
        # 新到旧
        out.reverse()
        return out


def get_entry(entry_id: int) -> dict[str, Any] | None:
    with _lock:
        for e in _entries:
            if e["id"] == entry_id:
                # 返回深拷贝防止外部修改
                return copy.deepcopy(e)
    return None


def clear() -> int:
    with _lock:
        n = len(_entries)
        _entries.clear()
        return n
