"""FastAPI 入口:提供 /v1/chat/stream(SSE)、/v1/sessions、/v1/health。"""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse

load_dotenv(dotenv_path=Path(__file__).parent / ".env")

from agent.core import run_agent, _sse  # noqa: E402
from agent import debug_log  # noqa: E402
from agent.indexer import indexer as vindex  # noqa: E402
from agent.llm import build_client, get_model  # noqa: E402
from agent.schemas import ChatRequest  # noqa: E402
from agent import settings as agent_settings  # noqa: E402
from agent.tools.sandbox import use_workspace, workspace_root  # noqa: E402
from storage.db import (  # noqa: E402
    append_messages,
    delete_session,
    ensure_session,
    get_session,
    init_db,
    list_sessions,
    load_messages,
    rename_session,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="axsl-aiide agent", version="0.1.0", lifespan=lifespan)

# CORS 白名单:
#   默认 "*"(保持与本地开发一致的宽松策略);
#   生产/公网部署时在 agent/.env 里配置 AGENT_CORS_ORIGINS="https://a.com,https://b.com"。
_cors_env = os.getenv("AGENT_CORS_ORIGINS", "*").strip()
if _cors_env in ("", "*"):
    _cors_origins = ["*"]
else:
    _cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/v1/health")
async def health():
    prof = agent_settings.active_profile()
    return {
        "ok": True,
        "model": prof.get("model") or os.getenv("OPENAI_MODEL"),
        "base_url": prof.get("base_url") or os.getenv("OPENAI_BASE_URL"),
    }


@app.get("/v1/config")
async def config():
    """返回当前进程配置(用于扩展探活 & 显示)。"""
    prof = agent_settings.active_profile()
    params = (agent_settings.load_settings().get("params") or {})
    from agent.workspaces import active_workspace
    aw = active_workspace()
    return {
        "ok": True,
        "version": app.version,
        "model": prof.get("model") or os.getenv("OPENAI_MODEL"),
        "base_url": prof.get("base_url") or os.getenv("OPENAI_BASE_URL"),
        "default_workspace": str(workspace_root()),
        "active_workspace": {"id": aw["id"], "name": aw["name"], "roots": aw["roots"]},
        "max_steps": int(params.get("max_steps") or os.getenv("AGENT_MAX_STEPS", "20") or 20),
        "shell_timeout": int(params.get("shell_timeout") or os.getenv("AGENT_SHELL_TIMEOUT", "60") or 60),
        "max_tokens": int(params.get("max_tokens") or 0),
        "has_api_key": bool(prof.get("api_key") or os.getenv("OPENAI_API_KEY")),
    }


@app.get("/v1/settings")
async def api_get_settings():
    """返回可编辑的设置(api_key 已打码)。"""
    return {"ok": True, **agent_settings.public_view()}


@app.put("/v1/settings")
async def api_put_settings(payload: dict):
    """更新设置。若某个 profile 的 api_key 为空或为掩码占位,则保留原值。"""
    incoming = dict(payload or {})
    if isinstance(incoming.get("profiles"), list):
        current = {p["id"]: p for p in agent_settings.load_settings().get("profiles", [])}
        merged = []
        for p in incoming["profiles"]:
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or p.get("name") or "").strip()
            if not pid:
                continue
            key = p.get("api_key")
            # 前端如果没改 key,可能回传 "" 或掩码串;都视为保留旧值
            if not key or (isinstance(key, str) and "*" in key):
                key = (current.get(pid) or {}).get("api_key") or ""
            merged.append({
                "id": pid,
                "name": p.get("name") or pid,
                "base_url": p.get("base_url") or "",
                "api_key": key,
                "model": p.get("model") or "",
            })
        incoming["profiles"] = merged
    agent_settings.save_settings(incoming)
    return {"ok": True, **agent_settings.public_view()}


@app.get("/v1/sessions")
async def api_list_sessions(limit: int = 50):
    return {"sessions": await list_sessions(limit=limit)}


@app.get("/v1/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    msgs = await load_messages(session_id)
    info = await get_session(session_id)
    return {
        "session_id": session_id,
        "messages": msgs,
        "workspace": (info or {}).get("workspace"),
        "title": (info or {}).get("title"),
    }


@app.delete("/v1/sessions/{session_id}")
async def api_delete_session(session_id: str):
    ok = await delete_session(session_id)
    if not ok:
        raise HTTPException(404, "session not found")
    return {"ok": True, "session_id": session_id}


@app.patch("/v1/sessions/{session_id}")
async def api_rename_session(session_id: str, payload: dict = Body(...)):
    title = (payload or {}).get("title", "")
    if not isinstance(title, str):
        raise HTTPException(400, "title must be string")
    ok = await rename_session(session_id, title)
    if not ok:
        raise HTTPException(404, "session not found")
    return {"ok": True, "session_id": session_id, "title": title.strip()[:80]}


# ---- 停止机制:全局取消表 ----
_CANCEL_EVENTS: dict[str, asyncio.Event] = {}


def _get_cancel_event(session_id: str) -> asyncio.Event:
    ev = _CANCEL_EVENTS.get(session_id)
    if ev is None:
        ev = asyncio.Event()
        _CANCEL_EVENTS[session_id] = ev
    return ev


@app.post("/v1/chat/stop")
async def api_chat_stop(payload: dict = Body(...)):
    sid = (payload or {}).get("session_id", "")
    if not sid:
        raise HTTPException(400, "missing session_id")
    ev = _CANCEL_EVENTS.get(sid)
    if ev and not ev.is_set():
        ev.set()
        return {"ok": True, "stopped": True, "session_id": sid}
    return {"ok": True, "stopped": False, "session_id": sid}


@app.post("/v1/index/build")
async def api_index_build(payload: dict | None = None):
    """建/重建当前工作区所有 root 的向量索引。

    body: { "workspace": "<ws_id 或 目录路径 或 空>", "force": bool(可选) }
    """
    payload = payload or {}
    ws = payload.get("workspace")
    force = bool(payload.get("force", False))
    with use_workspace(ws):
        import anyio
        result = await anyio.to_thread.run_sync(vindex.build_index_all, force)
    return result


@app.get("/v1/index/stats")
async def api_index_stats(workspace: str | None = Query(default=None)):
    with use_workspace(workspace):
        return vindex.stats_all()


@app.post("/v1/index/search")
async def api_index_search(payload: dict):
    ws = payload.get("workspace") if payload else None
    q = (payload or {}).get("query", "")
    top_k = int((payload or {}).get("top_k", 10))
    with use_workspace(ws):
        return vindex.search_all(q, top_k=top_k)


# ============ 多根工作区管理 ============
@app.get("/v1/workspaces")
async def api_list_workspaces():
    from agent.workspaces import load as ws_load
    return {"ok": True, **ws_load()}


@app.put("/v1/workspaces")
async def api_put_workspaces(payload: dict):
    from agent.workspaces import save as ws_save
    return {"ok": True, **ws_save(payload or {})}


@app.post("/v1/chat/stream")
async def api_chat_stream(req: ChatRequest):
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(500, "OPENAI_API_KEY 未配置,请编辑 agent/.env")

    session_id = await ensure_session(req.session_id, workspace=req.workspace)
    history = await load_messages(session_id)
    client = build_client()

    cancel_event = _get_cancel_event(session_id)
    cancel_event.clear()  # 每次新对话都重置

    async def event_stream():
        yield _sse("session", {"session_id": session_id})
        yield _sse("mode", {"mode": req.mode})
        accumulated: list[dict] = []
        try:
            with use_workspace(req.workspace):
                yield _sse("workspace", {"path": str(workspace_root())})
                async for sse_text, new_msgs in run_agent(
                    client, history, req.message,
                    cancel_event=cancel_event,
                    images=req.images,
                    session_id=session_id,
                    mode=req.mode,
                ):
                    if new_msgs:
                        accumulated.extend(new_msgs)
                    yield sse_text
                    if cancel_event.is_set():
                        # run_agent 内部也会 break,这里兜底
                        yield _sse("done", {"reason": "stopped"})
                        break
        except Exception as e:
            yield _sse("error", {"where": "agent", "message": str(e)})
        finally:
            if accumulated:
                await append_messages(session_id, accumulated)
            _CANCEL_EVENTS.pop(session_id, None)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ============================================================
# Debug: LLM API 调用日志(内存 ring buffer,不落盘)
# ============================================================

@app.get("/v1/debug/llm_calls")
async def debug_list_calls():
    return {"entries": debug_log.list_entries()}


@app.delete("/v1/debug/llm_calls")
async def debug_clear_calls():
    n = debug_log.clear()
    return {"cleared": n}


@app.get("/v1/debug/llm_calls/view", response_class=HTMLResponse)
async def debug_view():
    return HTMLResponse(_DEBUG_VIEW_HTML)


@app.get("/v1/debug/llm_calls/{entry_id}")
async def debug_get_call(entry_id: int):
    e = debug_log.get_entry(entry_id)
    if not e:
        raise HTTPException(status_code=404, detail="entry not found")
    return e


_DEBUG_VIEW_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>LLM API 调用日志 - axsl-aiide</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", Consolas, monospace;
         color:#e6e6e6; background:#1e1e1e; height:100vh; display:flex; flex-direction:column; }
  header { padding:8px 12px; background:#252525; border-bottom:1px solid #333;
           display:flex; gap:8px; align-items:center; }
  header h1 { margin:0; font-size:14px; font-weight:600; }
  header .spacer { flex:1; }
  button { background:#0e639c; color:#fff; border:0; padding:5px 12px; border-radius:3px; cursor:pointer; font-size:12px; }
  button:hover { background:#1177bb; }
  button.danger { background:#a33; }
  button.danger:hover { background:#c44; }
  main { flex:1; display:flex; overflow:hidden; }
  .left { width:44%; overflow:auto; border-right:1px solid #333; }
  .right { flex:1; overflow:auto; padding:12px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { padding:6px 8px; border-bottom:1px solid #2a2a2a; text-align:left; white-space:nowrap; }
  th { background:#252525; position:sticky; top:0; z-index:1; font-weight:600; color:#aaa; }
  tbody tr { cursor:pointer; }
  tbody tr:hover { background:#2a2a2a; }
  tbody tr.active { background:#094771 !important; }
  .ok { color:#4ec9b0; } .error { color:#f48771; } .running { color:#dcdcaa; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .muted { color:#888; }
  pre { margin:0; padding:10px; background:#111; border-radius:4px; overflow:auto;
        white-space:pre-wrap; word-break:break-word; font-size:12px; }
  h2 { font-size:13px; margin:14px 0 6px; color:#9cdcfe; }
  h2:first-child { margin-top:0; }
  details { margin:4px 0; }
  summary { cursor:pointer; padding:4px 8px; background:#252525; border-radius:3px; font-weight:600; }
  summary:hover { background:#2f2f2f; }
  .msg { margin:6px 0; padding:8px; border-left:3px solid #444; background:#181818; border-radius:2px; }
  .msg .role { font-weight:600; color:#569cd6; margin-bottom:4px; font-size:11px; text-transform:uppercase; }
  .msg .role.system { color:#c586c0; }
  .msg .role.user { color:#4ec9b0; }
  .msg .role.assistant { color:#dcdcaa; }
  .msg .role.tool { color:#ce9178; }
  .badge { display:inline-block; padding:1px 6px; border-radius:2px; background:#333; color:#ccc; font-size:10px; margin-left:6px; }
  #empty { padding:40px; text-align:center; color:#666; }
</style>
</head>
<body>
<header>
  <h1>🔍 LLM API 调用日志</h1>
  <span class="muted" id="stat"></span>
  <span class="spacer"></span>
  <button onclick="reload()">刷新</button>
  <label class="muted"><input type="checkbox" id="auto" checked> 自动刷新</label>
  <button class="danger" onclick="clearAll()">清空</button>
</header>
<main>
  <div class="left">
    <table>
      <thead><tr>
        <th>#</th><th>时间</th><th>步</th><th>状态</th>
        <th class="num">输入</th><th class="num">缓存</th><th class="num">输出</th>
        <th class="num">耗时</th><th>会话</th>
      </tr></thead>
      <tbody id="list"></tbody>
    </table>
    <div id="empty">暂无记录。发送一次消息后自动出现。</div>
  </div>
  <div class="right" id="detail">
    <p class="muted">点击左侧一条查看完整 request / response。</p>
  </div>
</main>
<script>
let currentId = null;
let timer = null;

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toTimeString().slice(0,8) + '.' + String(d.getMilliseconds()).padStart(3,'0');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function reload() {
  const r = await fetch('/v1/debug/llm_calls');
  const {entries} = await r.json();
  const tbody = document.getElementById('list');
  const empty = document.getElementById('empty');
  document.getElementById('stat').textContent = entries.length + ' 条';
  if (!entries.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = entries.map(e => `
    <tr data-id="${e.id}" class="${e.id===currentId?'active':''}" onclick="showDetail(${e.id})">
      <td>${e.id}</td>
      <td>${fmtTime(e.started_at)}</td>
      <td>${e.step ?? ''}</td>
      <td class="${e.status}">${e.status}</td>
      <td class="num">${e.prompt_tokens ?? '-'}</td>
      <td class="num muted">${e.cached_tokens ?? '-'}</td>
      <td class="num">${e.completion_tokens ?? '-'}</td>
      <td class="num muted">${e.duration_ms != null ? e.duration_ms+'ms' : '-'}</td>
      <td class="muted">${esc((e.session_id||'').slice(0,8))}</td>
    </tr>
  `).join('');
}

async function showDetail(id) {
  currentId = id;
  document.querySelectorAll('#list tr').forEach(tr =>
    tr.classList.toggle('active', +tr.dataset.id === id));
  const r = await fetch('/v1/debug/llm_calls/' + id);
  if (!r.ok) { document.getElementById('detail').innerHTML = '<p class="error">加载失败</p>'; return; }
  const e = await r.json();
  const req = e.request || {}, resp = e.response || {};
  const msgs = req.messages || [];

  const msgsHtml = msgs.map((m, i) => {
    let content = m.content;
    if (Array.isArray(content)) content = content.map(p => p.text || JSON.stringify(p)).join('\\n');
    const tc = m.tool_calls ? `<div class="badge">tool_calls × ${m.tool_calls.length}</div>` : '';
    const name = m.name ? `<span class="badge">${esc(m.name)}</span>` : '';
    let extra = '';
    if (m.tool_calls) {
      extra = '<pre style="margin-top:6px;">' + esc(JSON.stringify(m.tool_calls, null, 2)) + '</pre>';
    }
    return `
      <div class="msg">
        <div class="role ${m.role}">${m.role} #${i}${tc}${name}
          <span class="muted" style="float:right;font-weight:normal;text-transform:none;">${(content||'').length} 字符</span>
        </div>
        <pre>${esc(content || '(空)')}</pre>
        ${extra}
      </div>`;
  }).join('');

  document.getElementById('detail').innerHTML = `
    <h2>基本信息</h2>
    <pre>${esc(JSON.stringify({
      id:e.id, session_id:e.session_id, step:e.step, model:e.model,
      status:e.status, duration_ms:(e.finished_at&&e.started_at)?e.finished_at-e.started_at:null,
      error:e.error,
    }, null, 2))}</pre>
    <h2>Usage</h2>
    <pre>${esc(JSON.stringify(resp.usage || {}, null, 2))}</pre>
    <details ${msgs.length<=6?'open':''}>
      <summary>📥 Request Messages (${msgs.length} 条)</summary>
      <div style="margin-top:8px;">${msgsHtml}</div>
    </details>
    <details>
      <summary>🛠 Tools Schema (${(req.tools||[]).length} 个)</summary>
      <pre>${esc(JSON.stringify(req.tools || [], null, 2))}</pre>
    </details>
    <h2>📤 Response</h2>
    <details open>
      <summary>Assistant Text (${(resp.assistant_text||'').length} 字符)</summary>
      <pre>${esc(resp.assistant_text || '(空)')}</pre>
    </details>
    <details ${(resp.tool_calls||[]).length?'open':''}>
      <summary>Tool Calls (${(resp.tool_calls||[]).length})</summary>
      <pre>${esc(JSON.stringify(resp.tool_calls || [], null, 2))}</pre>
    </details>
  `;
}

async function clearAll() {
  if (!confirm('确定清空所有记录?')) return;
  await fetch('/v1/debug/llm_calls', {method:'DELETE'});
  currentId = null;
  document.getElementById('detail').innerHTML = '<p class="muted">已清空。</p>';
  reload();
}

function tick() {
  if (document.getElementById('auto').checked) reload();
}

reload();
setInterval(tick, 2000);
</script>
</body>
</html>"""


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("AGENT_HOST", "127.0.0.1"),
        port=int(os.getenv("AGENT_PORT", "8100")),
        reload=False,
    )
