/* ============ DOM refs ============ */
const chatEl = document.getElementById('chat');
const chatInner = document.getElementById('chat-inner');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('btn-send');
const clearBtn = document.getElementById('btn-clear');
const refreshBtn = document.getElementById('btn-refresh');
const fullscreenBtn = document.getElementById('btn-fullscreen');
const pageFullscreenBtn = document.getElementById('btn-page-fullscreen');
const sessionEl = document.getElementById('session-id');
const treeEl = document.getElementById('file-tree');
const healthEl = document.getElementById('health');
const historyEl = document.getElementById('history-list');
const historyRefreshBtn = document.getElementById('btn-history-refresh');
const historySearchInput = document.getElementById('history-search-input');
const stopBtn = document.getElementById('btn-stop');
const attachBtn = document.getElementById('btn-attach');
const fileInput = document.getElementById('file-input');
const attachPreview = document.getElementById('attach-preview');
const composerEl = document.querySelector('.composer');
const previewTitle = document.getElementById('preview-title');
const previewContent = document.getElementById('preview-content');
const closePreviewBtn = document.getElementById('btn-close-preview');
const appEl = document.querySelector('.app');
const wsSelect = document.getElementById('ws-select');
const wsManageBtn = document.getElementById('btn-ws-manage');
const wsOpenBtn = document.getElementById('btn-ws-open');
const indexBtn = document.getElementById('btn-index');
const indexStatusEl = document.getElementById('index-status');
const usageEl = document.getElementById('usage-stat');

const LS_WS_KEY = 'axsl.ws';
const LS_TABS_KEY = 'axsl.tabs.v1';   // 打开的 tab 列表 [{sid, ws, title}]
const LS_ACTIVE_TAB_KEY = 'axsl.activeTab';
const MAX_TABS = 8;

/* ============ Tab bar DOM refs ============ */
const tabListEl = document.getElementById('tab-list');
const tabNewBtn = document.getElementById('btn-tab-new');

/* ============ Tab 管理 ============
 * 每个 tab 独立持有:
 *   id            前端唯一 id (随机)
 *   sessionId     后端 session_id (发送前 null, 发送后由后端赋值)
 *   workspace     该 tab 的 workspace 目录
 *   title         历史项标题(动态更新)
 *   panelEl       消息容器 div.tab-panel(挂在 chatInner 下)
 *   itemEl        tab bar 上的按钮
 *   currentAsst   { el, body, buffer, timer } | null  当前正在渲染的 assistant 消息
 *   currentAbort  AbortController | null              流的 abort 控制器
 *   sendingSid    string | null                       正在跑的 session_id (用于 stop)
 *   usageAgg      { prompt, cached, completion, total, steps }
 *   attachments   本 tab 待发送的图片
 *   unread        非活动状态下收到新事件计数
 */
const tabs = [];
let activeTab = null;

// ---- 对话模式 (ask / agent / debug) ----
const MODE_LABEL = { ask: 'Ask', agent: 'Agent', debug: 'Debug' };
const MODE_PLACEHOLDER = {
  ask:   '💬 Ask · 只做问答、Review、方案讨论,不修改任何文件。可粘贴 / 拖拽 / 点 📎 添加图片。',
  agent: '🤖 Agent · 智能修改:自主使用全部工具完成编码任务。可粘贴 / 拖拽 / 点 📎 添加图片。',
  debug: '🐞 Debug · 修复 Bug:先描述现象/复现步骤,它会定位根因并最小改动修复。',
};
const MODE_HINT = {
  ask:   '只读模式:后端已禁用写入/执行工具',
  agent: '完整工具集:读 · 写 · 执行',
  debug: 'Bug 修复:根因分析 + 最小改动 + 自动验证',
};

function normalizeMode(m) {
  return (m === 'ask' || m === 'debug') ? m : 'agent';
}

function syncModeBarUI(mode) {
  mode = normalizeMode(mode);
  const bar = document.getElementById('mode-bar');
  if (bar) {
    bar.querySelectorAll('.mode-btn').forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
  const inp = document.getElementById('input');
  if (inp) inp.placeholder = MODE_PLACEHOLDER[mode] || '';
  const hint = document.getElementById('mode-hint');
  if (hint) hint.textContent = MODE_HINT[mode] || '';
}

function setTabMode(tab, mode, opts = {}) {
  const next = normalizeMode(mode);
  const prev = tab.mode || 'agent';
  tab.mode = next;
  persistTabs();
  if (tab === activeTab) syncModeBarUI(next);
  // 可视化提示:除非 silent,否则在聊天区插一条模式切换提示
  if (!opts.silent && prev !== next) {
    try {
      const chat = tab.panelEl;
      if (chat) {
        const div = document.createElement('div');
        div.className = 'msg system mode-switch';
        div.innerHTML = `<div class="body">已切换到 <b>${MODE_LABEL[next]}</b> 模式 · ${MODE_HINT[next] || ''}</div>`;
        chat.appendChild(div);
        chat.scrollTop = chat.scrollHeight;
      }
    } catch (_) {}
  }
}

function genTabId() {
  return 't_' + Math.random().toString(36).slice(2, 10);
}

function createTab({ sessionId: sid = null, workspace: ws = '', title = '新会话', activate = true, mode = 'agent' } = {}) {
  if (tabs.length >= MAX_TABS) {
    alert(`最多同时打开 ${MAX_TABS} 个标签页，请先关闭一些。`);
    return null;
  }
  const tab = {
    id: genTabId(),
    sessionId: sid,
    workspace: ws || localStorage.getItem(LS_WS_KEY) || '',
    title,
    panelEl: null,
    itemEl: null,
    currentAsst: null,
    currentAbort: null,
    sendingSid: null,
    usageAgg: { prompt: 0, cached: 0, completion: 0, total: 0, steps: 0 },
    attachments: [],
    unread: 0,
    mode: (mode === 'ask' || mode === 'debug') ? mode : 'agent',  // 对话模式: ask / agent / debug
    userMsgs: [],   // 本 tab 内已发送的用户消息 [{id, text, ts, turnId, images}]
    fileChanges: [], // 本次会话文件改动 [{turnId, path, kind:'added'|'modified'|'deleted', diffId, ts}]
    turnCounter: 0, // 用户消息计数(用作 turnId)
    currentTurnId: 0, // 当前对话轮次(收工具结果时归到这一轮)
  };
  // 消息面板
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.tabId = tab.id;
  chatInner.appendChild(panel);
  tab.panelEl = panel;
  // tab 按钮
  tab.itemEl = renderTabItem(tab);
  tabListEl.appendChild(tab.itemEl);
  tabs.push(tab);
  if (activate) activateTab(tab);
  persistTabs();
  return tab;
}

function renderTabItem(tab) {
  const item = document.createElement('div');
  item.className = 'tab-item';
  item.dataset.tabId = tab.id;
  item.innerHTML = `
    <span class="tab-title"></span>
    <span class="tab-ws"></span>
    <span class="tab-badge" style="display:none"></span>
    <button class="tab-close" title="关闭标签页">×</button>
  `;
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    activateTab(tab);
  });
  item.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  updateTabItem(tab, item);
  return item;
}

function updateTabItem(tab, item) {
  item = item || tab.itemEl;
  if (!item) return;
  const t = (tab.title || '新会话').trim() || '新会话';
  item.querySelector('.tab-title').textContent = t;
  const wsShort = tab.workspace ? tab.workspace.split(/[\\/]/).filter(Boolean).slice(-1)[0] || tab.workspace : '';
  item.querySelector('.tab-ws').textContent = wsShort ? '· ' + wsShort : '';
  item.title = (tab.workspace || '(未设置 workspace)') + '\n' + t;
  const badge = item.querySelector('.tab-badge');
  if (tab.unread > 0 && activeTab !== tab) {
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
  item.classList.toggle('running', !!tab.sendingSid);
}

function activateTab(tab) {
  if (!tab || activeTab === tab) return;
  const prev = activeTab;
  activeTab = tab;
  tab.unread = 0;
  // 隐藏所有 panel
  for (const t of tabs) {
    if (t.panelEl) t.panelEl.classList.toggle('active', t === tab);
    if (t.itemEl) t.itemEl.classList.toggle('active', t === tab);
  }
  // 同步 UI(workspace 输入框、session 显示、附件、按钮状态)
  syncActiveTabUI();
  if (prev) updateTabItem(prev);
  updateTabItem(tab);
  markActiveHistory(tab.sessionId);
  scrollBottom(true);
  persistActiveTab();
  // 若树当前对应的 workspace 与激活 tab 不一致 → 重刷树 + 索引状态
  const treeWs = treeEl.dataset.ws || '';
  const wantWs = tab.workspace || '';
  if (treeWs !== wantWs) {
    currentPath = '';
    loadTree('');
    refreshIndexStatus();
  }
}

function syncActiveTabUI() {
  if (!activeTab) return;
  workspace = activeTab.workspace || '';   // 保持旧的全局变量语义(工具/文件树用)
  if (wsSelect) {
    const opt = Array.from(wsSelect.options).find(o => o.value === workspace);
    if (opt) wsSelect.value = workspace;
  }
  sessionId = activeTab.sessionId;         // 兼容旧代码
  if (sessionEl) sessionEl.textContent = activeTab.sessionId || '(未开始)';
  renderUsage();
  updateAttachPreview();
  setSending(!!activeTab.sendingSid);
  syncModeBarUI(activeTab.mode);
  renderPlanPanel();
  renderUserMsgList();
  renderChangesPanel();
}

async function closeTab(tab) {
  if (tab.sendingSid) {
    if (!confirm(`标签页「${tab.title || '会话'}」还在运行中，确认关闭并中止？`)) return;
    try { await stopTab(tab); } catch (_) {}
  }
  const idx = tabs.indexOf(tab);
  if (idx < 0) return;
  // 从 DOM 移除
  if (tab.panelEl) tab.panelEl.remove();
  if (tab.itemEl) tab.itemEl.remove();
  tabs.splice(idx, 1);
  persistTabs();
  if (activeTab === tab) {
    activeTab = null;
    const next = tabs[idx] || tabs[idx - 1] || tabs[0];
    if (next) {
      activateTab(next);
    } else {
      // 没标签了 -> 自动开一个新空白 tab
      createTab({ workspace: tab.workspace, activate: true });
    }
  }
}

function persistTabs() {
  try {
    const data = tabs.map(t => ({ sid: t.sessionId, ws: t.workspace, title: t.title, mode: t.mode }));
    localStorage.setItem(LS_TABS_KEY, JSON.stringify(data));
  } catch (_) {}
}
function persistActiveTab() {
  try {
    if (activeTab) {
      const idx = tabs.indexOf(activeTab);
      if (idx >= 0) localStorage.setItem(LS_ACTIVE_TAB_KEY, String(idx));
    }
  } catch (_) {}
}
function loadPersistedTabs() {
  try {
    const raw = localStorage.getItem(LS_TABS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) || [];
  } catch (_) { return []; }
}

/* ============ 兼容旧代码的全局变量(始终指向 activeTab) ============ */
let sessionId = null;
let currentPath = '';
let workspace = localStorage.getItem(LS_WS_KEY) || '';
// wsSelect 的 option 由 loadWorkspaces() 异步填充, 之后再 sync 一次

/* ============ Token usage 累计(转发到 activeTab.usageAgg) ============ */
function resetUsage(tab) {
  const t = tab || activeTab;
  if (!t) return;
  t.usageAgg.prompt = 0; t.usageAgg.cached = 0;
  t.usageAgg.completion = 0; t.usageAgg.total = 0; t.usageAgg.steps = 0;
  if (t === activeTab) renderUsage();
}
function updateUsage(u, tab) {
  const t = tab || activeTab;
  if (!u || !t) return;
  t.usageAgg.prompt += (u.prompt || 0);
  t.usageAgg.cached += (u.cached || 0);
  t.usageAgg.completion += (u.completion || 0);
  t.usageAgg.total += (u.total || 0);
  t.usageAgg.steps += 1;
  if (t === activeTab) renderUsage();
}
function renderUsage() {
  if (!usageEl) return;
  const u = activeTab ? activeTab.usageAgg : { prompt: 0, cached: 0, completion: 0, total: 0, steps: 0 };
  if (u.total === 0) {
    usageEl.textContent = '○ 尚无调用';
    usageEl.className = 'usage-inline';
    return;
  }
  const hitRate = u.prompt > 0
    ? Math.round(u.cached / u.prompt * 100) + '%'
    : '0%';
  const short =
    '● ' + u.steps + ' 步 · ' +
    '入 ' + u.prompt.toLocaleString() + ' (缓存 ' + hitRate + ')' +
    ' · 出 ' + u.completion.toLocaleString() +
    ' · 计 ' + u.total.toLocaleString();
  usageEl.textContent = short;
  usageEl.title =
    '本次会话累计 Token\n' +
    '步数: ' + u.steps + '\n' +
    '输入: ' + u.prompt.toLocaleString() + '  (缓存 ' + u.cached.toLocaleString() + ' · 命中率 ' + hitRate + ')\n' +
    '输出: ' + u.completion.toLocaleString() + '\n' +
    '合计: ' + u.total.toLocaleString();
  usageEl.className = 'usage-inline ok';
}

/* ============ Markdown 渲染 ============ */
if (window.marked) {
  marked.setOptions({
    gfm: true, breaks: false,
    highlight: (code, lang) => {
      if (window.hljs) {
        try {
          if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
          return hljs.highlightAuto(code).value;
        } catch (_) {}
      }
      return code;
    },
  });
}
function renderMarkdown(src) {
  const raw = String(src || '');
  if (!window.marked) return escapeHtml(raw).replace(/\n/g, '<br>');
  let html = marked.parse(raw);
  if (window.DOMPurify) html = DOMPurify.sanitize(html);
  return html;
}

/* ============ 任务执行计划(左侧全屏面板) ============
 * 从 assistant 输出里提取"## 计划 / ## Plan / ## 阶段..."块,
 * 存到 tab.plan,并在对话全屏模式下渲染到 #plan-panel。
 * 若同一次回复中不含计划块,则保留上一次的计划(避免每步都被清空)。
 */
// 兼容:`## 计划` / `## 📋 计划` / `## 计划:` / `## 计划:` / `## Plan` / `## 阶段 A: 侦察` 等
const PLAN_HEADING_RE = /^\s*#{1,6}\s*(?:📋\s*)?(?:计划|执行计划|任务计划|步骤|Plan|Steps?|Todo|阶段\s*[A-Z0-9]*)\s*[:：]?\s*[^\n]*$/im;

function extractPlan(md) {
  const text = String(md || '');
  if (!text.trim()) return '';
  const lines = text.split(/\r?\n/);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PLAN_HEADING_RE.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';
  // 从计划标题往下收,直到遇到同级或更高级标题
  const startHead = lines[startIdx].match(/^\s*(#{1,6})/);
  const startLevel = startHead ? startHead[1].length : 2;
  const out = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(#{1,6})\s/);
    if (m && m[1].length <= startLevel) break;
    out.push(lines[i]);
  }
  // 去除尾部空行
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

function fmtPlanTime(ts) {
  try {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (_) { return ''; }
}

function renderPlanPanel() {
  const body = document.getElementById('plan-body');
  const sub = document.getElementById('plan-sub');
  if (!body) return;
  const t = activeTab;
  if (sub) sub.textContent = t ? (t.title || '当前会话') : '当前会话';
  const plan = t && t.plan;
  if (!plan || !plan.md) {
    body.innerHTML =
      '<div class="plan-empty">暂无计划。<br><br>' +
      '提交任务后,Agent 会在回复顶部输出 <code>## 计划</code>,<br>' +
      '本区域会自动提取并展示,方便你跟踪进度。</div>';
    return;
  }
  let html = renderMarkdown(plan.md);
  if (plan.updatedAt) {
    html += `<div class="plan-updated">更新于 ${fmtPlanTime(plan.updatedAt)} · 第 ${plan.step || '?'} 步</div>`;
  }
  body.innerHTML = html;
}

/** 渲染左侧"我的消息"清单(只在对话全屏模式下可见,CSS 控制)。 */
function renderUserMsgList() {
  const listEl = document.getElementById('usermsg-body');
  const cntEl = document.getElementById('usermsg-count');
  if (!listEl) return;
  const t = activeTab;
  const arr = (t && Array.isArray(t.userMsgs)) ? t.userMsgs : [];
  if (cntEl) cntEl.textContent = String(arr.length);
  if (arr.length === 0) {
    listEl.innerHTML = '<div class="usermsg-empty">本次对话中你尚未发送消息</div>';
    return;
  }
  // 倒序展示(最新在上),编号仍按发送顺序
  const total = arr.length;
  let html = '';
  for (let i = total - 1; i >= 0; i--) {
    const m = arr[i];
    const raw = (m.text || '').replace(/\s+/g, ' ').trim();
    const imgTag = (m.images && m.images > 0) ? ('[图片×' + m.images + '] ') : '';
    let preview = raw;
    if (!preview && !imgTag) preview = '(空消息)';
    else preview = imgTag + preview;
    if (preview.length > 80) preview = preview.slice(0, 80) + '…';
    const time = fmtPlanTime(m.ts);
    html += '<div class="usermsg-item" data-mid="' + escapeHtmlAttr(m.id) + '" data-turn="' + (m.turnId || 0) + '" title="' + escapeHtmlAttr(imgTag + raw) + '">' +
              '<div class="usermsg-item-head"><span class="usermsg-idx">#' + (i + 1) + '</span>' +
              '<span class="usermsg-time">' + escapeHtml(time) + '</span></div>' +
              '<div class="usermsg-item-text">' + escapeHtml(preview) + '</div>' +
            '</div>';
  }
  listEl.innerHTML = html;
}

/** 节流调度:短时间内多次 push 只合并渲染一次(用于历史回放批量注册时) */
let _userMsgListRafId = 0;
function scheduleRenderUserMsgList() {
  if (_userMsgListRafId) return;
  _userMsgListRafId = requestAnimationFrame(function () {
    _userMsgListRafId = 0;
    try { renderUserMsgList(); } catch (_) {}
  });
}

/** =============================================================
 *  右侧"本次文件改动"清单
 *  ============================================================= */

// 当前筛选的 turnId(null 表示显示全部)
let changesFilterTurn = null;

/** 记录一次文件改动。同一路径的后续改动会合并展示(保留最新的 diffId、更新 ts;
 *  但如果 kind 变化(如 modified → deleted),则以最新为准) */
function recordFileChange(toolName, r, tab) {
  if (!tab || !r) return;
  const path = r.path || r.file;
  if (!path) return;
  let kind = null;
  if (toolName === 'write_file' || toolName === 'apply_patch') {
    kind = (toolName === 'write_file' && r.is_new_file) ? 'added' : 'modified';
  } else if (toolName === 'delete_file' || toolName === 'rm_file' || toolName === 'unlink') {
    kind = 'deleted';
  } else {
    return; // 其它工具不记录
  }
  const list = tab.fileChanges || (tab.fileChanges = []);
  // 若已存在同 path 记录,则合并:
  //   - 之前 added、这次 modified → 仍算 added(新文件的后续修改)
  //   - 之前 added、这次 deleted → 移除(等价于没改)
  //   - 之前 modified、这次 deleted → 保留为 deleted
  //   - 之前 deleted、这次 added/modified → 变成 modified(复活)
  const existingIdx = list.findIndex(function (x) { return x.path === path; });
  if (existingIdx >= 0) {
    const prev = list[existingIdx];
    if (prev.kind === 'added' && kind === 'deleted') {
      list.splice(existingIdx, 1); // 净变化为 0
      if (isActive(tab)) scheduleRenderChangesPanel();
      return;
    }
    let finalKind = kind;
    if (prev.kind === 'added' && kind === 'modified') finalKind = 'added';
    if (prev.kind === 'deleted' && (kind === 'added' || kind === 'modified')) finalKind = 'modified';
    prev.kind = finalKind;
    if (r.__diffId) prev.diffId = r.__diffId;
    // diff 内容以最新为准(供直接打开)
    if (typeof r.old_content === 'string') prev.old_content = r.old_content;
    if (typeof r.new_content === 'string') prev.new_content = r.new_content;
    prev.turnId = tab.currentTurnId || prev.turnId || 0;
    prev.ts = Date.now();
    prev.count = (prev.count | 0) + 1;
  } else {
    list.push({
      path: path,
      kind: kind,
      turnId: tab.currentTurnId || 0,
      diffId: r.__diffId || null,
      old_content: (typeof r.old_content === 'string') ? r.old_content : null,
      new_content: (typeof r.new_content === 'string') ? r.new_content : null,
      is_new_file: !!r.is_new_file,
      ts: Date.now(),
      count: 1,
    });
  }
  if (isActive(tab)) scheduleRenderChangesPanel();
}

/** 渲染右侧改动清单;若 changesFilterTurn 非 null,仅显示该轮次的改动 */
function renderChangesPanel() {
  const listEl = document.getElementById('changes-body');
  const cntEl = document.getElementById('changes-count');
  const hintEl = document.getElementById('changes-filter-hint');
  const clearBtn = document.getElementById('changes-clear-filter');
  if (!listEl) return;
  const t = activeTab;
  const all = (t && Array.isArray(t.fileChanges)) ? t.fileChanges : [];
  const filtered = (changesFilterTurn == null)
    ? all
    : all.filter(function (x) { return x.turnId === changesFilterTurn; });

  if (cntEl) cntEl.textContent = String(filtered.length) + (changesFilterTurn != null ? ' / ' + all.length : '');
  if (clearBtn) clearBtn.hidden = (changesFilterTurn == null);
  if (hintEl) {
    if (changesFilterTurn == null) {
      hintEl.hidden = true; hintEl.textContent = '';
    } else {
      hintEl.hidden = false;
      hintEl.textContent = '正在查看:消息 #' + changesFilterTurn + ' 引发的改动';
    }
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="changes-empty">' +
      (changesFilterTurn == null ? 'Agent 尚未修改任何文件' : '该轮次未修改任何文件') +
      '</div>';
    return;
  }

  const added = [], modified = [], deleted = [];
  filtered.forEach(function (c) {
    if (c.kind === 'added') added.push(c);
    else if (c.kind === 'deleted') deleted.push(c);
    else modified.push(c);
  });

  const renderGroup = function (title, iconCls, arr, kind) {
    if (arr.length === 0) return '';
    const items = arr.map(function (c, idx) {
      const canDiff = (kind === 'modified' || (kind === 'added' && typeof c.new_content === 'string'));
      const clickable = (kind !== 'deleted') || (typeof c.old_content === 'string');
      const cntBadge = (c.count && c.count > 1) ? '<span class="chg-count" title="共修改 ' + c.count + ' 次">×' + c.count + '</span>' : '';
      const turnBadge = (c.turnId ? '<span class="chg-turn" title="来自消息 #' + c.turnId + '">#' + c.turnId + '</span>' : '');
      return '<div class="chg-item ' + kind + (clickable ? '' : ' disabled') + '" ' +
             'data-path="' + escapeHtmlAttr(c.path) + '" ' +
             'data-kind="' + kind + '" ' +
             'data-idx="' + idx + '" ' +
             (canDiff ? 'data-can-diff="1" ' : '') +
             'title="' + escapeHtmlAttr(c.path) + '">' +
               '<span class="chg-icon">' + iconCls + '</span>' +
               '<span class="chg-path">' + escapeHtml(shortenPath(c.path)) + '</span>' +
               turnBadge + cntBadge +
             '</div>';
    }).join('');
    return '<div class="chg-group ' + kind + '">' +
             '<div class="chg-group-head">' + title +
               ' <span class="chg-group-cnt">(' + arr.length + ')</span></div>' +
             '<div class="chg-group-body">' + items + '</div>' +
           '</div>';
  };

  listEl.innerHTML =
      renderGroup('新增', '＋', added, 'added') +
      renderGroup('改动', '✎', modified, 'modified') +
      renderGroup('删除', '🗑', deleted, 'deleted');
}

/** 长路径缩短:保留最后 2~3 段 */
function shortenPath(p) {
  if (!p) return '';
  const s = String(p);
  const parts = s.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return s;
  return '…/' + parts.slice(-3).join('/');
}

let _changesPanelRafId = 0;
function scheduleRenderChangesPanel() {
  if (_changesPanelRafId) return;
  _changesPanelRafId = requestAnimationFrame(function () {
    _changesPanelRafId = 0;
    try { renderChangesPanel(); } catch (_) {}
  });
}

/** 事件委托:点击右侧文件改动项 */
document.addEventListener('click', function (e) {
  // 取消筛选
  const clearBtn = e.target && e.target.closest && e.target.closest('#changes-clear-filter');
  if (clearBtn) {
    changesFilterTurn = null;
    document.querySelectorAll('.usermsg-item.active').forEach(function (n) { n.classList.remove('active'); });
    renderChangesPanel();
    return;
  }
  const item = e.target && e.target.closest && e.target.closest('.chg-item');
  if (!item) return;
  if (item.classList.contains('disabled')) return;
  const path = item.getAttribute('data-path');
  const kind = item.getAttribute('data-kind');
  const t = activeTab;
  const rec = t && (t.fileChanges || []).find(function (x) { return x.path === path; });
  if (!rec) return;
  if (kind === 'modified' || (kind === 'added' && typeof rec.new_content === 'string' && typeof rec.old_content === 'string')) {
    try { openDiffPreview(path, rec.old_content || '', rec.new_content || '', kind === 'added'); return; } catch (_) {}
  }
  if (kind === 'added') {
    // 新增文件没有 old_content,直接看内容
    try { openPreview(path); return; } catch (_) {}
  }
  if (kind === 'deleted' && typeof rec.old_content === 'string') {
    // 删除的文件:展示已删除的旧内容(通过临时 diff 视图,新版为空)
    try { openDiffPreview(path, rec.old_content, '', false); return; } catch (_) {}
  }
});


/** HTML 属性转义(复用现有 escapeHtml,已处理 " ' & < >) */
function escapeHtmlAttr(s) { return escapeHtml(s); }

// 事件委托:点击左侧清单条目 → 滚动定位、高亮、联动右侧文件改动清单按 turnId 过滤
document.addEventListener('click', function (e) {
  const item = e.target && e.target.closest && e.target.closest('.usermsg-item');
  if (!item) return;
  const mid = item.getAttribute('data-mid');
  if (!mid) return;
  const target = document.getElementById(mid);
  if (target) {
    try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { target.scrollIntoView(); }
    // 高亮闪一下
    target.classList.remove('user-msg-flash');
    void target.offsetWidth; // 强制重排以便重放动画
    target.classList.add('user-msg-flash');
    setTimeout(function () { target.classList.remove('user-msg-flash'); }, 1600);
  }
  // 当前选中项样式:再次点击同一项则取消选中并清除筛选
  const wasActive = item.classList.contains('active');
  document.querySelectorAll('.usermsg-item.active').forEach(function (n) { n.classList.remove('active'); });
  if (wasActive) {
    changesFilterTurn = null;
  } else {
    item.classList.add('active');
    const turn = parseInt(item.getAttribute('data-turn'), 10);
    changesFilterTurn = (turn > 0) ? turn : null;
  }
  try { renderChangesPanel(); } catch (_) {}
});

/** 从当前 assistant buffer 中尝试提取计划,并更新 tab.plan */
function updatePlanFromAssistant(tab, buffer, step) {
  const t = targetOf(tab);
  if (!t) return;
  const md = extractPlan(buffer);
  if (!md) return; // 未在本轮回复中找到计划块,保留上一次
  const prev = t.plan && t.plan.md;
  if (prev === md) return; // 内容未变
  t.plan = { md, updatedAt: Date.now(), step: step || (t.plan && t.plan.step) || 1 };
  if (isActive(t)) renderPlanPanel();
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ============ 通用滚动 ============ */
function nearBottom() { return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80; }
function scrollBottom(force) {
  if (force || nearBottom()) chatEl.scrollTop = chatEl.scrollHeight;
}

/* ============ 消息容器构造 ============
 * 所有 addXxx / ensureAsst / finalizeAsst 都接收可选 tab 参数;
 * 若不传则默认 activeTab。这样 SSE 事件可以定向到"发起时的那个 tab"，
 * 就算用户已经切走也能继续正确追加消息。
 */
function targetOf(tab) { return tab || activeTab; }
function containerOf(tab) {
  const t = targetOf(tab);
  return (t && t.panelEl) || chatInner;
}
function isActive(tab) { return targetOf(tab) === activeTab; }
function bumpUnread(tab) {
  const t = targetOf(tab);
  if (t && t !== activeTab) { t.unread++; updateTabItem(t); }
}

const ROLE_META = {
  user:      { name: '你',        letter: 'U', sub: '' },
  assistant: { name: 'Assistant', letter: 'A', sub: '' },
  tool:      { name: 'Tool',      letter: 'T', sub: '' },
  error:     { name: 'Error',     letter: '!', sub: '' },
};
function makeMsg(role, subLabel, tab) {
  const meta = ROLE_META[role] || ROLE_META.assistant;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.innerHTML =
    '<div class="msg-head">' +
      '<span class="avatar">' + meta.letter + '</span>' +
      '<span class="name">' + meta.name + '</span>' +
      (subLabel ? '<span class="sub">' + escapeHtml(subLabel) + '</span>' : '') +
    '</div>' +
    '<div class="body"></div>';
  containerOf(tab).appendChild(wrap);
  if (isActive(tab)) scrollBottom(true);
  return wrap;
}
function addUserMsg(text, tab, images) {
  const el = makeMsg('user', '', tab);
  // 给该消息一个稳定的 DOM id,便于左侧"我的消息"清单点击定位
  try {
    if (tab && !el.id) {
      const uid = 'umsg-' + tab.id + '-' + (tab.userMsgs ? tab.userMsgs.length : 0) + '-' + Date.now().toString(36);
      el.id = uid;
      el.classList.add('user-msg-anchor');
      const imgCnt = Array.isArray(images) ? images.length : 0;
      // 推进轮次:后续工具结果归到本轮
      tab.turnCounter = (tab.turnCounter | 0) + 1;
      tab.currentTurnId = tab.turnCounter;
      (tab.userMsgs || (tab.userMsgs = [])).push({
        id: uid,
        text: (text || '').toString(),
        images: imgCnt,
        turnId: tab.currentTurnId,
        ts: Date.now(),
      });
      // 若当前面板可见(全屏 chat 模式),节流刷新左侧清单
      if (isActive(tab)) scheduleRenderUserMsgList();
    }
  } catch (_) {}
  // 在 role 标签上追加当前对话模式徽章(记录本条消息发送时用的模式,便于回顾)
  try {
    const roleEl = el.querySelector('.role');
    const mode = (tab && tab.mode) || 'agent';
    if (roleEl && MODE_LABEL[mode]) {
      const badge = document.createElement('span');
      badge.className = 'mode-badge mode-' + mode;
      badge.textContent = MODE_LABEL[mode];
      roleEl.appendChild(badge);
    }
  } catch (_) {}
  const body = el.querySelector('.body');
  body.className = 'body md user-body';
  // 文本区(左)
  const textWrap = document.createElement('div');
  textWrap.className = 'user-text';
  textWrap.innerHTML = renderMarkdown(text || '');
  body.appendChild(textWrap);
  // 图片区(右)
  const imgs = Array.isArray(images) ? images.filter(u => typeof u === 'string' && u) : [];
  if (imgs.length) {
    const gallery = document.createElement('div');
    gallery.className = 'msg-images';
    imgs.forEach((url, i) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = '点击查看原图 #' + (i + 1);
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'image-' + (i + 1);
      img.loading = 'lazy';
      a.appendChild(img);
      gallery.appendChild(a);
    });
    body.appendChild(gallery);
  }
  return el;
}
function addErrorMsg(text, tab) {
  const el = makeMsg('error', '', tab);
  el.querySelector('.body').textContent = text;
  bumpUnread(tab);
  return el;
}

/* ============ Assistant 流式(节流重渲染) ============ */
function ensureAsstMsg(tab) {
  const t = targetOf(tab);
  if (t && t.currentAsst) return t.currentAsst;
  const el = makeMsg('assistant', '', tab);
  const body = el.querySelector('.body');
  body.className = 'body md typing';
  const a = { el, body, buffer: '', timer: null };
  if (t) t.currentAsst = a;
  return a;
}
function appendAsstDelta(text, tab) {
  const a = ensureAsstMsg(tab);
  a.buffer += text || '';
  if (a.timer) return;
  a.timer = setTimeout(() => {
    a.timer = null;
    a.body.innerHTML = renderMarkdown(a.buffer);
    // 流式过程中,尝试从当前 buffer 里提取"## 计划"并同步到左侧面板
    updatePlanFromAssistant(tab, a.buffer);
    if (isActive(tab)) scrollBottom();
  }, 60);
}
function finalizeAsstMsg(tab) {
  const t = targetOf(tab);
  const a = t && t.currentAsst;
  if (!a) return;
  if (a.timer) { clearTimeout(a.timer); a.timer = null; }
  a.body.innerHTML = renderMarkdown(a.buffer);
  a.body.classList.remove('typing');
  if (window.hljs) {
    a.body.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch(_){} });
  }
  // 本轮 assistant 消息结束时,做一次最终计划提取(覆盖流式期间可能的半截)
  updatePlanFromAssistant(t, a.buffer);
  if (t) t.currentAsst = null;
  if (isActive(tab)) scrollBottom();
  bumpUnread(tab);
}

/* ============ Tool 消息(结构化) ============ */
function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch { return { _raw: String(args) }; }
}
function shortText(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function pathFromArgs(name, a) {
  if (!a) return '';
  return a.path || a.file || a.filename || a.target || '';
}
function addToolCallMsg(name, args, tab) {
  const a = parseArgs(args);
  const p = pathFromArgs(name, a);
  const el = makeMsg('tool', 'call · ' + name, tab);
  const body = el.querySelector('.body');
  body.innerHTML = renderToolCall(name, a, p);
  wireFileLinks(body);
  if (isActive(tab)) scrollBottom();
  bumpUnread(tab);
}
function renderToolCall(name, a, p) {
  let html = '<div class="tool-call-box"><div class="tool-title">' +
    '<span class="tname">' + escapeHtml(name) + '</span>';
  if (p) html += '<span class="targ">→</span><span class="fpath" data-path="' + escapeHtml(p) + '">' + escapeHtml(p) + '</span>';
  html += '</div>';

  const fields = [];
  const skip = new Set(['path','file','filename','target']);
  if (name === 'run_shell' && a.cmd) {
    fields.push(['cmd', shortText(a.cmd, 400)]);
    if (a.cwd) fields.push(['cwd', a.cwd]);
    if (a.timeout) fields.push(['timeout', a.timeout + 's']);
  } else if (name === 'write_file' && typeof a.content === 'string') {
    fields.push(['bytes', a.content.length]);
    fields.push(['preview', shortText(a.content, 200)]);
    skip.add('content');
  } else if (name === 'apply_patch' && a.patch) {
    fields.push(['patch (预览)', shortText(a.patch, 400)]);
    skip.add('patch');
  } else if (name === 'read_file') {
    if (a.max_bytes) fields.push(['max_bytes', a.max_bytes]);
  }
  for (const [k, v] of Object.entries(a)) {
    if (skip.has(k) || k === 'cmd' || k === 'cwd' || k === 'timeout' || k === 'max_bytes') continue;
    fields.push([k, typeof v === 'string' ? shortText(v, 200) : JSON.stringify(v)]);
  }
  if (fields.length) {
    html += '<div class="tool-fields">';
    for (const [k, v] of fields) {
      html += '<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function addToolResultMsg(name, result, tab) {
  const ok = !(result && result.ok === false);
  const el = makeMsg('tool', 'result · ' + name, tab);
  const head = el.querySelector('.msg-head');
  head.insertAdjacentHTML('beforeend',
    '<span class="badge ' + (ok ? 'ok' : 'err') + '">' + (ok ? 'ok' : 'error') + '</span>');
  const body = el.querySelector('.body');
  body.innerHTML = renderToolResult(name, result, ok);
  wireFileLinks(body);
  wireDiffButtons(body);
  // === 记录本次文件改动到右侧"文件改动"清单 ===
  if (ok) { try { recordFileChange(name, result, tab); } catch (_) {} }
  if (isActive(tab)) scrollBottom();
  bumpUnread(tab);
}
function renderToolResult(name, r, ok) {
  const box = ['<div class="tool-result-box">'];
  const p = r && (r.path || r.file);
  if (p) {
    box.push('<div class="tool-title"><span class="tname">' + escapeHtml(name) +
      '</span><span class="targ">→</span><span class="fpath" data-path="' + escapeHtml(p) + '">' +
      escapeHtml(p) + '</span></div>');
  }
  // === diff 按钮:仅当后端返回了 old/new 内容(write_file / apply_patch) ===
  if (r && typeof r.new_content === 'string' && typeof r.old_content === 'string') {
    const diffId = registerDiff(p || '(untitled)', r.old_content, r.new_content, !!r.is_new_file);
    r.__diffId = diffId;
    const tag = r.is_new_file ? '<span class="diff-tag new">新增文件</span>' : '';
    box.push('<div class="tool-diff-bar">' + tag +
      '<button class="btn-diff" data-diff-id="' + diffId + '">📝 查看变更 (左右对比)</button>' +
      '</div>');
  } else if (r && r.diff_too_large) {
    box.push('<div class="tool-diff-bar"><span class="diff-tag warn">文件过大,已跳过 diff 展示</span></div>');
  }
  // 关键字段摘要
  const summary = [];
  if (r) {
    if (typeof r.exit_code === 'number') summary.push(['exit', r.exit_code]);
    if (typeof r.bytes === 'number') summary.push(['bytes', r.bytes]);
    if (typeof r.bytes_written === 'number') summary.push(['bytes_written', r.bytes_written]);
    if (typeof r.replaced === 'number') summary.push(['replaced', r.replaced]);
    if (typeof r.truncated === 'boolean' && r.truncated) summary.push(['truncated', 'yes']);
    if (r.error) summary.push(['error', shortText(r.error, 200)]);
  }
  if (summary.length) {
    box.push('<div class="tool-fields">');
    for (const [k, v] of summary) box.push('<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>');
    box.push('</div>');
  }
  // stdout/stderr 或整体 JSON
  if (r && (r.stdout || r.stderr)) {
    if (r.stdout) box.push(streamBlock('stdout', r.stdout));
    if (r.stderr) box.push(streamBlock('stderr', r.stderr));
  } else {
    // 折叠展开完整 JSON 时,不要把可能很大的 old/new_content 也塞进去(否则页面爆炸)
    const rDisplay = r;
    let pretty;
    if (r && (typeof r.old_content === 'string' || typeof r.new_content === 'string')) {
      const slim = {};
      for (const k of Object.keys(r)) {
        if (k === 'old_content' || k === 'new_content') continue;
        slim[k] = r[k];
      }
      slim._diff_content_hidden = true;
      pretty = JSON.stringify(slim, null, 2);
    } else {
      pretty = JSON.stringify(rDisplay, null, 2);
    }
    box.push('<details ' + (ok ? '' : 'open') + '><summary>展开完整结果 (' + pretty.length + ' 字符)</summary>' +
      '<pre>' + escapeHtml(pretty) + '</pre></details>');
  }
  box.push('</div>');
  return box.join('');
}
function streamBlock(label, text) {
  const t = String(text || '');
  return '<details ' + (label === 'stderr' && t ? 'open' : '') + '>' +
    '<summary>' + label + ' (' + t.length + ' 字符)</summary>' +
    '<pre>' + escapeHtml(t) + '</pre></details>';
}
function wireFileLinks(root) {
  root.querySelectorAll('.fpath').forEach(el => {
    el.addEventListener('click', () => openPreview(el.getAttribute('data-path')));
  });
}

/* ============ Diff 视图 ============ */
// 存放每次工具调用产生的 old/new 内容,按 id 索引,避免把大字符串塞进 DOM 属性
const _diffStore = new Map();
let _diffSeq = 0;
function registerDiff(path, oldText, newText, isNew) {
  const id = 'd' + (++_diffSeq);
  _diffStore.set(id, { path, oldText: oldText || '', newText: newText || '', isNew: !!isNew });
  return id;
}
function wireDiffButtons(root) {
  root.querySelectorAll('.btn-diff').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-diff-id');
      const d = _diffStore.get(id);
      if (d) openDiffPreview(d.path, d.oldText, d.newText, d.isNew);
    });
  });
}

/**
 * 计算两个字符串的行级 diff(LCS 简化版:先按行 split,再算最长公共子序列,
 * 遍历回溯得到每一行的状态: equal / add / del)。
 * 返回左右两列的行数组:
 *   left  = [{type:'equal'|'del'|'empty', lineNo, text}]
 *   right = [{type:'equal'|'add'|'empty', lineNo, text}]
 * 对齐后 left.length === right.length,同一下标是一对。
 */
function computeSideBySideDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;
  // LCS 表(n,m 都不大时用二维数组;超过 4000×4000 就走朴素回退)
  if (n * m > 4_000_000) {
    // 太大直接顺序对齐,不算 LCS(退化为"整体删+整体加")
    const L = a.map((t, i) => ({ type: 'del', lineNo: i + 1, text: t }));
    const R = b.map((t, i) => ({ type: 'add', lineNo: i + 1, text: t }));
    const maxLen = Math.max(L.length, R.length);
    while (L.length < maxLen) L.push({ type: 'empty', lineNo: '', text: '' });
    while (R.length < maxLen) R.push({ type: 'empty', lineNo: '', text: '' });
    return { left: L, right: R };
  }
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯
  const ops = []; // {op:'eq'|'del'|'add', aIdx?, bIdx?}
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.push({ op: 'eq', aIdx: i - 1, bIdx: j - 1 }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push({ op: 'del', aIdx: i - 1 }); i--; }
    else { ops.push({ op: 'add', bIdx: j - 1 }); j--; }
  }
  while (i > 0) { ops.push({ op: 'del', aIdx: i - 1 }); i--; }
  while (j > 0) { ops.push({ op: 'add', bIdx: j - 1 }); j--; }
  ops.reverse();

  // 按顺序把 del/add 尽量配对成"改动行"(同一行显示成左删右加)
  const left = [], right = [];
  let k = 0;
  while (k < ops.length) {
    const o = ops[k];
    if (o.op === 'eq') {
      left.push({ type: 'equal', lineNo: o.aIdx + 1, text: a[o.aIdx] });
      right.push({ type: 'equal', lineNo: o.bIdx + 1, text: b[o.bIdx] });
      k++;
    } else {
      // 收集连续的 del / add 段
      const dels = [], adds = [];
      while (k < ops.length && ops[k].op === 'del') { dels.push(ops[k].aIdx); k++; }
      while (k < ops.length && ops[k].op === 'add') { adds.push(ops[k].bIdx); k++; }
      const pairs = Math.max(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) {
        if (p < dels.length) left.push({ type: 'del', lineNo: dels[p] + 1, text: a[dels[p]] });
        else left.push({ type: 'empty', lineNo: '', text: '' });
        if (p < adds.length) right.push({ type: 'add', lineNo: adds[p] + 1, text: b[adds[p]] });
        else right.push({ type: 'empty', lineNo: '', text: '' });
      }
    }
  }
  return { left, right };
}

function openDiffPreview(path, oldText, newText, isNew) {
  const { left, right } = computeSideBySideDiff(oldText, newText);
  let addCount = 0, delCount = 0;
  for (const r of right) if (r.type === 'add') addCount++;
  for (const l of left) if (l.type === 'del') delCount++;

  const titleHtml = '📝 文件变更 · <span style="color:#9ca3af">' + escapeHtml(path) + '</span> ' +
    '<span class="diff-stat"><span class="add">+' + addCount + '</span> <span class="del">−' + delCount + '</span></span>' +
    (isNew ? ' <span class="diff-tag new">新增文件</span>' : '');

  const wrap = document.createElement('div');
  wrap.className = 'diff-wrap';
  wrap.innerHTML =
    '<div class="diff-head">' +
      '<div class="diff-side-title">修改前 (old)</div>' +
      '<div class="diff-side-title">修改后 (new)</div>' +
    '</div>' +
    '<div class="diff-body">' +
      '<div class="diff-col diff-left"></div>' +
      '<div class="diff-col diff-right"></div>' +
    '</div>';
  const leftEl = wrap.querySelector('.diff-left');
  const rightEl = wrap.querySelector('.diff-right');
  const rowsHtml = (arr) => arr.map(row => {
    const cls = 'diff-row diff-' + row.type;
    const marker = row.type === 'add' ? '+' : row.type === 'del' ? '−' : row.type === 'empty' ? '' : ' ';
    return '<div class="' + cls + '">' +
      '<span class="diff-ln">' + (row.lineNo || '') + '</span>' +
      '<span class="diff-mk">' + marker + '</span>' +
      '<span class="diff-tx">' + escapeHtml(row.text || '') + '</span>' +
      '</div>';
  }).join('');
  leftEl.innerHTML = rowsHtml(left);
  rightEl.innerHTML = rowsHtml(right);

  // 滚动同步
  let syncing = false;
  const syncScroll = (src, dst) => {
    if (syncing) return;
    syncing = true; dst.scrollTop = src.scrollTop; dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => { syncing = false; });
  };
  leftEl.addEventListener('scroll', () => syncScroll(leftEl, rightEl));
  rightEl.addEventListener('scroll', () => syncScroll(rightEl, leftEl));

  showDiffModal(titleHtml, wrap);
}

/** 复用式 diff 模态: 首次调用时创建, 后续复用同一个容器 */
function showDiffModal(titleHtml, bodyEl) {
  let modal = document.getElementById('diff-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'diff-modal';
    modal.className = 'diff-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="diff-backdrop" data-close="1"></div>' +
      '<div class="diff-dialog" role="dialog" aria-modal="true">' +
        '<header class="diff-modal-head">' +
          '<div class="diff-modal-title"></div>' +
          '<button class="diff-modal-close" data-close="1" title="关闭 (Esc)">×</button>' +
        '</header>' +
        '<div class="diff-modal-body"></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => {
      if (e.target.dataset && e.target.dataset.close === '1') modal.hidden = true;
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });
  }
  modal.querySelector('.diff-modal-title').innerHTML = titleHtml;
  const body = modal.querySelector('.diff-modal-body');
  body.innerHTML = '';
  body.appendChild(bodyEl);
  modal.hidden = false;
}

/* ============ 健康/文件树/预览 ============ */
async function checkHealth() {
  try {
    const r = await fetch('api/chat.php?action=health');
    const j = await r.json();
    if (j.ok) {
      healthEl.textContent = '● 模型: ' + j.model;
      healthEl.className = 'health ok';
    } else throw new Error('unhealthy');
  } catch (e) {
    healthEl.textContent = '● Agent 服务不可达';
    healthEl.className = 'health err';
  }
}
function filesUrl(params) {
  const p = new URLSearchParams(params);
  // params 里如果显式给了 root(绝对路径),优先用它;否则回落到 workspace 字符串
  if (!p.get('root') && workspace) p.set('root', workspace);
  return 'api/files.php?' + p.toString();
}
// 记住已展开的目录路径,刷新后自动恢复。key 格式: "<rootAbs>::<rel>"
const _expandedDirs = new Set();

/** 根据当前 workspace(id) 从 ws-select 对应的 state 里拿到 roots 列表(绝对路径)。*/
function _currentRoots() {
  // 首选:从 ws-select 拿真实 state (在 initWorkspaces 里已缓存到 window.__wsState)
  try {
    const s = window.__wsState;
    if (s && s.workspaces) {
      const wid = wsSelect && wsSelect.value;
      const w = s.workspaces.find(x => x.id === wid);
      if (w && (w.roots || []).length) return w.roots;
    }
  } catch (_) {}
  // 退化:workspace 变量本身是一个目录路径(旧行为),包成单 root
  if (workspace && /[\\/]/.test(workspace)) {
    return [{ name: 'workspace', path: workspace, default_cwd: true }];
  }
  return null;   // 让 loadTree 走默认(不传 root => 后端 workspace_root)
}

async function _fetchEntries(relPath, rootAbs) {
  const params = { path: relPath };
  if (rootAbs) params.root = rootAbs;
  const r = await fetch(filesUrl(params));
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.entries || [];
}

// 构造一行节点(dir 或 file)
function _makeNode(entry, relPath, depth, rootAbs) {
  const li = document.createElement('li');
  li.className = 'node ' + entry.type;
  li.dataset.path = relPath;
  li.dataset.rootAbs = rootAbs || '';
  li.style.setProperty('--depth', depth);

  const row = document.createElement('div');
  row.className = 'row';
  row.title = relPath;

  const tw = document.createElement('span');
  tw.className = 'twisty';
  tw.textContent = entry.type === 'dir' ? '▶' : '';
  row.appendChild(tw);

  const ic = document.createElement('span');
  ic.className = 'icon';
  ic.textContent = entry.type === 'dir' ? '📁' : '📄';
  row.appendChild(ic);

  const nm = document.createElement('span');
  nm.className = 'name';
  nm.textContent = entry.name;
  row.appendChild(nm);

  li.appendChild(row);

  const expKey = (rootAbs || '') + '::' + relPath;
  if (entry.type === 'dir') {
    const ul = document.createElement('ul');
    ul.className = 'children';
    li.appendChild(ul);
    row.onclick = () => _toggleDir(li, relPath, depth, false, rootAbs);
    if (_expandedDirs.has(expKey)) {
      setTimeout(() => _toggleDir(li, relPath, depth, true, rootAbs), 0);
    }
  } else {
    row.onclick = () => openPreview(relPath, rootAbs);
  }
  return li;
}

async function _toggleDir(li, relPath, depth, forceOpen, rootAbs) {
  const ul = li.querySelector(':scope > .children');
  const tw = li.querySelector(':scope > .row > .twisty');
  const isOpen = li.classList.contains('open');
  const expKey = (rootAbs || '') + '::' + relPath;
  if (isOpen && !forceOpen) {
    li.classList.remove('open');
    tw.textContent = '▶';
    _expandedDirs.delete(expKey);
    return;
  }
  if (!li.dataset.loaded) {
    tw.textContent = '⏳';
    try {
      const entries = await _fetchEntries(relPath, rootAbs);
      ul.innerHTML = '';
      if (!entries.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.style.setProperty('--depth', depth + 1);
        empty.textContent = '(空)';
        ul.appendChild(empty);
      } else {
        entries.forEach(e => {
          const child = _makeNode(e, relPath ? relPath + '/' + e.name : e.name, depth + 1, rootAbs);
          ul.appendChild(child);
        });
      }
      li.dataset.loaded = '1';
    } catch (err) {
      ul.innerHTML = '';
      const errEl = document.createElement('li');
      errEl.className = 'empty err';
      errEl.style.setProperty('--depth', depth + 1);
      errEl.textContent = '加载失败: ' + err.message;
      ul.appendChild(errEl);
    }
  }
  li.classList.add('open');
  tw.textContent = '▼';
  _expandedDirs.add(expKey);
}

async function loadTree(path) {
  const changed = (path || '') !== currentPath;
  currentPath = path || '';
  if (changed) _expandedDirs.clear();
  treeEl.dataset.ws = workspace || '';
  try {
    treeEl.innerHTML = '';

    const roots = _currentRoots();

    // ===== 多根渲染 =====
    if (roots && roots.length) {
      for (const r of roots) {
        const section = document.createElement('div');
        section.className = 'tree-root-section' + (r.default_cwd ? ' default-cwd' : '');
        section.dataset.rootName = r.name;

        const header = document.createElement('div');
        header.className = 'tree-root-header';
        header.title = r.path;
        header.innerHTML =
          '<span class="tw">▼</span>' +
          '<span class="rn">' + r.name + '</span>' +
          (r.default_cwd ? '<span class="badge">默认 cwd</span>' : '') +
          '<span class="rp">' + r.path + '</span>';
        section.appendChild(header);

        const body = document.createElement('div');
        body.className = 'tree-root-body';
        section.appendChild(body);

        header.onclick = () => {
          const collapsed = section.classList.toggle('collapsed');
          header.querySelector('.tw').textContent = collapsed ? '▶' : '▼';
        };

        const rootUl = document.createElement('ul');
        rootUl.className = 'tree-root';
        body.appendChild(rootUl);

        try {
          const entries = await _fetchEntries('', r.path);
          entries.forEach(e => {
            rootUl.appendChild(_makeNode(e, e.name, 0, r.path));
          });
          if (!entries.length) {
            const empty = document.createElement('li');
            empty.className = 'empty';
            empty.textContent = '(空目录)';
            rootUl.appendChild(empty);
          }
        } catch (err) {
          const errEl = document.createElement('div');
          errEl.className = 'entry';
          errEl.style.color = 'var(--danger, #e5534b)';
          errEl.textContent = 'root "' + r.name + '" 加载失败: ' + err.message;
          body.appendChild(errEl);
        }
        treeEl.appendChild(section);
      }
      return;
    }

    // ===== 单根兜底(旧行为) =====
    const rootLabel = document.createElement('div');
    rootLabel.className = 'tree-root-label';
    rootLabel.textContent = '/' + currentPath;
    rootLabel.title = '当前根: ' + (workspace || '(默认 workspace)') + (currentPath ? ' / ' + currentPath : '');
    treeEl.appendChild(rootLabel);

    if (currentPath) {
      const up = document.createElement('div');
      up.className = 'entry up';
      up.textContent = '⤴ ../';
      up.onclick = () => {
        const parent = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
        loadTree(parent);
      };
      treeEl.appendChild(up);
    }

    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    treeEl.appendChild(rootUl);

    const entries = await _fetchEntries(currentPath);
    entries.forEach(e => {
      const rel = currentPath ? currentPath + '/' + e.name : e.name;
      rootUl.appendChild(_makeNode(e, rel, 0));
    });
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '(空目录)';
      rootUl.appendChild(empty);
    }
  } catch (e) {
    treeEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'entry';
    err.style.color = 'var(--danger, #e5534b)';
    err.textContent = '加载失败: ' + e.message;
    treeEl.appendChild(err);
  }
}
/* ============ 文件预览 (Sublime 风高亮 + 行号) ============ */
// 根据后缀猜 highlight.js 语言别名
function guessLang(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  if (!m) return 'plaintext';
  const ext = m[1].toLowerCase();
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    php: 'php', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
    swift: 'swift', m: 'objectivec',
    html: 'xml', htm: 'xml', xml: 'xml', vue: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    md: 'markdown', markdown: 'markdown',
    sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'dos', cmd: 'dos', ps1: 'powershell',
    sql: 'sql', dockerfile: 'dockerfile',
    lua: 'lua', pl: 'perl', r: 'r', dart: 'dart',
  };
  return map[ext] || ext;
}

function renderPreview(path, text) {
  const codeEl  = previewContent.querySelector('.pv-code');
  const gutter  = previewContent.querySelector('.pv-gutter');
  const src = text || '';
  const lang = guessLang(path);

  // 高亮
  let html = '';
  try {
    if (window.hljs && lang !== 'plaintext' && hljs.getLanguage(lang)) {
      html = hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
    } else if (window.hljs) {
      html = hljs.highlightAuto(src).value;
    } else {
      html = src.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }
  } catch (_) {
    html = src.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  codeEl.innerHTML = html || '&nbsp;';

  // 行号
  const lines = src.length ? src.split('\n').length : 1;
  let g = '';
  for (let i = 1; i <= lines; i++) g += i + '\n';
  gutter.textContent = g;
}

async function openPreview(path, rootAbs) {
  try {
    const params = { mode: 'read', path };
    if (rootAbs) params.root = rootAbs;
    const r = await fetch(filesUrl(params));
    const j = await r.json();
    const displayPath = rootAbs ? (_rootNameByAbs(rootAbs) + '/' + path) : path;
    previewTitle.textContent = displayPath + (j.truncated ? '  (已截断)' : '');
    renderPreview(displayPath, j.content || '');
    appEl.classList.add('has-preview');
  } catch (e) {
    alert('读取失败: ' + e.message);
  }
}
function _rootNameByAbs(abs) {
  const roots = _currentRoots() || [];
  const hit = roots.find(r => r.path === abs);
  return hit ? hit.name : 'root';
}
closePreviewBtn.onclick = () => appEl.classList.remove('has-preview');

/* ============ 图片附件(每个 tab 独立 attachments 数组) ============ */
const MAX_IMG_SIDE = 1600;      // 长边最大像素
const IMG_QUALITY = 0.85;       // JPEG 压缩
const MAX_IMG_COUNT = 9;

function currentAttachments() {
  if (!activeTab) return [];
  return activeTab.attachments;
}

function updateAttachPreview() {
  const list = currentAttachments();
  if (!list.length) {
    attachPreview.hidden = true;
    attachPreview.innerHTML = '';
    return;
  }
  attachPreview.hidden = false;
  attachPreview.innerHTML = '';
  list.forEach((a, i) => {
    const kb = Math.round(a.size / 1024);
    const el = document.createElement('div');
    el.className = 'att';
    el.title = (a.name || 'image') + ' · ' + kb + 'KB · 点击预览大图';
    el.innerHTML =
      '<img alt="" src="' + a.dataUrl + '" />' +
      '<button class="att-del" title="移除">×</button>';
    const delBtn = el.querySelector('.att-del');
    delBtn.onclick = (ev) => {
      ev.stopPropagation();
      currentAttachments().splice(i, 1);
      updateAttachPreview();
    };
    // 点击缩略图任意位置(除删除按钮)预览大图
    el.addEventListener('click', () => openImageZoom(a.dataUrl));
    attachPreview.appendChild(el);
  });
}

function openImageZoom(src) {
  // 复用预览面板显示大图
  previewTitle.textContent = '图片预览';
  previewContent.innerHTML = '';
  const img = document.createElement('img');
  img.src = src;
  img.style.maxWidth = '100%';
  img.style.height = 'auto';
  img.style.borderRadius = '6px';
  previewContent.appendChild(img);
  appEl.classList.add('has-preview');
}

/** 把 File 压缩到最大 MAX_IMG_SIDE 长边并返回 data URL(jpeg)。 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.onload = () => {
        let { width, height } = img;
        const maxSide = Math.max(width, height);
        if (maxSide > MAX_IMG_SIDE) {
          const ratio = MAX_IMG_SIDE / maxSide;
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        // 若为透明 png,用白底避免变黑
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        // 优先 jpeg;体积更小
        const dataUrl = canvas.toDataURL('image/jpeg', IMG_QUALITY);
        resolve({ dataUrl, width, height });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  const arr = Array.from(files || []).filter(f => f.type && f.type.startsWith('image/'));
  if (!arr.length) return;
  for (const f of arr) {
    if (currentAttachments().length >= MAX_IMG_COUNT) {
      alert('最多上传 ' + MAX_IMG_COUNT + ' 张图片');
      break;
    }
    try {
      const { dataUrl } = await compressImage(f);
      // dataUrl 的近似字节数 = (length - header) * 3/4
      const approxBytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
      currentAttachments().push({ name: f.name || 'image', dataUrl, size: approxBytes });
      updateAttachPreview();
    } catch (e) {
      alert('图片处理失败: ' + e.message);
    }
  }
}

attachBtn.onclick = () => fileInput.click();
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length) addImageFiles(fileInput.files);
  fileInput.value = '';  // 允许再次选同一文件
});

// 粘贴图片
inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f && f.type.startsWith('image/')) files.push(f);
    }
  }
  if (files.length) { e.preventDefault(); addImageFiles(files); }
});

// 拖拽图片到 composer 区域
['dragenter', 'dragover'].forEach(ev => {
  composerEl.addEventListener(ev, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      composerEl.classList.add('dragover');
    }
  });
});
['dragleave', 'drop'].forEach(ev => {
  composerEl.addEventListener(ev, (e) => {
    composerEl.classList.remove('dragover');
    if (ev === 'drop') {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) addImageFiles(e.dataTransfer.files);
    }
  });
});


clearBtn.onclick = () => {
  if (!activeTab) { createTab({ activate: true }); return; }
  if (activeTab.sendingSid) {
    if (!confirm('当前会话还在运行,确认清空并开启新会话?')) return;
    try { stopTab(activeTab); } catch(_) {}
  }
  activeTab.sessionId = null;
  activeTab.title = '新会话';
  if (activeTab.panelEl) activeTab.panelEl.innerHTML = '';
  activeTab.currentAsst = null;
  activeTab.userMsgs = [];
  activeTab.fileChanges = [];
  activeTab.turnCounter = 0;
  activeTab.currentTurnId = 0;
  resetUsage(activeTab);
  sessionId = null;
  sessionEl.textContent = '(新)';
  updateTabItem(activeTab);
  persistTabs();
  markActiveHistory(null);
};
refreshBtn.onclick = () => loadTree(currentPath);

// 对话区域全屏切换(浏览器级 Fullscreen API + 布局独占)
// fullscreenMode: 'chat'(全屏对话独占布局) | 'page'(整页浏览器全屏,保留布局) | null
let fullscreenMode = null;
function isBrowserFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function enterBrowserFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (req) return req.call(el);
  return Promise.reject(new Error('浏览器不支持 Fullscreen API'));
}
function exitBrowserFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (exit && isBrowserFullscreen()) return exit.call(document);
  return Promise.resolve();
}
function syncFullscreenUI() {
  const on = isBrowserFullscreen();
  if (!on) fullscreenMode = null;
  // 只有 chat 模式才切换成对话独占布局;page 模式保留完整页面
  appEl.classList.toggle('chat-fullscreen', on && fullscreenMode === 'chat');
  appEl.classList.toggle('page-fullscreen', on && fullscreenMode === 'page');
  if (fullscreenBtn) {
    const active = on && fullscreenMode === 'chat';
    fullscreenBtn.classList.toggle('active', active);
    fullscreenBtn.textContent = active ? '⛶ 退出全屏' : '⛶ 全屏';
    fullscreenBtn.title = active ? '退出全屏 (Esc / F11)' : '浏览器全屏对话';
  }
  if (pageFullscreenBtn) {
    const active = on && fullscreenMode === 'page';
    pageFullscreenBtn.classList.toggle('active', active);
    pageFullscreenBtn.textContent = active ? '⛶ 退出页面全屏' : '⛶ 页面全屏';
    pageFullscreenBtn.title = active ? '退出全屏 (Esc / F11)' : '整个页面进入浏览器全屏';
  }
  // 进入/退出对话全屏时,刷新一次任务计划面板
  try { renderPlanPanel(); } catch (_) {}
  try { renderUserMsgList(); } catch (_) {}
  try { renderChangesPanel(); } catch (_) {}
}
function toggleBrowserFullscreen(mode) {
  if (isBrowserFullscreen()) {
    // 已在全屏:同一模式再次点击 = 退出;不同模式 = 切换到新模式
    if (fullscreenMode === mode) {
      exitBrowserFullscreen().catch(err => console.warn('[fullscreen] exit failed', err));
    } else {
      fullscreenMode = mode;
      syncFullscreenUI();
    }
  } else {
    fullscreenMode = mode;
    enterBrowserFullscreen().catch(err => {
      fullscreenMode = null;
      syncFullscreenUI();
      console.warn('[fullscreen] enter failed', err);
      alert('无法进入浏览器全屏:' + (err && err.message ? err.message : err));
    });
  }
}
if (fullscreenBtn) {
  fullscreenBtn.onclick = () => toggleBrowserFullscreen('chat');
}
if (pageFullscreenBtn) {
  pageFullscreenBtn.onclick = () => toggleBrowserFullscreen('page');
}
// 监听 F11 / Esc / 其它触发的全屏状态变化,保持 UI 一致
document.addEventListener('fullscreenchange', syncFullscreenUI);
document.addEventListener('webkitfullscreenchange', syncFullscreenUI);

wsSelect.addEventListener('change', () => {
  const newWs = wsSelect.value || '';
  workspace = newWs;
  localStorage.setItem(LS_WS_KEY, newWs);
  if (!activeTab) { createTab({ workspace: newWs, activate: true }); return; }
  if (activeTab.sendingSid) {
    if (!confirm('当前会话还在运行,切换工作区会开启新会话,确认?')) {
      // 回退选择
      wsSelect.value = activeTab.workspace || '';
      return;
    }
    try { stopTab(activeTab); } catch(_) {}
  }
  activeTab.workspace = newWs;
  activeTab.sessionId = null;
  activeTab.title = '新会话';
  if (activeTab.panelEl) activeTab.panelEl.innerHTML = '';
  activeTab.currentAsst = null;
  activeTab.userMsgs = [];
  activeTab.fileChanges = [];
  activeTab.turnCounter = 0;
  activeTab.currentTurnId = 0;
  resetUsage(activeTab);
  sessionId = null;
  sessionEl.textContent = '(新)';
  const info = makeMsg('assistant', 'workspace changed');
  const label = wsSelect.options[wsSelect.selectedIndex] ? wsSelect.options[wsSelect.selectedIndex].textContent : newWs;
  info.querySelector('.body').className = 'body md';
  info.querySelector('.body').innerHTML = renderMarkdown('**已切换工作区:** `' + label + '`\n\n下次对话 Agent 将在此工作区内工作。');
  updateTabItem(activeTab);
  persistTabs();
  loadTree('');
  refreshIndexStatus();
  ensureIndexBuilt();  // 切换工作区时,若未建索引则自动创建
  // 让后端 /v1/workspaces 也持久化 active
  fetch('api/workspaces.php', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({active_id: newWs}),
  }).catch(()=>{});
});
wsOpenBtn.onclick = () => {
  const opt = wsSelect.options[wsSelect.selectedIndex];
  const label = opt ? opt.textContent : workspace;
  navigator.clipboard && navigator.clipboard.writeText(label || '').catch(() => {});
  alert('当前工作区:\n' + (label || '(默认)') + '\n\n(名称已复制到剪贴板)');
};

/* ============ 发送消息(以 tab 为单位) ============ */
function setSending(on, tab) {
  // 仅当当前 activeTab 是这个 tab 时才影响输入区 UI
  const t = tab || activeTab;
  if (t && t !== activeTab) return;
  sendBtn.disabled = !!on;
  attachBtn.disabled = !!on;
  stopBtn.hidden = !on;
  const busy = document.getElementById('busy-bar');
  if (busy) busy.hidden = !on;
}

async function send() {
  if (!activeTab) createTab({ activate: true });
  const tab = activeTab;

  const message = inputEl.value.trim();
  const images = tab.attachments.map(a => a.dataUrl);
  if (!message && !images.length) return;
  if (tab.sendingSid) return;  // 该 tab 已在跑,忽略

  // 显示用户消息
  addUserMsg(message, tab, images);
  inputEl.value = '';
  tab.attachments = [];
  updateAttachPreview();
  tab.currentAsst = null;
  resetUsage(tab);
  setSending(true, tab);
  updateTabItem(tab);   // 显示 running 状态点

  tab.currentAbort = new AbortController();
  try {
    const body = { session_id: tab.sessionId, message, mode: tab.mode || 'agent' };
    if (tab.workspace) body.workspace = tab.workspace;
    if (images.length) body.images = images;

    const agentBase = (window.__AGENT_BASE__ || '').replace(/\/+$/, '');
    const streamUrl = agentBase ? (agentBase + '/v1/chat/stream') : 'api/stream.php';
    const resp = await fetch(streamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: tab.currentAbort.signal,
    });
    if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSseBlock(raw, tab);
      }
    }
    finalizeAsstMsg(tab);
  } catch (e) {
    if (e.name === 'AbortError') {
      finalizeAsstMsg(tab);
      addErrorMsg('⏹ 已停止', tab);
    } else {
      addErrorMsg('[请求失败] ' + e.message, tab);
    }
  } finally {
    tab.currentAbort = null;
    tab.sendingSid = null;
    setSending(false, tab);
    updateTabItem(tab);
    // 只在还是当前 tab 时刷新文件树(避免抢当前视图)
    if (tab === activeTab) loadTree(currentPath);
    loadHistory();
  }
}

async function stopTab(tab) {
  const t = tab || activeTab;
  if (!t) return;
  if (t.sendingSid) {
    try {
      await fetch('api/chat.php?action=stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: t.sendingSid }),
      });
    } catch (_) {}
  }
  if (t.currentAbort) {
    try { t.currentAbort.abort(); } catch (_) {}
  }
}
stopBtn.onclick = () => stopTab(activeTab);

function handleSseBlock(block, tab) {
  let event = 'message';
  const dataLines = [];
  block.split('\n').forEach(line => {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  });
  const raw = dataLines.join('\n');
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
  onEvent(event, data, tab);
}
function onEvent(event, data, tab) {
  const t = tab || activeTab;
  switch (event) {
    case 'session':
      if (t) {
        t.sessionId = data.session_id;
        t.sendingSid = data.session_id;
        if (!t.title || t.title === '新会话') {
          // 用第一条用户消息作为 title(loadHistory 会覆盖为后端真正的 title)
        }
        updateTabItem(t);
        persistTabs();
      }
      if (t === activeTab) {
        sessionId = data.session_id;
        sessionEl.textContent = sessionId;
        markActiveHistory(sessionId);
      }
      break;
    case 'workspace':
      if (data && data.path && t === activeTab) {
        healthEl.textContent = '● 工作区: ' + data.path;
        healthEl.className = 'health ok';
      }
      break;
    case 'assistant_delta':
      appendAsstDelta(data.text || '', t);
      break;
    case 'assistant_message':
      finalizeAsstMsg(t);
      break;
    case 'usage':
      updateUsage(data, t);
      break;
    case 'context_compressed':
      break;
    case 'tool_call':
      finalizeAsstMsg(t);
      addToolCallMsg(data.name, data.arguments, t);
      break;
    case 'tool_result':
      addToolResultMsg(data.name, data.result, t);
      break;
    case 'error':
      finalizeAsstMsg(t);
      addErrorMsg('⚠ ' + (data.message || JSON.stringify(data)), t);
      break;
    case 'done':
      finalizeAsstMsg(t);
      break;
  }
}

sendBtn.onclick = send;

async function refreshIndexStatus() {
  try {
    const agentBase = (window.__AGENT_BASE__ || '').replace(/\/+$/, '');
    const url = agentBase
      ? (agentBase + '/v1/index/stats' + (workspace ? ('?workspace=' + encodeURIComponent(workspace)) : ''))
      : ('api/vindex.php?action=stats' + (workspace ? ('&workspace=' + encodeURIComponent(workspace)) : ''));
    const r = await fetch(url);
    const j = await r.json();
    if (j && j.ok) {
      indexStatusEl.textContent = j.chunk_count > 0
        ? ('● ' + j.file_count + ' 文件 / ' + j.chunk_count + ' 片段')
        : '○ 尚未建立索引';
      indexStatusEl.className = 'health ' + (j.chunk_count > 0 ? 'ok' : '');
    } else {
      indexStatusEl.textContent = '○ 未知';
      indexStatusEl.className = 'health';
    }
  } catch (e) {
    indexStatusEl.textContent = '○ 查询失败';
    indexStatusEl.className = 'health err';
  }
}

async function buildIndex(force) {
  if (indexBtn.disabled) return;
  indexBtn.disabled = true;
  const original = indexBtn.textContent;
  indexBtn.textContent = '建索引中…';
  indexStatusEl.textContent = '● 建索引中(首次会下载 embedding 模型,耐心等)…';
  indexStatusEl.className = 'health';
  try {
    const agentBase = (window.__AGENT_BASE__ || '').replace(/\/+$/, '');
    const buildUrl = agentBase ? (agentBase + '/v1/index/build') : 'api/vindex.php?action=build';
    const r = await fetch(buildUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: workspace || null, force: !!force }),
    });
    const j = await r.json();
    if (j && j.ok) {
      indexStatusEl.textContent = '● 完成: ' + j.changed_files + ' 文件更新, +' + j.new_chunks + ' 片段, 耗时 ' + j.elapsed_sec + 's';
      indexStatusEl.className = 'health ok';
      const info = makeMsg('assistant', 'index built');
      info.querySelector('.body').className = 'body md';
      info.querySelector('.body').innerHTML = renderMarkdown(
        '**索引完成**\n\n' +
        '- 扫描文件: `' + j.scanned_files + '`\n' +
        '- 变更文件: `' + j.changed_files + '`\n' +
        '- 删除文件: `' + j.deleted_files + '`\n' +
        '- 新增片段: `' + j.new_chunks + '`\n' +
        '- 耗时: `' + j.elapsed_sec + 's`\n\n' +
        '接下来 Agent 可通过 `search_code` 工具做语义检索。'
      );
    } else {
      indexStatusEl.textContent = '● 失败: ' + (j && j.error || '未知');
      indexStatusEl.className = 'health err';
    }
  } catch (e) {
    indexStatusEl.textContent = '● 失败: ' + e.message;
    indexStatusEl.className = 'health err';
  } finally {
    indexBtn.disabled = false;
    indexBtn.textContent = original;
    refreshIndexStatus();
  }
}

indexBtn.onclick = (e) => buildIndex(e.shiftKey);  // Shift+点击 = 强制全量重建

// -- 加载工作区时自动创建索引 --
// 逻辑: 查询当前 workspace 的索引 stats, 若尚未建立(chunk_count===0)则触发一次增量 buildIndex。
// 用 Set 记录本次会话已尝试过的 workspace, 避免建索引失败后被反复自动触发。
const _autoIndexTried = new Set();
let _autoIndexInFlight = false;
async function ensureIndexBuilt() {
  const ws = workspace || '';
  if (_autoIndexInFlight) return;
  if (_autoIndexTried.has(ws)) return;
  // 若手动建索引正在进行中,跳过
  if (indexBtn && indexBtn.disabled) return;
  _autoIndexInFlight = true;
  try {
    const agentBase = (window.__AGENT_BASE__ || '').replace(/\/+$/, '');
    const url = agentBase
      ? (agentBase + '/v1/index/stats' + (ws ? ('?workspace=' + encodeURIComponent(ws)) : ''))
      : ('api/vindex.php?action=stats' + (ws ? ('&workspace=' + encodeURIComponent(ws)) : ''));
    const r = await fetch(url);
    const j = await r.json();
    if (j && j.ok) {
      // 只在明确"未建索引"时自动建;其它情况(已有索引 / 接口异常)都不动
      if (j.chunk_count === 0) {
        _autoIndexTried.add(ws);
        console.log('[auto-index] workspace 未建立索引, 自动开始增量构建:', ws || '(default)');
        await buildIndex(false);
      } else {
        _autoIndexTried.add(ws);
      }
    }
    // 若 stats 查询失败(!j.ok), 不标记 tried, 允许下次切回来再尝试
  } catch (e) {
    console.warn('[auto-index] stats 查询失败, 本次跳过自动建索引:', e);
  } finally {
    _autoIndexInFlight = false;
  }
}
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});

/* ============ 历史对话 ============ */
function formatTime(iso) {
  if (!iso) return '';
  // 后端存的是 UTC ISO(无 Z),补 Z 让浏览器按 UTC 解析,再显示为本地时间
  const s = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(s);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = n => String(n).padStart(2, '0');
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

async function loadHistory() {
  try {
    const r = await fetch('api/chat.php?action=sessions');
    const j = await r.json();
    historyRaw = (j && j.sessions) || [];
    renderHistory();
  } catch (e) {
    historyEl.innerHTML = '<div class="empty">加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}

// 记忆项目分组的折叠状态
const HISTORY_COLLAPSE_KEY = 'aiide_history_collapsed_groups';
function loadCollapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(HISTORY_COLLAPSE_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveCollapsedGroups(set) {
  try { localStorage.setItem(HISTORY_COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
}

function projectKeyOf(s) {
  return (s && s.workspace) ? String(s.workspace) : '';
}
function projectLabelOf(key) {
  if (!key) return '未指定项目';
  // 兼容 windows / posix 路径分隔符,取最后一段作为显示名
  const parts = key.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || key;
}

function renderHistory() {
  const q = (historySearchInput.value || '').trim().toLowerCase();
  const list = q
    ? historyRaw.filter(s => (s.title || '').toLowerCase().includes(q)
        || (s.session_id || '').toLowerCase().includes(q)
        || (s.workspace || '').toLowerCase().includes(q))
    : historyRaw;

  if (!historyRaw.length) {
    historyEl.innerHTML = '<div class="empty">还没有历史对话</div>';
    return;
  }
  if (!list.length) {
    historyEl.innerHTML = '<div class="empty">没有匹配的会话</div>';
    return;
  }

  // 按 workspace 分组;保留每组内后端返回的顺序(created_at DESC)
  const groupsMap = new Map();
  list.forEach(s => {
    const k = projectKeyOf(s);
    if (!groupsMap.has(k)) groupsMap.set(k, []);
    groupsMap.get(k).push(s);
  });
  // 组间排序:按每组最新会话的 created_at 倒序;"未指定项目"排最后
  const groups = [...groupsMap.entries()].map(([key, sessions]) => {
    const latest = sessions.reduce((m, s) => {
      const t = s.created_at || '';
      return t > m ? t : m;
    }, '');
    return { key, sessions, latest };
  });
  groups.sort((a, b) => {
    if (!a.key && b.key) return 1;
    if (a.key && !b.key) return -1;
    return a.latest < b.latest ? 1 : (a.latest > b.latest ? -1 : 0);
  });

  const collapsed = loadCollapsedGroups();
  const forceExpand = !!q; // 搜索时全部展开
  historyEl.innerHTML = '';

  groups.forEach(g => {
    const isCollapsed = !forceExpand && collapsed.has(g.key);
    const groupEl = document.createElement('div');
    groupEl.className = 'history-group' + (isCollapsed ? ' collapsed' : '');
    groupEl.dataset.key = g.key;

    const header = document.createElement('div');
    header.className = 'history-group-header';
    header.title = g.key || '未绑定工作区的会话';
    header.innerHTML =
      '<span class="hg-arrow">▾</span>' +
      '<span class="hg-name">' + escapeHtml(projectLabelOf(g.key)) + '</span>' +
      '<span class="hg-count">' + g.sessions.length + '</span>';
    header.addEventListener('click', () => {
      const set = loadCollapsedGroups();
      if (groupEl.classList.toggle('collapsed')) set.add(g.key);
      else set.delete(g.key);
      saveCollapsedGroups(set);
    });
    groupEl.appendChild(header);

    const body = document.createElement('div');
    body.className = 'history-group-body';

    g.sessions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'history-item';
      if (s.session_id === sessionId) item.classList.add('active');
      item.dataset.sid = s.session_id;
      const title = s.title || '(未命名会话)';
      item.innerHTML =
        '<div class="h-title" title="双击重命名">' + escapeHtml(title) + '</div>' +
        '<div class="h-meta"><span>' + escapeHtml(formatTime(s.created_at)) + '</span>' +
        '<span>' + (s.message_count || 0) + ' 条</span>' +
        '<span class="h-sid">' + escapeHtml((s.session_id || '').slice(0, 8)) + '</span></div>' +
        '<button class="h-edit" title="重命名">✎</button>' +
        '<button class="h-del" title="删除会话">×</button>';

      const titleEl = item.querySelector('.h-title');
      const editBtn = item.querySelector('.h-edit');
      const delBtn = item.querySelector('.h-del');

      item.addEventListener('click', ev => {
        if (ev.target === delBtn || ev.target === editBtn) return;
        if (ev.target.classList.contains('h-title-input')) return;
        const inNewTab = ev.ctrlKey || ev.metaKey || ev.button === 1;
        loadSession(s.session_id, { newTab: inNewTab });
      });
      item.addEventListener('auxclick', ev => {
        if (ev.button !== 1) return;   // 中键
        ev.preventDefault();
        loadSession(s.session_id, { newTab: true });
      });
      titleEl.addEventListener('dblclick', ev => {
        ev.stopPropagation();
        startRename(item, s);
      });
      editBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        startRename(item, s);
      });
      delBtn.addEventListener('click', async ev => {
        ev.stopPropagation();
        if (!confirm('删除该会话及全部消息?')) return;
        await deleteSession(s.session_id);
      });
      body.appendChild(item);
    });

    groupEl.appendChild(body);
    historyEl.appendChild(groupEl);
  });
}

function startRename(item, sess) {
  const titleEl = item.querySelector('.h-title');
  if (!titleEl || titleEl.querySelector('.h-title-input')) return;
  const oldTitle = sess.title || '';
  titleEl.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'h-title-input';
  input.type = 'text';
  input.value = oldTitle;
  input.maxLength = 80;
  titleEl.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async (save) => {
    if (committed) return;
    committed = true;
    if (save) {
      const newTitle = input.value.trim();
      if (newTitle !== oldTitle) {
        const ok = await renameSession(sess.session_id, newTitle);
        if (ok) {
          sess.title = newTitle;
          renderHistory();
          return;
        }
      }
    }
    // 取消或失败:恢复原标题
    titleEl.textContent = oldTitle || '(未命名会话)';
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

async function renameSession(sid, title) {
  try {
    const r = await fetch('api/chat.php?action=rename_session&sid=' + encodeURIComponent(sid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || j.detail || '重命名失败');
    return true;
  } catch (e) {
    alert('重命名失败: ' + e.message);
    return false;
  }
}

function markActiveHistory(sid) {
  historyEl.querySelectorAll('.history-item').forEach(it => {
    it.classList.toggle('active', sid && it.dataset.sid === sid);
  });
}

async function loadSession(sid, { newTab = false } = {}) {
  // 若该 session 已经在某个 tab 打开,直接切过去
  const existing = tabs.find(t => t.sessionId === sid);
  if (existing) {
    activateTab(existing);
    return;
  }
  let tab;
  if (newTab || !activeTab) {
    tab = createTab({ sessionId: sid, activate: true });
    if (!tab) return;
  } else {
    tab = activeTab;
    // 若当前 tab 已经有会话在跑,则强制开新 tab 免破坏
    if (tab.sendingSid) {
      tab = createTab({ sessionId: sid, activate: true });
      if (!tab) return;
    } else if (tab.sessionId && tab.sessionId !== sid) {
      // 已经绑定了别的会话 → 新开 tab,而不是"覆盖当前 tab 的会话"
      tab = createTab({ sessionId: sid, activate: true });
      if (!tab) return;
    } else {
      tab.sessionId = sid;
    }
  }
  try {
    const r = await fetch('api/chat.php?action=messages&sid=' + encodeURIComponent(sid));
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    tab.sessionId = sid;
    if (tab === activeTab) {
      sessionId = sid;
      sessionEl.textContent = sid;
    }
    // 清空该 tab 的 panel
    if (tab.panelEl) tab.panelEl.innerHTML = '';
    tab.currentAsst = null;
    tab.userMsgs = [];
    tab.fileChanges = [];
    tab.turnCounter = 0;
    tab.currentTurnId = 0;
    resetUsage(tab);
    // 恢复该会话原本使用的 workspace
    const sessWs = (j.workspace || '').trim();
    if (sessWs) {
      tab.workspace = sessWs;
      if (tab === activeTab) {
        workspace = sessWs;
        // 尝试在下拉里选中(找不到就保留原值,后端仍按字符串识别)
        if (wsSelect) {
          const opt = Array.from(wsSelect.options).find(o => o.value === sessWs);
          if (opt) wsSelect.value = sessWs;
        }
        localStorage.setItem(LS_WS_KEY, sessWs);
        currentPath = '';
        loadTree('');
        refreshIndexStatus();
      }
    }
    // 更新 tab 标题
    const meta = (historyRaw || []).find(h => h.session_id === sid);
    if (meta && meta.title) tab.title = meta.title;
    updateTabItem(tab);
    persistTabs();
    replayMessages(j.messages || [], tab);
    if (tab === activeTab) {
      markActiveHistory(sid);
      scrollBottom(true);
    }
  } catch (e) {
    addErrorMsg('加载会话失败: ' + e.message, tab);
  }
}

async function deleteSession(sid) {
  try {
    const r = await fetch('api/chat.php?action=delete_session&sid=' + encodeURIComponent(sid));
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '删除失败');
    // 若删除的是当前打开的某个 tab 对应的会话 → 该 tab 变回"新会话"状态
    for (const t of tabs) {
      if (t.sessionId === sid) {
        t.sessionId = null;
        t.title = '新会话';
        if (t.panelEl) t.panelEl.innerHTML = '';
        t.currentAsst = null;
        t.userMsgs = [];
        t.fileChanges = [];
        t.turnCounter = 0;
        t.currentTurnId = 0;
        resetUsage(t);
        updateTabItem(t);
        if (t === activeTab) {
          sessionId = null;
          sessionEl.textContent = '(新)';
        }
      }
    }
    persistTabs();
    loadHistory();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

/**
 * 把持久化的 messages 数组回放为聊天气泡到指定 tab。
 * 支持 role: user / assistant(可能含 tool_calls) / tool。
 */
function replayMessages(msgs, tab) {
  const filtered = msgs.filter(m => m && m.role && m.role !== 'system');
  const callMap = {};
  for (const m of filtered) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id) callMap[tc.id] = (tc.function && tc.function.name) || tc.name || '';
      }
    }
  }
  for (const m of filtered) {
    if (m.role === 'user') {
      let text = '';
      const imgs = [];
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (!part) continue;
          if (typeof part === 'string') { text += part; continue; }
          if (part.type === 'text' && typeof part.text === 'string') {
            text += (text ? '\n' : '') + part.text;
          } else if (part.type === 'image_url') {
            const u = part.image_url && (part.image_url.url || part.image_url);
            if (typeof u === 'string' && u) imgs.push(u);
          } else if (part.type === 'image' && typeof part.image === 'string') {
            imgs.push(part.image);
          }
        }
      } else if (m.content != null) {
        text = JSON.stringify(m.content);
      }
      addUserMsg(text, tab, imgs);
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) {
        const el = makeMsg('assistant', '', tab);
        const body = el.querySelector('.body');
        body.className = 'body md';
        body.innerHTML = renderMarkdown(text);
        if (window.hljs) {
          body.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch(_){} });
        }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = (tc.function && tc.function.name) || tc.name || '(tool)';
          const args = (tc.function && tc.function.arguments) || tc.arguments || '{}';
          addToolCallMsg(name, args, tab);
        }
      }
    } else if (m.role === 'tool') {
      const name = m.name || callMap[m.tool_call_id] || '(tool)';
      let result;
      try { result = JSON.parse(m.content); } catch { result = { raw: m.content }; }
      addToolResultMsg(name, result, tab);
    }
  }
}

historyRefreshBtn.onclick = loadHistory;

let historyRaw = [];
let searchTimer = null;
historySearchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderHistory, 120);
});

/* ============ 多 tab 相关按钮/初始化 ============ */
tabNewBtn.onclick = () => {
  const t = createTab({ workspace: activeTab ? activeTab.workspace : workspace, activate: true });
  if (t) inputEl.focus();
};

// ---- 对话模式切换按钮绑定 ----
(function bindModeBar() {
  const bar = document.getElementById('mode-bar');
  if (!bar) return;
  bar.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!activeTab) return;
      const m = btn.dataset.mode;
      if (!m || m === activeTab.mode) return;
      setTabMode(activeTab, m);
      inputEl && inputEl.focus();
    });
  });
})();

async function bootTabs() {
  // 先从 localStorage 恢复 tabs;若为空,建一个默认 tab
  const persisted = loadPersistedTabs();
  if (!persisted.length) {
    createTab({ activate: true });
    return;
  }
  const wantActiveIdx = parseInt(localStorage.getItem(LS_ACTIVE_TAB_KEY) || '0', 10) || 0;
  for (const p of persisted) {
    const t = createTab({
      sessionId: p.sid || null,
      workspace: p.ws || '',
      title: p.title || '新会话',
      mode: p.mode || 'agent',
      activate: false,
    });
    if (!t) continue;
    if (p.sid) {
      // 静默加载会话消息(不切换 active)
      try {
        const r = await fetch('api/chat.php?action=messages&sid=' + encodeURIComponent(p.sid));
        const j = await r.json();
        if (!j.error) {
          if (j.workspace && !t.workspace) t.workspace = j.workspace;
          if (t.panelEl) t.panelEl.innerHTML = '';
          t.userMsgs = [];
          t.fileChanges = [];
          t.turnCounter = 0;
          t.currentTurnId = 0;
          replayMessages(j.messages || [], t);
          updateTabItem(t);
        }
      } catch (_) {}
    }
  }
  if (tabs.length) {
    const target = tabs[Math.min(Math.max(wantActiveIdx, 0), tabs.length - 1)];
    activateTab(target);
  } else {
    createTab({ activate: true });
  }
}

checkHealth();
loadTree('');
loadHistory().then(() => bootTabs());
refreshIndexStatus();
setInterval(checkHealth, 30000);

/* ============ 设置面板 ============ */
(function initSettings() {
  const modal = document.getElementById('settings-modal');
  const openBtn = document.getElementById('btn-settings');
  const saveBtn = document.getElementById('btn-settings-save');
  const addBtn = document.getElementById('btn-profile-add');
  const tabsEl = document.getElementById('profile-tabs');
  const formEl = document.getElementById('profile-form');
  const msgEl = document.getElementById('settings-msg');
  const inpMaxSteps = document.getElementById('p-max-steps');
  const inpShellTo = document.getElementById('p-shell-timeout');
  const inpMaxOut = document.getElementById('p-max-output');
  const inpMaxTok = document.getElementById('p-max-tokens');

  if (!modal || !openBtn) return;

  let state = { active_profile: '', profiles: [], params: {} };
  let editingId = ''; // 当前正在编辑的 profile id

  function setMsg(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'settings-msg' + (kind ? ' ' + kind : '');
  }

  function openModal() {
    modal.hidden = false;
    setMsg('加载中...');
    fetch('api/settings.php').then(r => r.json()).then(data => {
      if (!data || data.ok === false) throw new Error(data && data.error || '加载失败');
      state = {
        active_profile: data.active_profile || '',
        profiles: (data.profiles || []).map(p => ({ ...p, api_key: '' })), // 明文 key 始终留空,由用户选择是否覆盖
        params: data.params || {},
      };
      editingId = state.active_profile || (state.profiles[0] && state.profiles[0].id) || '';
      renderTabs();
      renderForm();
      renderParams();
      setMsg('');
    }).catch(err => setMsg(String(err && err.message || err), 'err'));
  }

  function closeModal() { modal.hidden = true; }

  modal.addEventListener('click', e => {
    if (e.target.dataset && e.target.dataset.close === '1') closeModal();
  });
  openBtn.addEventListener('click', openModal);

  function renderTabs() {
    tabsEl.innerHTML = '';
    state.profiles.forEach(p => {
      const tab = document.createElement('span');
      tab.className = 'profile-tab' + (p.id === editingId ? ' active' : '');
      const label = document.createElement('span');
      label.textContent = p.name || p.id;
      tab.appendChild(label);
      if (p.id === state.active_profile) {
        const b = document.createElement('span');
        b.className = 'badge-active';
        b.textContent = '使用中';
        tab.appendChild(b);
      }
      if (state.profiles.length > 1) {
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '×';
        del.title = '删除此档案';
        del.addEventListener('click', ev => {
          ev.stopPropagation();
          if (!confirm(`删除档案 "${p.name || p.id}" ?`)) return;
          state.profiles = state.profiles.filter(x => x.id !== p.id);
          if (state.active_profile === p.id && state.profiles[0]) {
            state.active_profile = state.profiles[0].id;
          }
          if (editingId === p.id && state.profiles[0]) editingId = state.profiles[0].id;
          renderTabs(); renderForm();
        });
        tab.appendChild(del);
      }
      tab.addEventListener('click', () => { editingId = p.id; renderTabs(); renderForm(); });
      tabsEl.appendChild(tab);
    });
  }

  function renderForm() {
    const p = state.profiles.find(x => x.id === editingId);
    if (!p) { formEl.innerHTML = '<div class="settings-hint">请点击上方档案标签,或点击"+ 新增"。</div>'; return; }
    formEl.innerHTML = '';
    const g = (labelText, key, type, placeholder) => {
      const l = document.createElement('label');
      l.innerHTML = `<span>${labelText}</span>`;
      const i = document.createElement('input');
      i.type = type || 'text';
      i.value = p[key] || '';
      if (placeholder) i.placeholder = placeholder;
      i.addEventListener('input', () => { p[key] = i.value; });
      l.appendChild(i);
      return l;
    };
    formEl.appendChild(g('名称 (显示用)', 'name', 'text', '如: DeepSeek / GPT-4o'));
    const row = document.createElement('div');
    row.className = 'row-2';
    row.appendChild(g('Base URL', 'base_url', 'text', 'https://api.deepseek.com/v1'));
    row.appendChild(g('模型 ID', 'model', 'text', 'deepseek-chat'));
    formEl.appendChild(row);

    // API Key: 展示掩码占位,清空后才代表覆盖
    const kl = document.createElement('label');
    kl.innerHTML = `<span>API Key <small style="color:var(--muted)">(留空 = 保留原有 Key,只有填新值才会覆盖)</small></span>`;
    const ki = document.createElement('input');
    ki.type = 'password';
    ki.value = p.api_key || '';
    ki.placeholder = p.api_key_masked || '(已设置,留空即保留)';
    ki.addEventListener('input', () => { p.api_key = ki.value; });
    kl.appendChild(ki);
    formEl.appendChild(kl);

    const act = document.createElement('div');
    act.className = 'form-actions';
    const useBtn = document.createElement('button');
    useBtn.className = 'use-btn' + (p.id === state.active_profile ? ' active' : '');
    useBtn.textContent = p.id === state.active_profile ? '✓ 当前使用' : '设为当前使用';
    useBtn.addEventListener('click', () => {
      state.active_profile = p.id;
      renderTabs(); renderForm();
    });
    act.appendChild(useBtn);
    formEl.appendChild(act);
  }

  function renderParams() {
    const P = state.params || {};
    inpMaxSteps.value = P.max_steps ?? 20;
    inpShellTo.value = P.shell_timeout ?? 60;
    inpMaxOut.value = P.max_output_chars ?? 8000;
    inpMaxTok.value = P.max_tokens ?? 0;
  }

  addBtn.addEventListener('click', () => {
    const id = 'p_' + Date.now().toString(36);
    state.profiles.push({
      id, name: '新档案', base_url: 'https://api.deepseek.com/v1',
      api_key: '', model: 'deepseek-chat',
    });
    editingId = id;
    renderTabs(); renderForm();
  });

  saveBtn.addEventListener('click', async () => {
    setMsg('保存中...');
    const payload = {
      active_profile: state.active_profile,
      profiles: state.profiles.map(p => ({
        id: p.id, name: p.name, base_url: p.base_url, model: p.model,
        api_key: p.api_key || '', // 空串在后端会保留原值
      })),
      params: {
        max_steps: parseInt(inpMaxSteps.value, 10) || 20,
        shell_timeout: parseInt(inpShellTo.value, 10) || 60,
        max_output_chars: parseInt(inpMaxOut.value, 10) || 8000,
        max_tokens: parseInt(inpMaxTok.value, 10) || 0,
      },
    };
    try {
      const r = await fetch('api/settings.php', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
      setMsg('已保存 ✓ 下一轮对话即刻生效', 'ok');
      // 刷新健康检测显示的模型名
      if (typeof checkHealth === 'function') checkHealth();
      setTimeout(closeModal, 900);
    } catch (err) {
      setMsg('保存失败: ' + (err && err.message || err), 'err');
    }
  });

  // Esc 关闭
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
})();

/* ============ 工作区(多根)管理 ============ */
(function initWorkspaces() {
  const modal = document.getElementById('ws-modal');
  const openBtn = document.getElementById('btn-ws-manage');
  const addWsBtn = document.getElementById('btn-ws-add');
  const addRootBtn = document.getElementById('btn-root-add');
  const saveBtn = document.getElementById('btn-ws-save');
  const tabsEl = document.getElementById('ws-tabs');
  const rootsEl = document.getElementById('ws-roots');
  const msgEl = document.getElementById('ws-msg');
  if (!modal || !openBtn || !wsSelect) return;

  let state = { active_id: '', workspaces: [] };
  let editingId = '';

  function setMsg(t, kind) {
    msgEl.textContent = t || '';
    msgEl.className = 'settings-msg' + (kind ? ' ' + kind : '');
  }

  // ------- 顶栏下拉:加载 + 填充 -------
  async function loadWorkspaces() {
    try {
      const r = await fetch('api/workspaces.php');
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '加载失败');
      state = { active_id: d.active_id || '', workspaces: d.workspaces || [] };
      window.__wsState = state;
      fillSelect();
    } catch (err) {
      console.warn('workspaces load failed:', err);
    }
  }

  function fillSelect() {
    wsSelect.innerHTML = '';
    state.workspaces.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      const rootHint = (w.roots || []).map(r => r.name).slice(0, 3).join('+');
      opt.textContent = w.name + (rootHint ? ' [' + rootHint + (w.roots.length > 3 ? '...' : '') + ']' : '');
      wsSelect.appendChild(opt);
    });
    // 决定选中项:localStorage > active_id > 第一个
    const stored = localStorage.getItem(LS_WS_KEY) || '';
    const ids = state.workspaces.map(w => w.id);
    let chosen = ids.includes(stored) ? stored : (state.active_id || ids[0] || '');
    wsSelect.value = chosen;
    workspace = chosen;
    localStorage.setItem(LS_WS_KEY, chosen);
    // 有 activeTab 时同步(避免 tab 里保存的是旧的路径)
    if (activeTab) {
      if (!ids.includes(activeTab.workspace || '')) {
        activeTab.workspace = chosen;
      } else {
        wsSelect.value = activeTab.workspace;
        workspace = activeTab.workspace;
      }
    }
  }

  // ------- 管理面板 -------
  openBtn.addEventListener('click', () => {
    modal.hidden = false;
    setMsg('加载中...');
    fetch('api/workspaces.php').then(r => r.json()).then(d => {
      if (!d.ok) throw new Error(d.error || '加载失败');
      // 深拷贝,编辑时不影响外部 state
      state = JSON.parse(JSON.stringify({ active_id: d.active_id || '', workspaces: d.workspaces || [] }));
      editingId = state.active_id || (state.workspaces[0] && state.workspaces[0].id) || '';
      renderTabs(); renderRoots(); setMsg('');
    }).catch(e => setMsg(String(e.message || e), 'err'));
  });

  modal.addEventListener('click', e => {
    if (e.target.dataset && e.target.dataset.close === '1') modal.hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  function renderTabs() {
    tabsEl.innerHTML = '';
    state.workspaces.forEach(w => {
      const tab = document.createElement('span');
      tab.className = 'profile-tab' + (w.id === editingId ? ' active' : '');
      const lbl = document.createElement('span');
      lbl.textContent = w.name;
      lbl.title = '双击重命名';
      lbl.ondblclick = () => {
        const nv = prompt('重命名工作区', w.name);
        if (nv) { w.name = nv.trim() || w.name; renderTabs(); }
      };
      tab.appendChild(lbl);
      if (w.id === state.active_id) {
        const b = document.createElement('span');
        b.className = 'badge-active'; b.textContent = '使用中';
        tab.appendChild(b);
      }
      if (state.workspaces.length > 1) {
        const del = document.createElement('span');
        del.className = 'del'; del.textContent = '×'; del.title = '删除此工作区';
        del.addEventListener('click', ev => {
          ev.stopPropagation();
          if (!confirm(`删除工作区 "${w.name}" ?(不会删除磁盘文件)`)) return;
          state.workspaces = state.workspaces.filter(x => x.id !== w.id);
          if (state.active_id === w.id) state.active_id = state.workspaces[0].id;
          if (editingId === w.id) editingId = state.workspaces[0].id;
          renderTabs(); renderRoots();
        });
        tab.appendChild(del);
      }
      tab.addEventListener('click', () => { editingId = w.id; renderTabs(); renderRoots(); });
      tabsEl.appendChild(tab);
    });
  }

  function currentWs() { return state.workspaces.find(w => w.id === editingId); }

  function renderRoots() {
    rootsEl.innerHTML = '';
    const w = currentWs();
    if (!w) return;
    // 顶部一行:设为使用中
    const bar = document.createElement('div');
    bar.className = 'form-actions';
    const useBtn = document.createElement('button');
    useBtn.className = 'use-btn' + (w.id === state.active_id ? ' active' : '');
    useBtn.textContent = w.id === state.active_id ? '✓ 当前使用' : '设为当前使用';
    useBtn.addEventListener('click', () => { state.active_id = w.id; renderTabs(); renderRoots(); });
    bar.appendChild(useBtn);
    rootsEl.appendChild(bar);

    (w.roots || []).forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = 'ws-root-row';
      row.innerHTML = `
        <label class="ws-root-cell short">
          <span>名称</span>
          <input class="rn" type="text" value="${escapeAttr(r.name || '')}" placeholder="如 gateway" />
        </label>
        <label class="ws-root-cell grow">
          <span>绝对路径</span>
          <input class="rp" type="text" value="${escapeAttr(r.path || '')}" placeholder="D:\\proj\\svc-order" spellcheck="false" />
        </label>
        <label class="ws-root-cell tiny" title="run_shell 未显式 cd 时的默认工作目录">
          <span>默认 cwd</span>
          <input class="rd" type="radio" name="wsdefault_${w.id}" ${r.default_cwd ? 'checked' : ''} />
        </label>
        <button class="mini-btn danger rdel" title="移除此 root">×</button>
      `;
      const nameI = row.querySelector('.rn');
      const pathI = row.querySelector('.rp');
      const defI  = row.querySelector('.rd');
      nameI.oninput = () => { r.name = nameI.value.trim(); };
      pathI.oninput = () => { r.path = pathI.value.trim(); };
      defI.onchange = () => {
        w.roots.forEach((x, i) => x.default_cwd = (i === idx) && defI.checked);
      };
      row.querySelector('.rdel').addEventListener('click', () => {
        if (w.roots.length <= 1) { alert('至少保留一个 root'); return; }
        w.roots.splice(idx, 1);
        if (!w.roots.some(x => x.default_cwd)) w.roots[0].default_cwd = true;
        renderRoots();
      });
      rootsEl.appendChild(row);
    });
  }

  function escapeAttr(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  addWsBtn.addEventListener('click', () => {
    const id = 'ws_' + Date.now().toString(36);
    state.workspaces.push({
      id, name: '新工作区',
      roots: [{ name: 'root', path: '', default_cwd: true }],
    });
    editingId = id;
    renderTabs(); renderRoots();
  });

  addRootBtn.addEventListener('click', () => {
    const w = currentWs();
    if (!w) return;
    w.roots.push({ name: 'root' + (w.roots.length + 1), path: '' });
    renderRoots();
  });

  saveBtn.addEventListener('click', async () => {
    // 基本校验
    for (const w of state.workspaces) {
      if (!(w.roots || []).length) { setMsg(`工作区 "${w.name}" 至少需要一个 root`, 'err'); return; }
      for (const r of w.roots) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(r.name || '')) {
          setMsg(`root 名称非法: "${r.name}" (仅允许 A-Za-z0-9_.-)`, 'err'); return;
        }
        if (!r.path) { setMsg(`工作区 "${w.name}" 中 root "${r.name}" 路径不能为空`, 'err'); return; }
      }
    }
    setMsg('保存中...');
    try {
      const r = await fetch('api/workspaces.php', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ active_id: state.active_id, workspaces: state.workspaces }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'HTTP ' + r.status);
      setMsg('已保存 ✓', 'ok');
      // 立即刷新下拉与树
      await loadWorkspaces();
      loadTree('');
      refreshIndexStatus();
      if (typeof ensureIndexBuilt === 'function') ensureIndexBuilt();  // 新增/切换工作区后自动建索引
      if (typeof checkHealth === 'function') checkHealth();
      setTimeout(() => modal.hidden = true, 700);
    } catch (err) {
      setMsg('保存失败: ' + (err.message || err), 'err');
    }
  });

  // 首次加载
  loadWorkspaces().then(() => {
    // workspace 变量此时已由 fillSelect() 同步为当前选中的 id, 触发一次自动建索引
    if (typeof ensureIndexBuilt === 'function') ensureIndexBuilt();
  });
})();