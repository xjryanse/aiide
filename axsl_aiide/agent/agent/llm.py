"""LLM 客户端封装(OpenAI 兼容)。

支持通过 storage/settings.json 运行时切换模型档案。
每次 build_client / chat_stream 都会重新读取当前活动 profile,
从而实现"页面切换模型 -> 下一次对话即刻生效",无需重启服务。
"""
from __future__ import annotations

import os
from typing import Any

from openai import AsyncOpenAI

from .settings import active_profile, get_param


def _active() -> dict[str, Any]:
    """取当前档案,缺失字段用环境变量兜底。"""
    try:
        prof = active_profile()
    except Exception:
        prof = {}
    return {
        "api_key": prof.get("api_key") or os.getenv("OPENAI_API_KEY", ""),
        "base_url": prof.get("base_url") or os.getenv(
            "OPENAI_BASE_URL", "https://api.openai.com/v1"
        ),
        "model": prof.get("model") or os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
    }


def build_client() -> AsyncOpenAI:
    a = _active()
    return AsyncOpenAI(api_key=a["api_key"], base_url=a["base_url"])


def get_model() -> str:
    return _active()["model"]


async def chat_stream(
    client: AsyncOpenAI,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
):
    """流式调用 chat.completions。返回 async iterator of chunks。

    开启 include_usage 后,最后一个 chunk 的 .usage 会带上 token 统计。
    """
    kwargs: dict[str, Any] = {
        "model": get_model(),
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    # 允许在 settings.params.max_tokens 里配置单次回复 token 上限;0 表示不传
    max_tokens = get_param("max_tokens", 0)
    if max_tokens and max_tokens > 0:
        kwargs["max_tokens"] = int(max_tokens)
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    return await client.chat.completions.create(**kwargs)
