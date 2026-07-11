"""建索引 & 检索:基于 chromadb 的持久化向量库。

每个 workspace 一个独立 collection,collection 名为 workspace 绝对路径的 hash。
增量策略:file_path + mtime + size 作为文件签名,签名未变则跳过。
"""
from __future__ import annotations

import hashlib
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import chunker, embedder

_client_lock = threading.Lock()
_client = None


def _storage_root() -> Path:
    root = Path(os.getenv("STORAGE_DIR", "../storage")).resolve()
    d = root / "vectors"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _get_client():
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is not None:
            return _client
        import chromadb  # type: ignore
        from chromadb.config import Settings  # type: ignore

        _client = chromadb.PersistentClient(
            path=str(_storage_root()),
            settings=Settings(anonymized_telemetry=False, allow_reset=True),
        )
    return _client


def _collection_name(workspace: Path) -> str:
    h = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()[:16]
    return f"ws_{h}"


def _get_collection(workspace: Path):
    cli = _get_client()
    name = _collection_name(workspace)
    return cli.get_or_create_collection(
        name=name,
        metadata={"workspace": str(workspace.resolve()), "hnsw:space": "cosine"},
    )


def _file_signature(path: Path) -> str:
    try:
        st = path.stat()
        return f"{int(st.st_mtime)}:{st.st_size}"
    except OSError:
        return "0:0"


def _relpath(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(path)


def build_index(workspace: str | Path, force: bool = False) -> Dict[str, Any]:
    """扫描 workspace,增量更新向量索引。返回统计信息。"""
    root = Path(workspace).expanduser().resolve()
    if not root.exists():
        return {"ok": False, "error": f"workspace 不存在: {root}"}

    coll = _get_collection(root)
    t0 = time.time()

    # 读取已有文件签名(以 chunk metadata 汇总)
    existing_sig: Dict[str, str] = {}
    try:
        got = coll.get(include=["metadatas"])
        for md in got.get("metadatas", []) or []:
            if not md:
                continue
            fp = md.get("file")
            sig = md.get("sig")
            if fp and sig and (fp not in existing_sig):
                existing_sig[fp] = sig
    except Exception:
        existing_sig = {}

    # 扫描当前文件
    files: List[Path] = list(chunker.iter_source_files(root))
    current: Dict[str, str] = {}
    for p in files:
        current[_relpath(p, root)] = _file_signature(p)

    to_add: List[Path] = []
    to_delete_files: List[str] = []

    if force:
        # 全量重建:清空后重来
        try:
            coll = _reset_collection(root)
        except Exception:
            pass
        existing_sig = {}
        to_add = files
    else:
        for p in files:
            rel = _relpath(p, root)
            if existing_sig.get(rel) != current.get(rel):
                to_add.append(p)
        # 已删除的文件
        for rel in existing_sig:
            if rel not in current:
                to_delete_files.append(rel)

    # 先删除:已删除的文件、以及要更新的文件的旧 chunks
    del_files = list(set(to_delete_files) | {_relpath(p, root) for p in to_add})
    for rel in del_files:
        try:
            coll.delete(where={"file": rel})
        except Exception:
            pass

    # 对 to_add 分片 + embed + 入库
    added_files = 0
    added_chunks = 0
    for p in to_add:
        rel = _relpath(p, root)
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        chunks = chunker.chunk_file(rel, text)
        if not chunks:
            continue
        ids = [c[0] for c in chunks]
        docs = [c[3] for c in chunks]
        metas = [
            {
                "file": rel,
                "start": c[1],
                "end": c[2],
                "sig": current[rel],
            }
            for c in chunks
        ]
        try:
            vecs = embedder.embed_texts(docs)
            coll.add(ids=ids, embeddings=vecs, documents=docs, metadatas=metas)
            added_files += 1
            added_chunks += len(chunks)
        except Exception as e:
            # 单文件失败不影响整体
            print(f"[indexer] embed failed for {rel}: {e}")
            continue

    return {
        "ok": True,
        "workspace": str(root),
        "collection": _collection_name(root),
        "scanned_files": len(files),
        "changed_files": added_files,
        "deleted_files": len(to_delete_files),
        "new_chunks": added_chunks,
        "elapsed_sec": round(time.time() - t0, 2),
        "force": force,
    }


def _reset_collection(workspace: Path):
    cli = _get_client()
    name = _collection_name(workspace)
    try:
        cli.delete_collection(name)
    except Exception:
        pass
    return _get_collection(workspace)


def search(workspace: str | Path, query: str, top_k: int = 10) -> Dict[str, Any]:
    """向量检索。返回 hits 列表(含文件/行号/片段/相似度)。"""
    root = Path(workspace).expanduser().resolve()
    coll = _get_collection(root)
    # 若空库,提示先建索引
    try:
        count = coll.count()
    except Exception:
        count = 0
    if count == 0:
        return {
            "ok": True,
            "hits": [],
            "empty_index": True,
            "message": "该 workspace 的向量索引为空,请先调用 /v1/index/build 建索引。",
        }

    try:
        qv = embedder.embed_query(query)
    except Exception as e:
        return {"ok": False, "error": f"embedding 失败: {e}"}

    try:
        res = coll.query(
            query_embeddings=[qv],
            n_results=max(1, min(int(top_k or 10), 50)),
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        return {"ok": False, "error": f"检索失败: {e}"}

    hits: List[Dict[str, Any]] = []
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists = (res.get("distances") or [[]])[0]
    for doc, md, dist in zip(docs, metas, dists):
        # 剥离头两行 header,只留原始代码片段
        snippet = doc
        if snippet.startswith("// FILE:"):
            parts = snippet.split("\n", 2)
            snippet = parts[2] if len(parts) >= 3 else snippet
        # cosine distance -> similarity
        sim = 1.0 - float(dist) if dist is not None else None
        hits.append(
            {
                "file": (md or {}).get("file"),
                "start_line": (md or {}).get("start"),
                "end_line": (md or {}).get("end"),
                "score": round(sim, 4) if sim is not None else None,
                "snippet": _truncate(snippet, 800),
            }
        )
    return {"ok": True, "hits": hits, "count": len(hits)}


def _truncate(s: str, max_chars: int) -> str:
    if s is None:
        return ""
    if len(s) <= max_chars:
        return s
    return s[:max_chars] + "\n...(截断)"


def stats(workspace: str | Path) -> Dict[str, Any]:
    root = Path(workspace).expanduser().resolve()
    coll = _get_collection(root)
    try:
        cnt = coll.count()
    except Exception:
        cnt = 0
    files: set[str] = set()
    try:
        got = coll.get(include=["metadatas"])
        for md in got.get("metadatas", []) or []:
            if md and md.get("file"):
                files.add(md["file"])
    except Exception:
        pass
    return {
        "ok": True,
        "workspace": str(root),
        "collection": _collection_name(root),
        "chunk_count": cnt,
        "file_count": len(files),
    }


# ============ 多根(workspace)高层封装 ============
def _current_roots() -> Dict[str, Path]:
    """从 sandbox 拿当前生效 workspace 的所有 root。"""
    try:
        from ..tools.sandbox import workspace_roots
        return dict(workspace_roots())
    except Exception:
        return {}


def build_index_all(force: bool = False) -> Dict[str, Any]:
    """对当前 workspace 的所有 root 分别建索引。"""
    roots = _current_roots()
    if not roots:
        return {"ok": False, "error": "no workspace roots"}
    per_root: List[Dict[str, Any]] = []
    total = {"scanned": 0, "changed": 0, "deleted": 0, "chunks": 0, "elapsed": 0.0}
    for name, path in roots.items():
        r = build_index(path, force=force)
        r["root"] = name
        per_root.append(r)
        if r.get("ok"):
            total["scanned"] += int(r.get("scanned_files") or 0)
            total["changed"] += int(r.get("changed_files") or 0)
            total["deleted"] += int(r.get("deleted_files") or 0)
            total["chunks"] += int(r.get("new_chunks") or 0)
            total["elapsed"] += float(r.get("elapsed_sec") or 0)
    return {"ok": True, "roots": per_root, "total": total}


def search_all(query: str, top_k: int = 10) -> Dict[str, Any]:
    """跨当前 workspace 所有 root 检索,合并结果按 score 排序,file 字段带 <root>/ 前缀。"""
    roots = _current_roots()
    if not roots:
        return {"ok": False, "error": "no workspace roots"}
    all_hits: List[Dict[str, Any]] = []
    empty_flags: List[str] = []
    for name, path in roots.items():
        r = search(path, query, top_k=top_k)
        if not r.get("ok"):
            continue
        if r.get("empty_index"):
            empty_flags.append(name)
            continue
        for h in r.get("hits", []) or []:
            f = h.get("file") or ""
            h["file"] = f"{name}/{f}" if f else name
            h["root"] = name
            all_hits.append(h)
    # 合并按分数排序,取前 top_k
    all_hits.sort(key=lambda x: (x.get("score") is None, -float(x.get("score") or 0)))
    limited = all_hits[: max(1, min(int(top_k or 10), 50))]
    if not limited and empty_flags and len(empty_flags) == len(roots):
        return {
            "ok": True,
            "hits": [],
            "empty_index": True,
            "message": "当前 workspace 所有 root 的向量索引均为空,请先建索引。",
        }
    return {
        "ok": True,
        "hits": limited,
        "count": len(limited),
        "empty_roots": empty_flags,
    }


def stats_all() -> Dict[str, Any]:
    roots = _current_roots()
    per_root = []
    total_files = 0
    total_chunks = 0
    for name, path in roots.items():
        s = stats(path)
        s["root"] = name
        per_root.append(s)
        total_files += int(s.get("file_count") or 0)
        total_chunks += int(s.get("chunk_count") or 0)
    return {"ok": True, "roots": per_root, "file_count": total_files, "chunk_count": total_chunks}

