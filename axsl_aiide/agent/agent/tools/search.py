"""search_code 工具:跨当前 workspace 所有 root 做语义检索。"""
from __future__ import annotations

from typing import Any, Dict

from ..indexer import indexer


def search_code(query: str, top_k: int = 10) -> Dict[str, Any]:
    """在向量索引里搜索与 query 语义相关的代码片段。

    多根场景下会并行查询所有 root 并合并结果,
    返回的 file 字段带 `<root>/` 前缀,如 `order/app/api/create.py`。
    """
    if not query or not query.strip():
        return {"ok": False, "error": "query 不能为空"}
    try:
        top_k = int(top_k)
    except Exception:
        top_k = 10
    top_k = max(1, min(top_k, 30))
    return indexer.search_all(query.strip(), top_k=top_k)
