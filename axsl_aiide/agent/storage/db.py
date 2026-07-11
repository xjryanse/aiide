"""SQLite 会话存储(异步)。表结构:sessions / messages。"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import aiosqlite


def _db_path() -> Path:
    root = os.getenv("STORAGE_DIR", "../storage")
    p = Path(root).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p / "sessions.db"


async def init_db() -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                title TEXT,
                workspace TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, seq);
            """
        )
        # 兼容老库:若 sessions 表已存在但没有 workspace 列,补上
        async with db.execute("PRAGMA table_info(sessions)") as cur:
            cols = {row[1] for row in await cur.fetchall()}
        if "workspace" not in cols:
            await db.execute("ALTER TABLE sessions ADD COLUMN workspace TEXT")
        await db.commit()


async def create_session(title: str | None = None, workspace: str | None = None) -> str:
    sid = uuid.uuid4().hex[:16]
    async with aiosqlite.connect(_db_path()) as db:
        await db.execute(
            "INSERT INTO sessions(id, created_at, title, workspace) VALUES(?,?,?,?)",
            (sid, datetime.utcnow().isoformat(), title, workspace),
        )
        await db.commit()
    return sid


async def ensure_session(session_id: str | None, workspace: str | None = None) -> str:
    """确认/新建会话。若传入了 workspace 且该 session 当前尚未记录,则补写。"""
    if session_id:
        async with aiosqlite.connect(_db_path()) as db:
            async with db.execute(
                "SELECT id, workspace FROM sessions WHERE id=?", (session_id,)
            ) as cur:
                row = await cur.fetchone()
            if row:
                # 若 session 还没绑定 workspace,而这次带了,顺手写入
                if workspace and not row[1]:
                    await db.execute(
                        "UPDATE sessions SET workspace=? WHERE id=?",
                        (workspace, session_id),
                    )
                    await db.commit()
                return session_id
    return await create_session(workspace=workspace)


async def get_session(session_id: str) -> dict[str, Any] | None:
    """按 id 拉取 session 元信息(含 workspace)。"""
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            "SELECT id, created_at, title, workspace FROM sessions WHERE id=?",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "session_id": row[0],
        "created_at": row[1],
        "title": row[2],
        "workspace": row[3],
    }


async def load_messages(session_id: str) -> list[dict[str, Any]]:
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            "SELECT payload FROM messages WHERE session_id=? ORDER BY seq ASC",
            (session_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [json.loads(r[0]) for r in rows]


def _derive_title(msgs: list[dict[str, Any]]) -> str | None:
    """从消息序列里挑第一条 user 文本,截前 40 字符作为标题。"""
    for m in msgs:
        if m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str) and content.strip():
                t = content.strip().replace("\n", " ")
                return t[:40] + ("…" if len(t) > 40 else "")
    return None


async def append_messages(session_id: str, msgs: list[dict[str, Any]]) -> None:
    if not msgs:
        return
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE session_id=?",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
            seq = (row[0] if row else 0) or 0
        now = datetime.utcnow().isoformat()
        rows = []
        for m in msgs:
            seq += 1
            rows.append((session_id, seq, json.dumps(m, ensure_ascii=False), now))
        await db.executemany(
            "INSERT INTO messages(session_id, seq, payload, created_at) VALUES(?,?,?,?)",
            rows,
        )
        # 如 session 尚无 title,尝试根据本批 user 消息生成
        async with db.execute(
            "SELECT title FROM sessions WHERE id=?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        if row is not None and not row[0]:
            title = _derive_title(msgs)
            if title:
                await db.execute(
                    "UPDATE sessions SET title=? WHERE id=?", (title, session_id)
                )
        await db.commit()


async def delete_session(session_id: str) -> bool:
    """删除会话及其全部消息。返回是否真的删掉了。"""
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            "SELECT id FROM sessions WHERE id=?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return False
        await db.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
        await db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        await db.commit()
        return True


async def rename_session(session_id: str, title: str) -> bool:
    """重命名会话。title 会被裁剪到 80 字符。返回是否更新成功。"""
    title = (title or "").strip()
    if len(title) > 80:
        title = title[:80]
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            "SELECT id FROM sessions WHERE id=?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return False
        await db.execute(
            "UPDATE sessions SET title=? WHERE id=?", (title or None, session_id)
        )
        await db.commit()
        return True


async def list_sessions(limit: int = 50) -> list[dict[str, Any]]:
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            """
            SELECT s.id, s.created_at, s.title, s.workspace, COUNT(m.id) AS cnt
            FROM sessions s LEFT JOIN messages m ON s.id = m.session_id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ) as cur:
            rows = await cur.fetchall()

        # 对没 title 的老会话,查首条 user 消息即时生成显示标题(不写库,幂等)
        out: list[dict[str, Any]] = []
        for r in rows:
            sid, created, title, workspace, cnt = r[0], r[1], r[2], r[3], r[4]
            if not title and cnt:
                async with db.execute(
                    "SELECT payload FROM messages WHERE session_id=? ORDER BY seq ASC LIMIT 20",
                    (sid,),
                ) as mc:
                    m_rows = await mc.fetchall()
                first_msgs = [json.loads(x[0]) for x in m_rows]
                title = _derive_title(first_msgs)
            out.append({
                "session_id": sid,
                "created_at": created,
                "title": title,
                "workspace": workspace,
                "message_count": cnt,
            })
    return out
