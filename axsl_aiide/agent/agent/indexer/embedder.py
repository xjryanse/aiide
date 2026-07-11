"""本地 embedding 封装。

默认使用 sentence-transformers + BAAI/bge-small-zh-v1.5(中英代码混合场景不错)。
模型在首次调用时懒加载,并缓存到 storage/models/。
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import List, Sequence

_lock = threading.Lock()
_model = None
_dim: int = 0


def _cache_dir() -> Path:
    root = Path(os.getenv("STORAGE_DIR", "../storage")).resolve()
    d = root / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_model():
    """懒加载 sentence-transformers 模型(线程安全,只加载一次)。"""
    global _model, _dim
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        # 国内环境默认走 hf-mirror(可通过 HF_ENDPOINT 覆盖)
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        # 延迟 import,避免启动时强依赖
        from sentence_transformers import SentenceTransformer  # type: ignore

        name = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
        cache = str(_cache_dir())
        os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", cache)
        os.environ.setdefault("HF_HOME", cache)
        model = SentenceTransformer(name, cache_folder=cache)
        _model = model
        _dim = int(model.get_sentence_embedding_dimension() or 384)
    return _model


def embedding_dim() -> int:
    if _dim == 0:
        load_model()
    return _dim


def embed_texts(texts: Sequence[str]) -> List[List[float]]:
    """批量编码文本 -> 向量。"""
    if not texts:
        return []
    m = load_model()
    vecs = m.encode(
        list(texts),
        batch_size=32,
        show_progress_bar=False,
        normalize_embeddings=True,  # cosine 检索友好
        convert_to_numpy=True,
    )
    return [v.tolist() for v in vecs]


def embed_query(text: str) -> List[float]:
    return embed_texts([text])[0]
