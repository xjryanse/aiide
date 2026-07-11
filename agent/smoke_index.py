"""向量索引 smoke test。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent.tools.sandbox import use_workspace
from agent.indexer import indexer

WS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))
print(f"[test] workspace = {WS}", flush=True)

with use_workspace(WS):
    print("[test] step1: 首次建索引(会下载/加载模型,首次较慢)...", flush=True)
    r = indexer.build_index(WS, force=True)
    print(f"[test] build result: {r}", flush=True)
    if not r.get("ok"):
        sys.exit(1)

    print("[test] step2: stats...", flush=True)
    print(indexer.stats(WS), flush=True)

    print("[test] step3: 语义搜索测试", flush=True)
    for q in ["Markdown 渲染", "SSE 事件解析", "workspace 切换按钮", "读取文件预览"]:
        res = indexer.search(WS, q, top_k=3)
        print(f"\n--- query: {q!r} ---", flush=True)
        for h in (res.get("hits") or []):
            print(f"  score={h.get('score')} {h.get('file')}:{h.get('start_line')}-{h.get('end_line')}", flush=True)

print("\n[test] DONE", flush=True)
sys.stdout.flush()
os._exit(0)
