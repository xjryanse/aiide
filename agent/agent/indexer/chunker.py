"""代码分片 & 工作区扫描规则。

按行滑动分片(chunk_lines=40, overlap=5),每片带 file/start_line/end_line 元信息。
分片头部拼上文件路径,提升 embedding 定位能力。
"""
from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Iterable, List, Tuple

CHUNK_LINES = 40
OVERLAP_LINES = 5
MAX_FILE_BYTES = 400_000  # 400KB 以上跳过

# 允许索引的文本扩展名(小写)
TEXT_EXTS = {
    ".py", ".pyw", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".php", ".phtml", ".inc",
    ".go", ".rs", ".java", ".kt", ".cs", ".c", ".h", ".cpp", ".hpp", ".cc",
    ".rb", ".swift", ".m", ".mm",
    ".html", ".htm", ".vue", ".svelte",
    ".css", ".scss", ".sass", ".less",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
    ".sql", ".sh", ".bat", ".ps1",
    ".md", ".mdx", ".rst", ".txt",
    ".xml", ".proto", ".graphql", ".gql",
}

# 忽略目录(任意层级匹配)
IGNORE_DIRS = {
    ".git", ".svn", ".hg",
    "node_modules", "vendor", "bower_components",
    "__pycache__", ".venv", "venv", "env", ".env",
    "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache",
    ".idea", ".vscode",
    "storage", "logs", "tmp", "temp",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "coverage", "target",
}

# 忽略文件通配
IGNORE_FILE_GLOBS = [
    "*.min.js", "*.min.css", "*.map",
    "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
    "*.log",
]


def should_skip_dir(name: str) -> bool:
    return name in IGNORE_DIRS or name.startswith(".")


def should_skip_file(name: str) -> bool:
    for pat in IGNORE_FILE_GLOBS:
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() not in TEXT_EXTS:
        return False
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return False
    except OSError:
        return False
    return True


def iter_source_files(root: Path) -> Iterable[Path]:
    """遍历 root 下所有可索引文件(带忽略规则)。"""
    root = root.resolve()
    for dirpath, dirnames, filenames in _walk(root):
        # 就地过滤子目录
        dirnames[:] = [d for d in dirnames if not should_skip_dir(d)]
        for fn in filenames:
            if should_skip_file(fn):
                continue
            p = Path(dirpath) / fn
            if is_text_file(p):
                yield p


def _walk(root: Path):
    # 用 os.walk 以便就地修改 dirnames
    import os
    return os.walk(root)


def chunk_file(rel_path: str, text: str) -> List[Tuple[str, int, int, str]]:
    """把文件内容切成 (chunk_id, start_line, end_line, text_with_header) 列表。

    text_with_header 会在最前面拼上文件路径,提升向量定位准确度。
    """
    lines = text.splitlines()
    n = len(lines)
    if n == 0:
        return []

    out: List[Tuple[str, int, int, str]] = []
    step = max(1, CHUNK_LINES - OVERLAP_LINES)
    i = 0
    while i < n:
        j = min(i + CHUNK_LINES, n)
        body = "\n".join(lines[i:j])
        header = f"// FILE: {rel_path}\n// LINES: {i + 1}-{j}\n"
        chunk_text = header + body
        chunk_id = f"{rel_path}#{i + 1}-{j}"
        out.append((chunk_id, i + 1, j, chunk_text))
        if j >= n:
            break
        i += step
    return out
