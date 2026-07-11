<?php
$cfg = require __DIR__ . '/../config/config.php';
$agentBase = htmlspecialchars($cfg['agent_base'] ?? 'http://127.0.0.1:8100', ENT_QUOTES);
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>axsl-aiide · 轻量编程 Agent</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/monokai-sublime.min.css" />
<link rel="stylesheet" href="assets/app.css" />
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.11/dist/purify.min.js"></script>
<!-- 使用 cdnjs 的 highlight.min.js:内置常用语言(python/js/php/css/xml/json/bash/sql...) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<!-- 额外补齐几个常用但未打包进核心的语言 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/dockerfile.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/vim.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/powershell.min.js"></script>
<script>
  // 供 app.js 直连 Python agent 后端(绕开 PHP CLI Server 单进程阻塞,支持并发对话)
  window.__AGENT_BASE__ = "<?= $agentBase ?>";
</script>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">A</div>
      <div class="brand-text">
        <div class="title">axsl-aiide</div>
        <div class="subtitle">轻量编程 Agent</div>
      </div>
    </div>

    <div class="section-title">Workspace</div>
    <div id="file-tree" class="file-tree"></div>

    <div class="section-title">状态</div>
    <div id="health" class="health">检查中…</div>

    <div class="section-title">索引</div>
    <div id="index-status" class="health">未知</div>

    <div class="sidebar-footer">
      <button id="btn-fullscreen" class="sidebar-btn" title="进入对话区全屏(Esc 退出)">⛶ 对话</button>
      <button id="btn-page-fullscreen" class="sidebar-btn" title="整个页面进入浏览器全屏 (Esc 退出)">⛶ 页面</button>
      <button id="btn-settings" class="sidebar-btn" title="模型 / 参数设置">⚙️ 设置</button>
    </div>
  </aside>

  <!-- 对话全屏模式下显示:左侧显示本次任务的执行计划(从 assistant 输出里提取的 ## 计划 块) -->
  <aside class="plan-panel" id="plan-panel" aria-label="任务执行计划 & 我的消息">
    <div class="plan-header">
      <span class="plan-title">📋 任务执行计划</span>
      <span class="plan-sub" id="plan-sub">当前会话</span>
    </div>
    <div class="plan-body" id="plan-body">
      <div class="plan-empty">
        暂无计划。<br><br>
        提交任务后,Agent 会在回复顶部输出 <code>## 计划</code>,<br>
        本区域会自动提取并展示,方便你跟踪进度。
      </div>
    </div>
<!-- “我的消息”已迁移到右侧 changes-panel 顶部 -->
  </aside>

  <main class="main">
    <header class="toolbar">
      <div class="ws-picker">
        <label>工作区:</label>
        <select id="ws-select" title="切换工作区(多根)"></select>
        <button id="btn-ws-manage" title="管理工作区(增删 root)">⚙ 管理</button>
        <button id="btn-ws-open" title="用系统资源管理器打开 default cwd root">📂</button>
      </div>
      <div class="actions">
        <span class="session">会话:<span id="session-id">(新)</span></span>
        <span id="usage-stat" class="usage-inline" title="本次会话累计 Token 消耗">○ 尚无调用</span>
        <button id="btn-index" title="扫描当前项目并建立/更新向量索引">建索引</button>
        <button id="btn-clear" title="在当前标签页开启新会话（保留 workspace）">新会话</button>
        <button id="btn-refresh">刷新</button>
        <button id="btn-debug" title="查看实际发送给模型 API 的输入 / 输出" onclick="window.open('<?= $agentBase ?>/v1/debug/llm_calls/view','_blank')">🔍 API 日志</button>
      </div>
    </header>

    <div id="tab-bar" class="tab-bar">
      <div id="tab-list" class="tab-list"></div>
      <button id="btn-tab-new" class="tab-new" title="打开新的并行会话标签页">＋</button>
    </div>

    <div id="chat" class="chat"><div id="chat-inner" class="chat-inner"></div></div>

    <div id="busy-bar" class="busy-bar" hidden>
      <span class="busy-spinner" aria-hidden="true"></span>
      <span class="busy-text">处理中…</span>
    </div>
    <footer class="composer">
      <div id="attach-preview" class="attach-preview" hidden></div>
      <div class="composer-main">
        <div id="mode-bar" class="mode-bar" role="tablist" aria-label="对话模式">
          <button type="button" class="mode-btn" data-mode="ask" role="tab" aria-selected="false"
                  title="Ask · 只做问答/解释/Review,不修改任何文件">
            <span class="mode-ico">💬</span><span class="mode-label">Ask</span>
          </button>
          <button type="button" class="mode-btn is-active" data-mode="agent" role="tab" aria-selected="true"
                  title="Agent · 智能修改:允许调用全部工具(读/写/执行)">
            <span class="mode-ico">🤖</span><span class="mode-label">Agent</span>
          </button>
          <button type="button" class="mode-btn" data-mode="debug" role="tab" aria-selected="false"
                  title="Debug · 修复 Bug 专用:定位根因 + 最小改动 + 自动验证">
            <span class="mode-ico">🐞</span><span class="mode-label">Debug</span>
          </button>
          <span class="mode-hint" id="mode-hint"></span>
        </div>
        <textarea
          id="input"
          placeholder="告诉 Agent 你想让它做什么。可以粘贴 / 拖拽 / 点 📎 添加图片。"
          rows="3"></textarea>
      </div>
      <div class="composer-btns">
        <button id="btn-attach" class="btn-attach" title="添加图片(可粘贴 / 拖拽)">📎</button>
        <button id="btn-send">发送</button>
        <button id="btn-stop" class="btn-stop" hidden>停止</button>
      </div>
      <input id="file-input" type="file" accept="image/*" multiple hidden />
    </footer>
  </main>

  <!-- 对话全屏模式下显示:右侧列出本次会话中被 Agent 修改的文件(新增/改动/删除) -->
  <aside class="changes-panel" id="changes-panel" aria-label="本次会话文件改动">
    <!-- 我的消息(从左侧计划面板迁移过来) -->
    <div class="usermsg-section" id="usermsg-section" role="region" aria-label="我的消息">
      <div class="usermsg-header">
        <span class="usermsg-title">💬 我的消息</span>
        <span class="usermsg-count" id="usermsg-count">0</span>
      </div>
      <div class="usermsg-body" id="usermsg-body">
        <div class="usermsg-empty">本次对话中你尚未发送消息</div>
      </div>
    </div>

    <div class="changes-section">
      <div class="changes-header">
        <span class="changes-title">📁 本次文件改动</span>
        <span class="changes-count" id="changes-count">0</span>
        <button class="changes-clear-filter" id="changes-clear-filter" title="显示全部改动" hidden>× 取消筛选</button>
      </div>
      <div class="changes-filter-hint" id="changes-filter-hint" hidden></div>
      <div class="changes-body" id="changes-body">
        <div class="changes-empty">Agent 尚未修改任何文件</div>
      </div>
    </div>
  </aside>

  <aside class="history-panel" id="history-panel">
    <div class="panel-header">
      <span>历史对话</span>
      <button id="btn-history-refresh" class="mini-btn" title="刷新历史">⟳</button>
    </div>
    <div class="history-search">
      <input id="history-search-input" type="text" placeholder="🔍 搜索标题 / 首条消息" spellcheck="false" />
    </div>
    <div id="history-list" class="history-list">加载中…</div>
  </aside>

  <aside class="preview" id="preview">
    <div class="preview-header">
      <span id="preview-title">文件预览</span>
      <button id="btn-close-preview">×</button>
    </div>
    <div id="preview-content" class="preview-code">
      <div class="pv-gutter" aria-hidden="true"></div>
      <pre class="pv-pre"><code class="pv-code hljs"></code></pre>
    </div>
  </aside>
</div>

<!-- 工作区管理面板 -->
<div id="ws-modal" class="settings-modal" hidden>
  <div class="settings-backdrop" data-close="1"></div>
  <div class="settings-dialog" role="dialog" aria-modal="true" style="width:min(880px,94vw);">
    <header class="settings-header">
      <h3>工作区管理 (多根)</h3>
      <button class="settings-close" data-close="1" title="关闭">×</button>
    </header>
    <div class="settings-body">
      <section class="settings-section">
        <div class="settings-section-title">
          <span>工作区列表</span>
          <button id="btn-ws-add" class="mini-btn" title="新增一个工作区">+ 新增工作区</button>
        </div>
        <div id="ws-tabs" class="profile-tabs"></div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">
          <span>当前工作区的 root 列表</span>
          <button id="btn-root-add" class="mini-btn" title="给当前工作区加一个 root">+ 添加 root</button>
        </div>
        <div id="ws-roots" class="ws-roots"></div>
        <div class="settings-hint">
          root name 用于路径前缀,例如 <code>gateway/src/App.java</code>;必须为 <code>[A-Za-z0-9_.-]</code> 且不含斜杠。
          "默认 cwd" 会作为 run_shell 未显式 <code>cd</code> 时的执行目录。
        </div>
      </section>
    </div>
    <footer class="settings-footer">
      <span id="ws-msg" class="settings-msg"></span>
      <button class="btn-secondary" data-close="1">取消</button>
      <button id="btn-ws-save" class="btn-primary">保存</button>
    </footer>
  </div>
</div>

<!-- 设置面板 -->
<div id="settings-modal" class="settings-modal" hidden>
  <div class="settings-backdrop" data-close="1"></div>
  <div class="settings-dialog" role="dialog" aria-modal="true">
    <header class="settings-header">
      <h3>设置</h3>
      <button class="settings-close" data-close="1" title="关闭">×</button>
    </header>
    <div class="settings-body">
      <section class="settings-section">
        <div class="settings-section-title">
          <span>模型档案</span>
          <button id="btn-profile-add" class="mini-btn" title="新增一个档案">+ 新增</button>
        </div>
        <div class="settings-profiles-wrap">
          <div id="profile-tabs" class="profile-tabs"></div>
          <div id="profile-form" class="profile-form"></div>
        </div>
        <div class="settings-hint">切换"当前使用"后,下一轮对话立即生效,无需重启服务。</div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title"><span>运行参数</span></div>
        <div class="param-grid">
          <label>最大步数 (max_steps)
            <input id="p-max-steps" type="number" min="1" max="200" step="1" />
            <small>一次对话中 Agent 最多循环轮数,达到后强制结束。</small>
          </label>
          <label>Shell 超时 (秒)
            <input id="p-shell-timeout" type="number" min="5" max="600" step="1" />
            <small>run_shell 单条命令最长执行时间。</small>
          </label>
          <label>工具输出最大字符
            <input id="p-max-output" type="number" min="1000" max="200000" step="500" />
            <small>read_file / run_shell 返回给模型的最大字符数,超出会中间截断。</small>
          </label>
          <label>LLM 单次回复上限 (max_tokens)
            <input id="p-max-tokens" type="number" min="0" max="200000" step="256" />
            <small>0 表示不传,使用模型服务端默认;设置后每次回复被截到此长度。</small>
          </label>
        </div>
      </section>
    </div>
    <footer class="settings-footer">
      <span id="settings-msg" class="settings-msg"></span>
      <button id="btn-settings-cancel" class="btn-secondary" data-close="1">取消</button>
      <button id="btn-settings-save" class="btn-primary">保存</button>
    </footer>
  </div>
</div>

<script src="assets/app.js"></script>
</body>
</html>
