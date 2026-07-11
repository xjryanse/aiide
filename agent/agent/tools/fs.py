"""文件系统工具:list_dir / read_file / write_file / apply_patch。"""
from __future__ import annotations

from pathlib import Path

from .sandbox import resolve_safe, to_rel, workspace_root

MAX_READ_BYTES = 200_000  # 单次读取上限,防止把 token 打爆
MAX_READ_LINES = 200  # 未指定范围时最多返回的行数(保守值,鼓励精读)
DIFF_MAX_BYTES = 256 * 1024  # write_file/apply_patch 返回 old/new 内容的单侧上限(超出则不返回,由前端提示"过大不显示")


def _read_text_for_diff(target: Path) -> tuple[str | None, bool]:
    """读取文件文本用于 diff 展示。
    返回 (text, too_large_or_binary):
      - 文件不存在 → (None, False)
      - 二进制无法解码 → (None, False)
      - 超过 DIFF_MAX_BYTES → (None, True)
    """
    if not target.exists() or not target.is_file():
        return None, False
    try:
        if target.stat().st_size > DIFF_MAX_BYTES:
            return None, True
        return target.read_text(encoding="utf-8"), False
    except UnicodeDecodeError:
        return None, False
    except Exception:
        return None, False


def list_dir(path: str = ".") -> dict:
    target = resolve_safe(path)
    if not target.exists():
        return {"ok": False, "error": f"目录不存在: {path}"}
    if not target.is_dir():
        return {"ok": False, "error": f"不是目录: {path}"}
    entries = []
    for child in sorted(target.iterdir()):
        entries.append({
            "name": child.name,
            "type": "dir" if child.is_dir() else "file",
            "size": child.stat().st_size if child.is_file() else None,
        })
    return {"ok": True, "path": to_rel(target) or ".", "entries": entries}


def read_file(
    path: str,
    start_line: int | None = None,
    end_line: int | None = None,
    max_lines: int | None = None,
    max_bytes: int = MAX_READ_BYTES,
) -> dict:
    """读取文件内容,可指定行范围。

    - 不传 start_line/end_line: 从第 1 行开始最多 MAX_READ_LINES 行(默认 400)
    - start_line/end_line: 均为 1-based 闭区间
    - 结果中的 content 前会带 `// LINES: a-b/total` 标记,方便 LLM 定位
    """
    target = resolve_safe(path)
    if not target.exists():
        return {"ok": False, "error": f"文件不存在: {path}"}
    if not target.is_file():
        return {"ok": False, "error": f"不是文件: {path}"}

    size = target.stat().st_size
    with target.open("rb") as f:
        raw = f.read(min(size, max_bytes) + 1)
    byte_truncated = len(raw) > max_bytes
    if byte_truncated:
        raw = raw[:max_bytes]
    try:
        full_text = raw.decode("utf-8")
    except UnicodeDecodeError:
        full_text = raw.decode("utf-8", errors="replace")

    lines = full_text.splitlines()
    total = len(lines)

    if start_line is None and end_line is None:
        s = 1
        e = min(total, (max_lines or MAX_READ_LINES))
    else:
        s = max(1, int(start_line or 1))
        e = int(end_line) if end_line is not None else min(total, s + (max_lines or MAX_READ_LINES) - 1)
        e = min(e, total)
        if max_lines is not None:
            e = min(e, s + int(max_lines) - 1)

    if s > total:
        return {
            "ok": True,
            "path": to_rel(target),
            "size": size,
            "total_lines": total,
            "start_line": s,
            "end_line": s - 1,
            "content": "",
            "range_truncated": False,
            "hint": f"文件只有 {total} 行, start_line={s} 越界",
        }

    body = "\n".join(lines[s - 1:e])
    header = f"// LINES: {s}-{e}/{total}\n"
    range_truncated = (e < total)

    # 给 LLM 一个明确提示,避免它无脑再要"下一段"把整文件读完
    hint = None
    if range_truncated:
        hint = (
            f"此文件共 {total} 行, 本次仅返回 {s}-{e} 行。"
            "**不要盲目继续读剩余行!** 先判断当前片段是否已足够回答/完成任务; "
            "如果不够, 请用 search_code 定位到具体行号后再精读需要的段落, "
            "而不是把 1..N/N+1..2N 一段段读完整个文件(那样比一次整读还费 token)。"
        )

    result = {
        "ok": True,
        "path": to_rel(target),
        "size": size,
        "total_lines": total,
        "start_line": s,
        "end_line": e,
        "range_truncated": range_truncated,
        "byte_truncated": byte_truncated,
        "content": header + body,
    }
    if hint:
        result["hint"] = hint
    return result


def write_file(path: str, content: str) -> dict:
    target = resolve_safe(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    # 抓旧内容用于前端 diff 展示
    is_new_file = not target.exists()
    old_text, old_too_large = _read_text_for_diff(target)

    data = (content or "").encode("utf-8")
    target.write_bytes(data)

    new_too_large = len(data) > DIFF_MAX_BYTES
    diff_too_large = old_too_large or new_too_large

    result = {
        "ok": True,
        "path": to_rel(target),
        "bytes_written": len(data),
        "is_new_file": is_new_file,
        "diff_too_large": diff_too_large,
    }
    if not diff_too_large:
        # 新文件时 old_content = "" 便于前端把整个文件视为"新增"
        result["old_content"] = "" if is_new_file else (old_text or "")
        result["new_content"] = content or ""
    return result


def apply_patch(path: str, old_string: str, new_string: str) -> dict:
    """在指定文件里把 old_string 精确替换为 new_string(要求唯一命中)。"""
    target = resolve_safe(path)
    if not target.exists() or not target.is_file():
        return {"ok": False, "error": f"文件不存在: {path}"}
    text = target.read_text(encoding="utf-8", errors="replace")
    count = text.count(old_string)
    if count == 0:
        return {"ok": False, "error": "old_string 未在文件中找到"}
    if count > 1:
        return {"ok": False, "error": f"old_string 命中 {count} 次,需要更长的上下文以保证唯一"}
    new_text = text.replace(old_string, new_string, 1)
    target.write_text(new_text, encoding="utf-8")

    diff_too_large = (
        len(text.encode("utf-8")) > DIFF_MAX_BYTES
        or len(new_text.encode("utf-8")) > DIFF_MAX_BYTES
    )
    result = {
        "ok": True,
        "path": to_rel(target),
        "replaced": 1,
        "is_new_file": False,
        "diff_too_large": diff_too_large,
    }
    if not diff_too_large:
        result["old_content"] = text
        result["new_content"] = new_text
    return result
