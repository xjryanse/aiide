"""离线冒烟测试:直接调用 Agent 内部工具与沙箱,不依赖 LLM。

覆盖:
  1. sandbox.use_workspace + resolve_safe
  2. fs.write_file / read_file / list_dir / apply_patch
  3. shell.run_shell(cross-platform:python --version)
  4. tools.dispatch(name, args_json) —— 模拟 LLM 传参的入口
  5. storage.db 会话读写
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

os.environ.setdefault("STORAGE_DIR", str(HERE.parent / "storage"))


async def main() -> int:
    from agent.tools import dispatch
    from agent.tools.sandbox import use_workspace, workspace_root
    from storage.db import (
        append_messages,
        create_session,
        init_db,
        load_messages,
    )

    tmp = Path(tempfile.mkdtemp(prefix="aiide-smoke-"))
    print(f"[setup] temp workspace = {tmp}")

    failures: list[str] = []

    def check(name: str, cond: bool, extra: str = "") -> None:
        mark = "[OK]" if cond else "[FAIL]"
        print(f"  {mark} {name}{(' - ' + extra) if extra else ''}")
        if not cond:
            failures.append(name)

    with use_workspace(tmp):
        assert workspace_root() == tmp
        print(f"[T1] sandbox.use_workspace 生效  root={workspace_root()}")

        print("\n[T2] write_file")
        r = json.loads(await dispatch("write_file", json.dumps({
            "path": "hello.txt", "content": "hello axsl-aiide\n"
        })))
        check("write ok", r.get("ok") is True, str(r))
        check("bytes_written > 0", r.get("bytes_written", 0) > 0)

        print("\n[T3] list_dir")
        r = json.loads(await dispatch("list_dir", json.dumps({"path": "."})))
        names = [e["name"] for e in r.get("entries", [])]
        check("hello.txt in listing", "hello.txt" in names, str(names))

        print("\n[T4] read_file")
        r = json.loads(await dispatch("read_file", json.dumps({"path": "hello.txt"})))
        check("content match", r.get("content", "").strip() == "hello axsl-aiide")

        print("\n[T5] apply_patch")
        r = json.loads(await dispatch("apply_patch", json.dumps({
            "path": "hello.txt",
            "old_string": "hello axsl-aiide",
            "new_string": "hi axsl-aiide agent",
        })))
        check("patch ok", r.get("ok") is True, str(r))
        r = json.loads(await dispatch("read_file", json.dumps({"path": "hello.txt"})))
        check("patched content", "hi axsl-aiide agent" in r.get("content", ""))

        print("\n[T6] sandbox 越权拒绝")
        r = json.loads(await dispatch("read_file", json.dumps({"path": "../../etc/passwd"})))
        check("reject path traversal", r.get("ok") is False, r.get("error", ""))

        print("\n[T7] run_shell (python --version)")
        r = json.loads(await dispatch("run_shell", json.dumps({
            "command": "python --version"
        })))
        out = (r.get("stdout") or "") + (r.get("stderr") or "")
        check("shell ok", r.get("ok") is True, f"exit={r.get('exit_code')}")
        check("python version in output", "Python" in out, out.strip()[:80])

        print("\n[T8] run_shell 危险命令拒绝")
        r = json.loads(await dispatch("run_shell", json.dumps({
            "command": "shutdown /s /t 0"
        })))
        check("reject dangerous", r.get("ok") is False, r.get("error", ""))

        print("\n[T9] run_shell 超时")
        r = json.loads(await dispatch("run_shell", json.dumps({
            "command": "ping 127.0.0.1 -n 20", "timeout": 1
        })))
        check("timeout kills", "超时" in (r.get("error") or ""), r.get("error", ""))

    print("\n[T10] storage: session + messages roundtrip")
    await init_db()
    sid = await create_session(title="smoke")
    msgs = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    await append_messages(sid, msgs)
    loaded = await load_messages(sid)
    check("messages persisted", loaded == msgs, f"loaded={loaded}")

    print("\n=== 结果 ===")
    if failures:
        print(f"FAIL: {len(failures)} 项 -- {failures}")
        return 1
    print("PASS - 所有离线冒烟测试通过")
    return 0


if __name__ == "__main__":
    code = asyncio.run(main())
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
