"""Agent 核心:ReAct 主循环 + SSE 流式事件生产。"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncGenerator

from openai import AsyncOpenAI

from .llm import chat_stream
from .prompts import build_system_message
from .tools import TOOL_SCHEMAS, dispatch
from . import debug_log


# ---- 历史压缩:让"较早"的大块 tool_result 变成摘要,省 token ----
KEEP_RECENT_TOOL_RESULTS = int(os.getenv("AGENT_KEEP_RECENT_TOOL_RESULTS", "3"))
COMPRESS_ABOVE_CHARS = int(os.getenv("AGENT_COMPRESS_ABOVE_CHARS", "800"))


def _summarize_tool_result(name: str, raw: str) -> str:
    """把一个大的 tool_result JSON 字符串压成一行摘要。"""
    try:
        obj = json.loads(raw)
    except Exception:
        # 非 JSON,截前 200 字符
        return f"[{name}] {raw[:200]}..."

    ok = obj.get("ok")
    parts: list[str] = [f"[{name}] ok={ok}"]
    if isinstance(obj, dict):
        for k in ("path", "start_line", "end_line", "total_lines", "size",
                  "bytes_written", "replaced", "exit_code",
                  "range_truncated", "byte_truncated", "truncated",
                  "hits", "count", "empty_index", "error"):
            if k in obj:
                v = obj[k]
                if k == "hits" and isinstance(v, list):
                    parts.append(f"hits={len(v)}")
                    # 只保留 hit 的 file+line
                    briefs = []
                    for h in v[:5]:
                        if isinstance(h, dict):
                            briefs.append(f"{h.get('file')}:{h.get('start_line')}-{h.get('end_line')}")
                    if briefs:
                        parts.append("files=" + ",".join(briefs))
                elif isinstance(v, str) and len(v) > 80:
                    parts.append(f"{k}={v[:80]}...")
                else:
                    parts.append(f"{k}={v}")
    return "; ".join(parts) + "  (原始结果已省略以节省 token)"


def _compress_history(messages: list[dict[str, Any]]) -> int:
    """把较早的大块 tool 消息**原地**替换为摘要。保留最近 KEEP_RECENT_TOOL_RESULTS 条完整。

    关键点(为了让 Anthropic / DeepSeek 的 prompt caching 前缀稳定):
    - **原地修改** messages,一旦某条被压成摘要,后续步骤看到的仍是同一摘要,前缀 token 不再抖动;
    - 已是短摘要(len < COMPRESS_ABOVE_CHARS)的消息会自动跳过,天然形成"阶梯冷冻"。
    - messages 是外层 list(history) 的浅拷贝,原地重绑槽位不影响外部 history 的落库全量。

    返回:本次新压缩的条数(0 表示没有变化,调用方可据此决定是否发 SSE 通知)。
    """
    # 收集所有 role=tool 的下标
    tool_idxs = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    if len(tool_idxs) <= KEEP_RECENT_TOOL_RESULTS:
        return 0

    keep_from = tool_idxs[-KEEP_RECENT_TOOL_RESULTS]
    compressed = 0
    for i in tool_idxs:
        if i >= keep_from:
            break
        m = messages[i]
        content = m.get("content") or ""
        # 已被压过(短摘要)或本来就短,直接跳过——这就是"冷冻"效果的来源
        if not isinstance(content, str) or len(content) < COMPRESS_ABOVE_CHARS:
            continue
        name = m.get("name") or "tool"
        summary = _summarize_tool_result(name, content)
        messages[i] = {**m, "content": summary}
        compressed += 1
    return compressed


def _sse(event: str, data: Any) -> str:
    """格式化一条 SSE。"""
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _init_history(history: list[dict[str, Any]], mode: str = "agent") -> list[dict[str, Any]]:
    if history and history[0].get("role") == "system":
        # 已有 system 消息:替换为按当前 mode 生成的最新版本,保证模式切换即时生效
        return [build_system_message(mode), *history[1:]]
    return [build_system_message(mode), *history]


# 各模式允许调用的工具白名单。ask 只允许只读工具;agent/debug 允许全部工具。
_ASK_ALLOWED_TOOLS = {"search_code", "list_dir", "read_file"}


# ---- 循环护栏(死循环检测)阈值 ----
# 连续 N 步都满足"assistant_text 为空 + 工具调用签名完全相同" → 判定为沉默循环,中止
_LOOP_GUARD_STREAK = 3
# 同一路径被 read_file 调用达到 M 次时,在返回给 LLM 的结果里注入强警告
_READFILE_WARN_AT = 4


def _tool_signature(tc: dict[str, Any]) -> str:
    """把一次 tool_call 归纳为可比较的签名。相同签名 = 几乎相同的调用。"""
    fn = tc.get("function") or {}
    name = fn.get("name") or ""
    args_raw = fn.get("arguments") or "{}"
    try:
        args = json.loads(args_raw)
    except Exception:
        args = {}
    if name == "read_file":
        return f"read_file:{args.get('path', '')}"
    if name == "run_shell":
        return f"run_shell:{(args.get('command') or '')[:80]}"
    if name == "list_dir":
        return f"list_dir:{args.get('path', '')}"
    if name == "search_code":
        return f"search_code:{(args.get('query') or '')[:80]}"
    if name in ("write_file", "apply_patch"):
        return f"{name}:{args.get('path', '')}"
    return name


def _tools_for_mode(mode: str) -> list[dict[str, Any]]:
    if mode == "ask":
        return [t for t in TOOL_SCHEMAS if t.get("function", {}).get("name") in _ASK_ALLOWED_TOOLS]
    return TOOL_SCHEMAS


async def run_agent(
    client: AsyncOpenAI,
    history: list[dict[str, Any]],
    user_message: str,
    max_steps: int | None = None,
    cancel_event: asyncio.Event | None = None,
    images: list[str] | None = None,
    session_id: str | None = None,
    mode: str = "agent",
) -> AsyncGenerator[tuple[str, list[dict[str, Any]]], None]:
    """
    执行一次 Agent 循环。

    yield 出:(sse_text, new_messages_to_persist)
    第二个元素只在有新消息落库时才非空;调用方持续累加即可。

    传入 cancel_event 后,如果被 set,本循环会在下一个安全点尽早退出。
    传入 images(data URL 列表)时,构造多模态 content。
    传入 mode(ask/agent/debug):
      - ask   : 只允许 search_code/list_dir/read_file,系统 Prompt 强调只读问答;
      - agent : 允许全部工具,默认行为;
      - debug : 允许全部工具,系统 Prompt 聚焦 bug 定位与最小改动。
    """
    # 归一化 mode
    mode = (mode or "agent").strip().lower()
    if mode not in ("ask", "agent", "debug"):
        mode = "agent"

    # 优先级: 显式入参 > settings.json > 环境变量 > 12
    # (默认 12 步:正常任务够用,遇到"沉默循环"也能早止损)
    if max_steps:
        steps = int(max_steps)
    else:
        try:
            from .settings import get_param
            steps = get_param("max_steps", int(os.getenv("AGENT_MAX_STEPS", "12") or 12))
        except Exception:
            steps = int(os.getenv("AGENT_MAX_STEPS", "12") or 12)
    messages = _init_history(list(history), mode)
    active_tools = _tools_for_mode(mode)

    # ---- 死循环护栏状态 ----
    last_signatures: tuple[str, ...] | None = None   # 上一步的工具调用签名集合
    silent_streak = 0                                # 连续"assistant_text 空 + 签名相同"的步数
    readfile_path_count: dict[str, int] = {}         # 每个 path 被 read_file 的累计次数

    # 构造 user 消息:纯文本或多模态数组
    if images:
        parts: list[dict[str, Any]] = []
        if user_message:
            parts.append({"type": "text", "text": user_message})
        for url in images:
            if not isinstance(url, str) or not url:
                continue
            parts.append({"type": "image_url", "image_url": {"url": url}})
        # 无文本也无图片,防退化为空
        if not parts:
            parts = [{"type": "text", "text": ""}]
        user_msg = {"role": "user", "content": parts}
    else:
        user_msg = {"role": "user", "content": user_message}

    messages.append(user_msg)
    yield _sse("step_start", {"step": 0, "role": "user"}), [user_msg]

    def _cancelled() -> bool:
        return cancel_event is not None and cancel_event.is_set()

    for step in range(1, steps + 1):
        if _cancelled():
            yield _sse("done", {"step": step, "reason": "stopped"}), []
            return

        yield _sse("step_start", {"step": step}), []

        # ---- 0. 压缩较早的 tool_result,节省上下文(原地修改,保持前缀稳定以吃满缓存) ----
        compressed_n = _compress_history(messages)
        if compressed_n:
            yield _sse("context_compressed", {"step": step, "count": compressed_n}), []

        # ---- 1. 流式调用 LLM ----
        # 埋点:记录本次实际发送给 API 的 messages + tools 快照
        _dbg_id = debug_log.record_start(
            session_id=session_id,
            step=step,
            messages=messages,
            tools=active_tools,
            model=os.getenv("OPENAI_MODEL"),
        )
        try:
            stream = await chat_stream(client, messages, tools=active_tools)
        except Exception as e:
            debug_log.record_finish(_dbg_id, error=f"chat_stream: {e}")
            yield _sse("error", {"where": "llm", "message": str(e)}), []
            return

        assistant_text = ""
        # tool_calls 需要按 index 累积增量
        tool_buf: dict[int, dict[str, Any]] = {}
        usage_info: dict[str, Any] | None = None

        try:
            async for chunk in stream:
                if _cancelled():
                    # 尝试关掉底层流,避免继续消耗 token
                    try:
                        await stream.close()  # type: ignore[attr-defined]
                    except Exception:
                        pass
                    break
                # include_usage 开启后,最后一个 chunk 会带 usage
                u = getattr(chunk, "usage", None)
                if u is not None:
                    try:
                        details = getattr(u, "prompt_tokens_details", None)
                        cached = 0
                        if details is not None:
                            cached = int(getattr(details, "cached_tokens", 0) or 0)
                        # DeepSeek 有 prompt_cache_hit_tokens
                        if not cached:
                            cached = int(getattr(u, "prompt_cache_hit_tokens", 0) or 0)
                        # 把完整 usage 原始对象也 dump 出来,便于诊断不同厂商的字段命名
                        try:
                            raw_usage = u.model_dump() if hasattr(u, "model_dump") else dict(u)
                        except Exception:
                            raw_usage = {"repr": repr(u)}
                        usage_info = {
                            "prompt": int(getattr(u, "prompt_tokens", 0) or 0),
                            "cached": cached,
                            "completion": int(getattr(u, "completion_tokens", 0) or 0),
                            "total": int(getattr(u, "total_tokens", 0) or 0),
                            "raw": raw_usage,
                        }
                    except Exception:
                        usage_info = None
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta

                if delta.content:
                    assistant_text += delta.content
                    yield _sse("assistant_delta", {"text": delta.content}), []

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        slot = tool_buf.setdefault(
                            idx,
                            {"id": None, "type": "function",
                             "function": {"name": "", "arguments": ""}},
                        )
                        if tc.id:
                            slot["id"] = tc.id
                        if tc.function:
                            if tc.function.name:
                                slot["function"]["name"] += tc.function.name
                            if tc.function.arguments:
                                slot["function"]["arguments"] += tc.function.arguments
        except Exception as e:
            debug_log.record_finish(_dbg_id, error=f"stream: {e}")
            yield _sse("error", {"where": "stream", "message": str(e)}), []
            return

        tool_calls = [tool_buf[i] for i in sorted(tool_buf.keys())] if tool_buf else []

        # 埋点:记录本次响应
        debug_log.record_finish(
            _dbg_id,
            assistant_text=assistant_text,
            tool_calls=tool_calls,
            usage=usage_info,
        )

        # ---- 2. 把 assistant 消息写回历史 ----
        assistant_msg: dict[str, Any] = {"role": "assistant", "content": assistant_text or None}
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        messages.append(assistant_msg)
        yield _sse(
            "assistant_message",
            {"content": assistant_text, "tool_calls": tool_calls},
        ), [assistant_msg]

        if usage_info:
            yield _sse("usage", {"step": step, **usage_info}), []

        if _cancelled():
            yield _sse("done", {"step": step, "reason": "stopped"}), []
            return

        # ---- 3. 若无工具调用,轮次结束 ----
        if not tool_calls:
            yield _sse("done", {"step": step, "reason": "final"}), []
            return

        # ---- 3.5 死循环护栏:连续 N 步"空文本 + 工具签名完全相同" → 中止 ----
        sigs = tuple(sorted(_tool_signature(tc) for tc in tool_calls))
        if not (assistant_text or "").strip() and sigs == last_signatures:
            silent_streak += 1
        else:
            silent_streak = 0
        last_signatures = sigs

        if silent_streak >= _LOOP_GUARD_STREAK:
            hint_text = (
                f"⚠️ 检测到模型陷入沉默循环:连续 {silent_streak + 1} 步没有任何文本输出,"
                f"且反复调用相同的工具签名 {list(sigs)}。已自动中止本轮,防止 token 浪费。\n"
                "建议:请重新用一句更明确的话描述你要做什么(比如指定文件路径、具体改动点),"
                "或先切到 Ask 模式让它给出方案,再切回 Agent 落地。"
            )
            # 作为 assistant 消息追加到历史(方便下轮上下文),同时用 SSE 推给前端
            guard_msg = {"role": "assistant", "content": hint_text}
            messages.append(guard_msg)
            yield _sse("assistant_message", {"content": hint_text, "tool_calls": []}), [guard_msg]
            yield _sse("done", {"step": step, "reason": "loop_guard"}), []
            return

        # ---- 4. 执行每个工具,把结果塞回 messages ----
        for call in tool_calls:
            if _cancelled():
                yield _sse("done", {"step": step, "reason": "stopped"}), []
                return

            name = call["function"]["name"]
            args_json = call["function"].get("arguments") or "{}"
            call_id = call.get("id") or ""

            yield _sse(
                "tool_call",
                {"id": call_id, "name": name, "arguments": args_json},
            ), []

            result_str = await dispatch(name, args_json)

            # ---- read_file 反复读同一文件时,注入强告警,逼模型停下来 ----
            if name == "read_file":
                try:
                    _a = json.loads(args_json) if isinstance(args_json, str) else (args_json or {})
                    _p = str(_a.get("path") or "")
                except Exception:
                    _p = ""
                if _p:
                    readfile_path_count[_p] = readfile_path_count.get(_p, 0) + 1
                    _n = readfile_path_count[_p]
                    if _n >= _READFILE_WARN_AT:
                        try:
                            _r = json.loads(result_str)
                            if isinstance(_r, dict):
                                _r["hint"] = (
                                    f"🚨 你已经对 `{_p}` 调用了 {_n} 次 read_file,几乎肯定是在"
                                    "分段读整文件——这是本 Agent 明令禁止的最费 token 用法!\n"
                                    "**立即停止继续读取该文件**,改为:\n"
                                    "1) 用 search_code 精确定位到关键行号;或\n"
                                    "2) 直接向用户输出自然语言总结/方案,并说明你目前掌握的信息是否足够,\n"
                                    "   若不足则请用户补充需求,不要再继续读文件。"
                                )
                                result_str = json.dumps(_r, ensure_ascii=False)
                        except Exception:
                            pass

            # write_file / apply_patch 返回的 old_content / new_content 只给前端做 diff,
            # 不能塞进 messages 送回 LLM(否则每个写文件都会翻倍占用上下文)。
            llm_result_str = result_str
            try:
                _obj = json.loads(result_str)
                if isinstance(_obj, dict) and (
                    "old_content" in _obj or "new_content" in _obj
                ):
                    _slim = {k: v for k, v in _obj.items()
                             if k not in ("old_content", "new_content")}
                    _slim["_diff_stripped"] = True  # 告知 LLM: 内容已省略,仅前端展示
                    llm_result_str = json.dumps(_slim, ensure_ascii=False)
            except Exception:
                pass

            tool_msg = {
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": llm_result_str,
            }
            messages.append(tool_msg)

            # 尝试解析成对象以便前端渲染(前端拿完整的,含 old/new content)
            try:
                result_obj = json.loads(result_str)
            except Exception:
                result_obj = {"raw": result_str}

            yield _sse(
                "tool_result",
                {"id": call_id, "name": name, "result": result_obj},
            ), [tool_msg]

    # 到达最大步数
    yield _sse("done", {"reason": "max_steps"}), []
