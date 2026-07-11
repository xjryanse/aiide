(function () {
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const chatEl = document.getElementById('chat');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('btn-send');
  const newBtn = document.getElementById('btn-new');
  const modeBar = document.getElementById('mode-bar');
  const modeBtns = modeBar ? Array.from(modeBar.querySelectorAll('.mode-btn')) : [];

  let currentAssistantBody = null;
  let sessionId = null;

  // ---- 对话模式 (ask/agent/debug) ----
  const MODE_LABEL = { ask: 'Ask', agent: 'Agent', debug: 'Debug' };
  const MODE_PLACEHOLDER = {
    ask:   '💬 Ask 模式:只做问答、Review、解释,不修改文件 (Ctrl+Enter 发送)',
    agent: '🤖 Agent 模式:让它自主完成编码任务 (Ctrl+Enter 发送)',
    debug: '🐞 Debug 模式:告诉它 bug 现象/复现步骤,它会定位并修复 (Ctrl+Enter 发送)',
  };
  // 从 vscode webview 的 state 里读取上次的选择,默认 agent
  const savedState = (vscode.getState && vscode.getState()) || {};
  let currentMode = ['ask', 'agent', 'debug'].includes(savedState.mode) ? savedState.mode : 'agent';

  function applyMode(mode) {
    if (!['ask', 'agent', 'debug'].includes(mode)) mode = 'agent';
    currentMode = mode;
    modeBtns.forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (inputEl) inputEl.placeholder = MODE_PLACEHOLDER[mode] || '';
    try { vscode.setState({ ...(vscode.getState && vscode.getState() || {}), mode }); } catch (_) {}
  }

  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mode;
      if (m === currentMode) return;
      applyMode(m);
      // 可视化提示:切换模式时插入一条系统提示
      const div = document.createElement('div');
      div.className = 'msg system mode-switch';
      div.innerHTML = `<div class="role">mode</div><div class="body">已切换到 <b>${esc(MODE_LABEL[m])}</b> 模式</div>`;
      chatEl.appendChild(div);
      scrollBottom();
    });
  });
  applyMode(currentMode);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function scrollBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function addMsg(role, text, extraCls) {
    const div = document.createElement('div');
    div.className = 'msg ' + role + (extraCls ? ' ' + extraCls : '');
    div.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
    div.querySelector('.body').textContent = text || '';
    chatEl.appendChild(div);
    scrollBottom();
    return div;
  }

  function addToolCall(name, args) {
    const div = document.createElement('div');
    div.className = 'msg tool';
    const short = args && args.length > 160 ? args.slice(0, 160) + '…' : (args || '');
    div.innerHTML = `<div class="role">tool call</div>
      <div class="tool-call-line">→ ${esc(name)}(<code>${esc(short)}</code>)</div>`;
    chatEl.appendChild(div);
    scrollBottom();
  }

  function addToolResult(name, result) {
    const div = document.createElement('div');
    div.className = 'msg tool';
    const ok = result && result.ok !== false;
    const badge = ok ? '<span class="badge ok">ok</span>' : '<span class="badge err">error</span>';

    // 展开 JSON 时,把可能很长的 old_content / new_content 剥离掉,避免刷屏
    let displayResult = result;
    const hasDiff = result && typeof result.old_content === 'string' && typeof result.new_content === 'string';
    if (hasDiff) {
      displayResult = {};
      for (const k of Object.keys(result)) {
        if (k === 'old_content' || k === 'new_content') continue;
        displayResult[k] = result[k];
      }
      displayResult._diff_content_hidden = true;
    }
    const pretty = JSON.stringify(displayResult, null, 2);

    let extra = '';
    if (result && result.path && (name === 'write_file' || name === 'read_file' || name === 'apply_patch')) {
      extra = ` · <span class="file-link" data-path="${esc(result.path)}">${esc(result.path)}</span>`;
    }

    // 再次打开 diff 视图的按钮
    let diffBar = '';
    if (hasDiff && !result.diff_too_large) {
      const tag = result.is_new_file ? '<span class="badge ok" style="margin-left:6px">新增文件</span>' : '';
      diffBar = `<div class="tool-diff-bar">
        <button class="btn-diff">📝 打开对比视图</button>${tag}
      </div>`;
    } else if (result && result.diff_too_large) {
      diffBar = `<div class="tool-diff-bar"><span class="badge err">文件过大,已跳过 diff</span></div>`;
    }

    div.innerHTML = `<div class="role">tool result · ${esc(name)} ${badge}${extra}</div>
      ${diffBar}
      <details ${ok ? '' : 'open'}>
        <summary>展开输出(${pretty.length} 字符)</summary>
        <pre>${esc(pretty)}</pre>
      </details>`;
    div.querySelectorAll('.file-link').forEach((el) => {
      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'openFile', path: el.getAttribute('data-path') });
      });
    });
    const diffBtn = div.querySelector('.btn-diff');
    if (diffBtn && hasDiff) {
      diffBtn.addEventListener('click', () => {
        vscode.postMessage({
          type: 'openDiff',
          path: result.path,
          oldContent: result.old_content,
          isNewFile: !!result.is_new_file,
        });
      });
    }
    chatEl.appendChild(div);
    scrollBottom();
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + (cls || '');
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    sendBtn.disabled = true;
    currentAssistantBody = null;
    vscode.postMessage({ type: 'send', text, mode: currentMode });
  }

  sendBtn.addEventListener('click', send);
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (evt) => {
    const m = evt.data;
    switch (m.type) {
      case 'status':
        if (m.ok) {
          const info = m.info || {};
          setStatus(`✓ ${info.model || '?'} · ${info.base_url || m.base}`, 'ok');
        } else {
          setStatus(`✗ Agent 不可达: ${m.error || ''}`, 'err');
        }
        break;
      case 'session':
        sessionId = m.sessionId;
        break;
      case 'sessionReset':
        sessionId = null;
        chatEl.innerHTML = '';
        break;
      case 'workspaceInfo':
        setStatus(`workspace: ${m.path}`, 'ok');
        break;
      case 'userMsg': {
        const el = addMsg('user', m.text);
        const mode = m.mode && MODE_LABEL[m.mode] ? m.mode : null;
        if (mode) {
          const badge = document.createElement('span');
          badge.className = 'mode-badge mode-' + mode;
          badge.textContent = MODE_LABEL[mode];
          const roleEl = el.querySelector('.role');
          if (roleEl) roleEl.appendChild(badge);
        }
        break;
      }
      case 'assistantMsg':
        addMsg(m.role || 'assistant', m.text || '');
        break;
      case 'assistantDelta':
        if (!currentAssistantBody) {
          const el = addMsg('assistant', '');
          currentAssistantBody = el.querySelector('.body');
        }
        currentAssistantBody.textContent += m.text || '';
        scrollBottom();
        break;
      case 'assistantEnd':
        currentAssistantBody = null;
        break;
      case 'toolCall':
        addToolCall(m.name, m.args);
        break;
      case 'toolResult':
        addToolResult(m.name, m.result);
        break;
      case 'done':
        break;
      case 'turnEnd':
        sendBtn.disabled = false;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
