"""工具注册表:统一暴露 OpenAI tools schema 与分发器。"""
from __future__ import annotations

import inspect
import json
from typing import Any, Awaitable, Callable

from . import fs, search, shell

# 每个工具:name -> (callable, schema)
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_code",
            "description": (
                "在当前 workspace 的向量索引中做语义检索,快速定位与 query 相关的代码片段。"
                "**多根工作区会跨所有 root 并行检索**,返回的 file 字段带 `<root>/` 前缀。"
                "适合先用它找到候选文件/函数,再用 read_file 精读。"
                "若索引为空,返回 empty_index=true,应提示用户先建索引。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "自然语言或代码关键字"},
                    "top_k": {
                        "type": "integer",
                        "description": "返回条数(1-30,默认 10)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": (
                "列出工作区内某目录的直接子项。用于侦察目录结构。"
                "多根场景请显式带前缀,例如 'gateway/src' 或 'order/'。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "格式 `<root>/子路径`;不带前缀时默认落在 default_cwd 那个 root",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "读取工作区内文件的指定行范围。"
                "**默认(不传 start_line)只返回前 200 行**,不足以看全整个文件。"
                "推荐用法:先用 search_code 拿到候选文件+行号,然后 read_file(path, start_line, end_line) 精读 20-100 行。"
                "**禁止用 read_file 分段读完一整个文件**(比如 1-200, 200-400, 400-600 这样连续读);"
                "如果你觉得需要整读,说明你选错方法了,应该改用 search_code 或先看 total_lines 判断哪一段才相关。"
                "返回值中 total_lines 是文件总行数, hint 会提醒你下一步。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "格式 `<root>/相对路径`,例如 'order/app/api/create.py'"},
                    "start_line": {"type": "integer", "description": "起始行(1-based),不传则从第 1 行开始"},
                    "end_line": {"type": "integer", "description": "结束行(1-based 闭区间),建议 start_line + 50~100 以内"},
                    "max_lines": {"type": "integer", "description": "最多返回行数,默认 200"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "在工作区内创建或覆盖文件。父目录不存在会自动创建。path 需带 <root>/ 前缀。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "格式 `<root>/相对路径`"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_patch",
            "description": (
                "对已有文件做精确字符串替换。old_string 必须在文件中唯一出现,建议包含足够上下文。"
                "path 需带 <root>/ 前缀。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "格式 `<root>/相对路径`"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": (
                "在工作区目录内执行一条 shell 命令(默认 60 秒超时)。"
                "用于运行测试、启动脚本、查看命令行输出等。"
                "**默认 cwd = 当前 workspace 的 default_cwd root**。"
                "想切到某个 root 用 `cd <root_name>[/子目录] && <命令>` 语法,例如 "
                "`cd order && npm test` 或 `cd gateway/src && ls`。"
                "禁止破坏性命令。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的命令行,可用 `cd <root>/... && ...` 切换 root"},
                    "timeout": {
                        "type": "integer",
                        "description": "超时秒数(可选,默认 60,最大 300)",
                    },
                },
                "required": ["command"],
            },
        },
    },
]

_DISPATCH: dict[str, Callable[..., Any]] = {
    "search_code": search.search_code,
    "list_dir": fs.list_dir,
    "read_file": fs.read_file,
    "write_file": fs.write_file,
    "apply_patch": fs.apply_patch,
    "run_shell": shell.run_shell,
}


async def dispatch(name: str, args_json: str) -> str:
    """按名字执行工具,返回 JSON 字符串(供塞回 messages)。"""
    try:
        args = json.loads(args_json) if args_json else {}
    except json.JSONDecodeError as e:
        return json.dumps({"ok": False, "error": f"参数不是合法 JSON: {e}"}, ensure_ascii=False)

    fn = _DISPATCH.get(name)
    if fn is None:
        return json.dumps({"ok": False, "error": f"未知工具: {name}"}, ensure_ascii=False)

    try:
        result: Any
        if inspect.iscoroutinefunction(fn):
            result = await fn(**args)
        else:
            result = fn(**args)
    except TypeError as e:
        return json.dumps({"ok": False, "error": f"参数错误: {e}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": f"工具执行异常: {e}"}, ensure_ascii=False)

    return json.dumps(result, ensure_ascii=False)
