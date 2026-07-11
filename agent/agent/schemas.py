"""Pydantic 数据模型:请求/响应 schema。"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# 对话模式:
#   ask   - 只做问答,不修改任何文件(禁用 write_file/apply_patch/run_shell)
#   agent - 智能修改,允许全部工具
#   debug - 修复 bug 专用模式,允许全部工具但系统 Prompt 聚焦 bug 定位与最小改动
ChatMode = Literal["ask", "agent", "debug"]


class ChatRequest(BaseModel):
    session_id: Optional[str] = Field(default=None, description="会话 ID,不传则新建")
    message: str = Field(..., description="用户消息文本(可为空,但至少要有 images)")
    workspace: Optional[str] = Field(
        default=None,
        description="本次对话使用的工作区绝对路径(覆盖服务端默认 WORKSPACE_DIR)",
    )
    images: Optional[list[str]] = Field(
        default=None,
        description="可选:图片 data URL 列表(data:image/xxx;base64,...),用于多模态模型",
    )
    mode: ChatMode = Field(
        default="agent",
        description="对话模式: ask=只问答不改文件, agent=智能修改, debug=修复bug",
    )


class SessionInfo(BaseModel):
    session_id: str
    created_at: str
    message_count: int


class StreamEvent(BaseModel):
    """SSE 单条事件。"""
    type: Literal[
        "session",
        "step_start",
        "assistant_delta",
        "assistant_message",
        "tool_call",
        "tool_result",
        "error",
        "done",
    ]
    data: Any = None
