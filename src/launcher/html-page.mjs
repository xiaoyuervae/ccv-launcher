// The single-page launcher UI — Mission Control redesign (from claude.ai/design
// handoff "Wz3GOknXKXrASar1M_Y0MA"). Replaces the prior 3-column Kanban with a
// browser-style tab strip + slim ask alert + 2-col (rail + focus) + collapsible
// bottom terminal panel (Console/Shell/Logs). Mobile (≤640px) collapses the rail
// and exposes Console/Shell as fullscreen sheets via a sticky bottom action bar.
//
// Pure data — a backtick template literal with no \${...} substitutions, so
// every JS string below uses single-quote concatenation to keep backticks out
// of the template.

export const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ccv launcher</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2358a6ff'/%3E%3Ctext x='32' y='42' font-family='Inter,Arial,sans-serif' font-size='32' font-weight='700' text-anchor='middle' fill='%230d1117'%3Ecc%3C/text%3E%3C/svg%3E">
<link rel="manifest" href="/launcher/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0d1117">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<script>
  // Lazy-load xterm only on viewports that show the docked terminal (>640px).
  // Saves ~200KB + 3 cross-origin RTTs on mobile, where #term-panel is hidden.
  (function() {
    if (matchMedia('(max-width: 640px)').matches) return;
    var head = document.head;
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css';
    head.appendChild(css);
    var s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js';
    s1.async = false;
    head.appendChild(s1);
    var s2 = document.createElement('script');
    s2.src = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js';
    s2.async = false;
    head.appendChild(s2);
  })();
</script>
<style>
  :root {
    --bg:#0d1117; --bg2:#161b22; --bg3:#1c2128;
    --line:#21262d; --fg:#e6edf3; --mute:#7d8590;
    --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149;
    --ask:#ff7b72; --term:#0f1115;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: var(--bg); color: var(--fg);
    overflow-x: hidden; max-width: 100vw;
  }
  body {
    font: 13px/1.45 var(--sans);
    min-height: 100vh; min-height: 100dvh;
    display: flex; flex-direction: column;
    overflow-y: hidden;
  }

  /* ---------- app bar ---------- */
  #app-bar {
    display: flex; align-items: center; gap: 14px;
    padding: 7px 16px; flex-shrink: 0;
    background: var(--bg2); border-bottom: 1px solid var(--line);
  }
  #app-bar .logo {
    width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(135deg, var(--accent), #a371f7);
    display: flex; align-items: center; justify-content: center;
    color: var(--bg); font-weight: 800; font-size: 11px; font-family: var(--mono);
  }
  #app-bar .brand { font-weight: 600; font-size: 13px; }
  #app-bar .server { color: var(--mute); font-size: 11px; font-family: var(--mono); }
  #app-bar .grow { flex: 1; }
  #app-bar .stat-cost { display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
  #app-bar .stat-cost .lbl { color: var(--mute); }
  #app-bar .stat-cost .val { color: var(--fg); font-weight: 600; font-family: var(--mono); }
  #app-bar .stat-quota {
    display: flex; align-items: center; gap: 6px; font-size: 11px;
    padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px;
  }
  #app-bar .stat-quota .lbl { color: var(--mute); }
  #app-bar .stat-quota .val { color: var(--fg); font-weight: 600; font-family: var(--mono); }
  #app-bar .stat-quota .bar { width: 84px; height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; }
  #app-bar .stat-quota .fill { height: 100%; background: var(--ok); transition: width .25s; }
  #app-bar .stat-quota .fill.warn { background: var(--warn); }
  #app-bar .stat-quota .fill.bad { background: var(--bad); }
  #app-bar .stat-quota .warn-tag {
    color: var(--warn); font-size: 11px; line-height: 1;
    cursor: help;
  }
  #app-bar #filter {
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 9px; font-size: 11px; font-family: var(--mono);
    width: 140px; outline: none;
  }
  #app-bar #filter:focus { border-color: var(--accent); }
  #app-bar #btn-new {
    background: var(--accent); color: var(--bg);
    border: 0; padding: 5px 12px; border-radius: 5px;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  #app-bar #btn-new:hover { opacity: .9; }

  /* ---------- tab strip ---------- */
  #tab-strip {
    display: flex; gap: 0; padding: 6px 12px 0;
    background: var(--bg); border-bottom: 1px solid var(--line);
    overflow-x: auto; flex-shrink: 0;
    scrollbar-width: thin;
  }
  #tab-strip::-webkit-scrollbar { height: 4px; }
  #tab-strip::-webkit-scrollbar-thumb { background: var(--line); }
  .tab {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 12px 7px 11px;
    background: transparent;
    border-top: 1px solid transparent;
    border-left: 1px solid transparent;
    border-right: 1px solid transparent;
    border-bottom: 1px solid transparent;
    margin-bottom: -1px; margin-right: 2px;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    font-size: 12px; color: var(--mute);
    white-space: nowrap;
  }
  .tab.active {
    background: var(--bg2); color: var(--fg); font-weight: 600;
    border-top: 2px solid var(--line);
    border-left-color: var(--line);
    border-right-color: var(--line);
    border-bottom: 1px solid var(--bg2);
  }
  .tab.active.needs-ask { border-top-color: var(--ask); }
  /* 注意力指引：等回答的会话整卡淡染 + dot 脉冲，扫一眼即可定位 */
  .tab.needs-ask { background: rgba(248,81,73,.12); color: var(--fg); }
  .tab.needs-ask .dot { animation: dot-pulse 1.4s ease-in-out infinite; }
  .rail-card.needs-ask { background: rgba(248,81,73,.10); }
  .rail-card.needs-ask .ask-pill { animation: dot-pulse 1.4s ease-in-out infinite; }
  .tab.waiting-input { background: rgba(163,113,247,.10); }
  .rail-card.waiting-input { background: rgba(163,113,247,.08); }
  @keyframes dot-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(248,81,73,.55); } 50% { box-shadow: 0 0 0 4px rgba(248,81,73,0); } }
  @media (prefers-reduced-motion: reduce) {
    .tab.needs-ask .dot, .rail-card.needs-ask .ask-pill { animation: none; }
  }
  /* app-bar 等回答计数徽标 */
  #ask-count {
    background: var(--ask); color: #fff; border: none; font-weight: 700;
    font-size: 11px; min-width: 0; padding: 3px 9px; border-radius: 999px;
    animation: dot-pulse 1.4s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) { #ask-count { animation: none; } }
  /* active 实例被 filter 筛掉时仍钉住显示，弱化以示"不在当前筛选结果内" */
  .tab.filtered-pinned { opacity: .55; outline: 1px dashed var(--line); outline-offset: -2px; }
  .rail-card.filtered-pinned { opacity: .6; }
  .tab .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mute); }
  .tab .hub-tag {
    font-size: 9px; color: var(--accent); background: rgba(88,166,255,.14);
    padding: 1px 5px; border-radius: 3px; font-weight: 700; font-family: var(--mono);
  }
  .tab .port { color: var(--mute); font-family: var(--mono); font-size: 10px; }
  .tab .ask-badge {
    background: var(--ask); color: var(--bg); font-size: 9px; font-weight: 700;
    padding: 1px 5px; border-radius: 8px;
  }

  /* ---------- ask alert (slim chip row) ---------- */
  #ask-alert {
    background: rgba(248, 81, 73, .07);
    border-bottom: 1px solid rgba(248, 81, 73, .25);
    padding: 6px 16px;
    display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  }
  #ask-alert[hidden] { display: none; }
  .alert-tag {
    background: var(--ask); color: var(--bg); font-size: 10px; font-weight: 800;
    padding: 2px 8px; border-radius: 3px; font-family: var(--mono); flex-shrink: 0;
  }
  .alert-chips { display: flex; gap: 6px; flex: 1; overflow-x: auto; }
  .alert-chips::-webkit-scrollbar { height: 0; }
  .alert-chip {
    display: flex; align-items: center; gap: 6px;
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 6px; padding: 3px 10px;
    font-size: 11px; cursor: pointer; color: var(--fg);
    white-space: nowrap; flex-shrink: 0; font-family: inherit;
  }
  .alert-chip.active {
    background: rgba(248, 81, 73, .18);
    border-color: rgba(248, 81, 73, .4);
  }
  .alert-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ask); }
  .alert-chip b { font-weight: 600; }
  .alert-chip .q {
    color: var(--mute); overflow: hidden; text-overflow: ellipsis; max-width: 240px;
  }
  #ask-alert .kbd-hint { color: var(--mute); font-size: 10px; flex-shrink: 0; }
  #ask-alert kbd {
    background: var(--bg2); border: 1px solid var(--line); border-radius: 3px;
    padding: 1px 5px; font-size: 10px; font-family: var(--mono); color: var(--fg);
  }

  /* ---------- main grid: rail + focus column ---------- */
  #mc-grid {
    flex: 1; display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    min-height: 0; min-width: 0;
  }
  #rail {
    background: var(--bg); padding: 10px 8px;
    overflow: auto; border-right: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 4px;
  }
  #rail .rail-hd {
    color: var(--mute); font-size: 9px; text-transform: uppercase;
    letter-spacing: .5px; padding: 0 4px 4px;
    display: flex; align-items: center; gap: 5px;
  }
  .rail-ctl {
    background: var(--bg3); color: var(--mute); border: 1px solid var(--line);
    border-radius: 4px; font-size: 10px; padding: 1px 4px; cursor: pointer; text-transform: none;
  }
  .rail-ctl:hover { color: var(--fg); }
  #rail-group.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .rail-group-hd {
    color: var(--mute); font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
    padding: 8px 4px 3px; display: flex; align-items: center; gap: 6px;
  }
  .rail-group-hd .gc { background: var(--bg3); border-radius: 8px; padding: 0 6px; font-size: 9px; }
  .rail-card {
    background: var(--bg2);
    border: 1px solid var(--line);
    border-left: 2px solid var(--mute);
    border-radius: 4px; padding: 6px 8px; cursor: pointer;
    display: flex; flex-direction: column; gap: 2px;
  }
  .rail-card.active {
    background: var(--bg3); border-color: var(--accent);
  }
  .rail-card .top { display: flex; align-items: center; gap: 5px; }
  .rail-card .name { font-weight: 600; font-size: 11.5px; }
  .rail-card .ask-pill {
    background: var(--ask); color: var(--bg); font-size: 9px; font-weight: 700;
    padding: 0 4px; border-radius: 6px;
  }
  .rail-card .age { color: var(--mute); font-size: 9px; font-family: var(--mono); margin-left: auto; }
  .rail-card .sub {
    color: var(--mute); font-size: 10px; line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rail-card.active .sub { color: var(--fg); }

  /* rail collapsible sections (history / untracked) */
  .rail-section { margin-top: 10px; }
  .rail-section .sec-hd {
    display: flex; align-items: center; gap: 6px;
    color: var(--mute); font-size: 9px; text-transform: uppercase;
    letter-spacing: .5px; padding: 4px 6px; cursor: pointer;
    user-select: none; border-radius: 3px;
  }
  .rail-section .sec-hd:hover { background: var(--bg2); color: var(--fg); }
  .rail-section .sec-hd .caret { width: 8px; transition: transform .12s; }
  .rail-section.open .sec-hd .caret { transform: rotate(90deg); }
  .rail-section .sec-hd .count {
    margin-left: auto; background: var(--bg3);
    border-radius: 8px; padding: 1px 6px; font-size: 9px;
    font-family: var(--mono); color: var(--mute);
  }
  .rail-section.has-warn .sec-hd .count {
    background: rgba(248,81,73,.15); color: var(--ask);
  }
  .rail-section .sec-body { display: none; flex-direction: column; gap: 3px; margin-top: 3px; }
  .rail-section.open .sec-body { display: flex; }
  .rail-hist-card, .rail-untracked-card {
    background: var(--bg); border: 1px dashed var(--line);
    border-radius: 4px; padding: 5px 8px; cursor: pointer;
    display: flex; flex-direction: column; gap: 1px;
  }
  .rail-hist-card:hover, .rail-untracked-card:hover {
    border-color: var(--accent); background: var(--bg2);
  }
  .rail-hist-card .name, .rail-untracked-card .name {
    font-size: 11px; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rail-hist-card .meta, .rail-untracked-card .meta {
    color: var(--mute); font-size: 9px; font-family: var(--mono);
    display: flex; gap: 6px;
  }
  .rail-untracked-card { border-left: 2px solid var(--warn); }
  .rail-untracked-card .name::before {
    content: '◐ '; color: var(--warn);
  }
  /* expandable history card */
  .rail-hist-card .row1 {
    display: flex; align-items: center; gap: 5px;
  }
  .rail-hist-card .row1 .caret {
    width: 8px; font-size: 9px; color: var(--mute);
    transition: transform .12s;
  }
  .rail-hist-card.open .row1 .caret { transform: rotate(90deg); }
  .rail-hist-card .row1 .name { flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rail-hist-card .row1 .sess-count {
    font-size: 9px; color: var(--mute); font-family: var(--mono);
    background: var(--bg2); border-radius: 8px; padding: 0 5px;
  }
  .rail-hist-card .row1 .age {
    color: var(--mute); font-size: 9px; font-family: var(--mono);
  }
  .rail-hist-card .row1 .spawn-fresh {
    background: transparent; border: 1px solid var(--line);
    color: var(--mute); font-size: 9px; padding: 0 5px; line-height: 14px;
    border-radius: 3px; cursor: pointer;
  }
  .rail-hist-card .row1 .spawn-fresh:hover {
    border-color: var(--accent); color: var(--accent);
  }
  .rail-sess-list {
    display: flex; flex-direction: column; gap: 2px;
    margin: 4px 0 2px 12px; padding-left: 6px;
    border-left: 1px solid var(--line);
  }
  .rail-sess-card {
    background: var(--bg); border: 1px solid var(--line);
    border-radius: 3px; padding: 4px 6px; cursor: pointer;
    display: flex; flex-direction: column; gap: 1px;
  }
  .rail-sess-card:hover { border-color: var(--accent); background: var(--bg2); }
  .rail-sess-card .preview {
    font-size: 10.5px; color: var(--fg); line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rail-sess-card .preview.empty { color: var(--mute); font-style: italic; }
  .rail-sess-card .meta {
    color: var(--mute); font-size: 9px; font-family: var(--mono);
    display: flex; gap: 6px;
  }
  .rail-sess-card .meta .sid { opacity: .7; }
  .rail-sess-card .meta .age { margin-left: auto; }
  .rail-sess-empty {
    color: var(--mute); font-size: 9.5px; padding: 4px 6px;
  }
  .rail-sess-loading {
    color: var(--mute); font-size: 9.5px; padding: 4px 6px; font-style: italic;
  }

  /* ---------- focus column ---------- */
  /* #focus 占主体, 内部 overflow 滚; term-panel 固定 280px (用户可拖大). 这是
     0cd30b5 之前的经典布局: busy focus 不会把 console 挤到只剩 1 行。
     timeline 卡内部限高滚动, 避免单卡撑爆整列。 */
  #focus-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  #focus { flex: 1 1 0; min-height: 0; min-width: 0; overflow: auto; }
  .focus-inner { padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .focus-card.timeline-card .timeline { max-height: 38vh; overflow: auto; }
  .focus-hd { display: flex; flex-direction: column; gap: 3px; }
  .focus-hd .row1 { display: flex; align-items: center; gap: 8px; }
  .focus-hd h1 { font-size: 17px; font-weight: 600; letter-spacing: -.3px; margin: 0; }
  .focus-hd .meta { color: var(--mute); font-size: 11px; font-family: var(--mono); }
  .focus-hd .cwd {
    color: var(--mute); font-size: 11px; font-family: var(--mono);
    display: flex; align-items: center; gap: 6px;
  }
  .focus-hd .cwd-path { word-break: break-all; min-width: 0; flex: 1; }
  .focus-hd .topic {
    margin-top: 6px; padding: 6px 10px;
    background: var(--bg2); border-left: 2px solid var(--accent);
    border-radius: 4px;
    color: var(--fg); font-size: 12.5px; line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; text-overflow: ellipsis;
    cursor: help;
  }
  .focus-hd .topic .topic-hd {
    color: var(--mute); font-size: 10px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase;
    margin-right: 8px;
  }
  .focus-hd .topic.recent { border-left-color: var(--ok); margin-top: 4px; }
  .focus-hd .topic.recent .topic-hd { color: var(--ok); }
  .status-badge {
    font-size: 10px; font-weight: 700; padding: 2px 8px;
    border-radius: 10px; font-family: var(--mono);
  }
  .focus-hd .grow { flex: 1; }

  /* per-instance action chips (kill / alias / ccuse / copy / worktree) */
  .focus-actions {
    display: flex; gap: 6px; flex-wrap: wrap;
    margin-top: 6px; align-items: center;
  }
  .action-chip {
    background: var(--bg2); color: var(--fg);
    border: 1px solid var(--line); border-radius: 4px;
    padding: 3px 9px; font-size: 11px; cursor: pointer;
    font-family: var(--mono); line-height: 1.4;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .action-chip:hover { border-color: var(--accent); color: var(--accent); }
  .action-chip.danger:hover { border-color: var(--bad); color: var(--bad); }
  .action-chip .lbl { color: var(--mute); font-size: 9px; text-transform: uppercase; letter-spacing: .4px; }
  .action-chip .val { color: var(--fg); font-weight: 500; }
  .action-chip .caret { color: var(--mute); font-size: 9px; }
  .action-chip.cwd-copy {
    background: transparent; border-color: transparent;
    color: var(--mute); padding: 3px 6px;
  }
  .action-chip.cwd-copy:hover { color: var(--accent); background: var(--bg2); }

  /* ccuse dropdown menu */
  .ccuse-pop {
    position: absolute; z-index: 80;
    background: var(--bg2); border: 1px solid var(--line);
    border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
    padding: 4px; min-width: 160px; max-height: 280px; overflow: auto;
  }
  .ccuse-pop .opt {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; cursor: pointer; border-radius: 3px;
    font-size: 12px; font-family: var(--mono);
  }
  .ccuse-pop .opt:hover { background: var(--bg3); }
  .ccuse-pop .opt .check { width: 10px; color: var(--ok); }
  .ccuse-pop .opt.current { color: var(--accent); font-weight: 600; }
  .ccuse-pop .hdr {
    color: var(--mute); font-size: 9px; text-transform: uppercase;
    letter-spacing: .5px; padding: 4px 8px 2px;
  }
  .ccuse-pop .sep {
    height: 1px; background: var(--line); margin: 4px 0;
  }
  .ccuse-pop .opt.danger { color: var(--bad); }

  /* worktree details inside git stat box */
  .stat-box .wt-details {
    color: var(--mute); font-size: 10px; font-family: var(--mono);
    margin-top: 4px; line-height: 1.35;
    overflow: hidden; text-overflow: ellipsis;
  }
  .stat-box .wt-details .k { color: var(--mute); margin-right: 4px; }
  .stat-box .wt-details .v { color: var(--fg); }

  .btn-primary {
    background: var(--accent); color: var(--bg); border: 0;
    padding: 5px 12px; border-radius: 5px;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .btn-primary:hover { opacity: .9; }

  .focus-card {
    padding: 10px 13px; background: var(--bg2);
    border: 1px solid var(--line); border-radius: 6px;
  }
  .focus-card.accent { border-left: 3px solid var(--accent); }
  .focus-card.ask {
    background: rgba(248, 81, 73, .06);
    border: 1px solid rgba(248, 81, 73, .35);
    border-left: 3px solid var(--ask);
  }
  .focus-card.ok {
    background: rgba(63, 185, 80, .08);
    border: 1px solid rgba(63, 185, 80, .3);
    display: flex; align-items: center; gap: 8px;
  }
  .card-hd {
    color: var(--mute); font-size: 10px; text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 4px; font-weight: 600;
  }
  .focus-card.ask .card-hd { color: var(--ask); font-weight: 700; }
  .card-title { color: var(--fg); font-size: 13.5px; line-height: 1.45; font-weight: 500; }
  .card-preview {
    color: var(--mute); font-size: 11.5px; margin-top: 5px;
    font-family: var(--mono); line-height: 1.45;
  }
  .ask-q { color: var(--fg); font-size: 14px; font-weight: 500; margin-bottom: 3px; }
  .ask-ctx { color: var(--mute); font-size: 11px; margin-bottom: 9px; font-family: var(--mono); }
  .ask-choices { display: flex; gap: 6px; flex-wrap: wrap; }
  .ask-btn {
    background: transparent; color: var(--fg);
    border: 1px solid var(--line); border-radius: 5px;
    padding: 6px 13px; font-size: 12px; cursor: pointer; font-weight: 500;
  }
  .ask-btn.primary {
    background: var(--ask); color: var(--bg);
    border-color: var(--ask); font-weight: 700;
  }
  .ask-btn:hover { opacity: .92; }
  .ask-btn:disabled { opacity: .5; cursor: wait; }

  .stat-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
  }
  .stat-box {
    background: var(--bg2); border: 1px solid var(--line);
    border-radius: 6px; padding: 9px 11px;
  }
  .stat-box .hd {
    color: var(--mute); font-size: 9px; text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 6px;
  }
  .stat-box .big {
    font-size: 16px; font-weight: 600; font-family: var(--mono);
  }
  .stat-box .sub {
    color: var(--mute); font-size: 10px; font-family: var(--mono); margin-top: 4px;
  }
  .stat-box .ctx-bar {
    height: 3px; background: var(--line); border-radius: 2px;
    overflow: hidden; margin-top: 5px;
  }
  .stat-box .ctx-fill { height: 100%; background: var(--ok); }
  .stat-box .ctx-fill.warn { background: var(--warn); }
  .stat-box .ctx-fill.bad { background: var(--bad); }

  .edits-list { display: flex; flex-direction: column; gap: 3px; }
  .edit-row {
    display: flex; gap: 8px; align-items: baseline;
    font-family: var(--mono); font-size: 11px; padding: 2px 0;
  }
  .edit-tool { color: var(--warn); min-width: 48px; font-weight: 600; }
  .edit-path {
    color: var(--fg); flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .edit-n { color: var(--mute); font-size: 10px; }

  .timeline { display: flex; flex-direction: column; }
  .tl-row {
    display: flex; gap: 10px; align-items: baseline;
    padding: 7px 0; border-top: 1px solid var(--line);
  }
  .tl-row:first-child { border-top: none; padding-top: 2px; }
  .tl-time {
    color: var(--mute); font-family: var(--mono); font-size: 10.5px;
    min-width: 38px; text-align: right;
  }
  .tl-body { flex: 1; min-width: 0; }
  .tl-tool {
    color: var(--warn); font-family: var(--mono); font-size: 11.5px;
    font-weight: 600; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; display: block;
  }
  .tl-text {
    color: #a5d6ff; font-size: 12px; line-height: 1.4;
    margin-top: 3px; word-break: break-word;
  }
  .tl-user { color: var(--fg); }
  .tl-dur {
    color: var(--mute); font-family: var(--mono); font-size: 10px;
    min-width: 38px; text-align: right;
  }

  /* ---------- bottom terminal panel ---------- */
  /* 固定 280px (用户拖 #term-handle 可覆盖到接近窗口高度). Collapsed → 32px. */
  #term-panel {
    border-top: 1px solid var(--line); background: var(--term);
    display: flex; flex-direction: column;
    flex: 0 0 280px; min-height: 0; transition: flex-basis .15s;
  }
  #term-panel.collapsed { flex: 0 0 32px; }
  #term-handle {
    height: 4px; cursor: ns-resize;
    background: linear-gradient(180deg, var(--bg2), transparent);
  }
  #term-tabs {
    display: flex; align-items: center; padding: 0 12px;
    background: var(--bg2); border-bottom: 1px solid var(--line);
    height: 28px; flex-shrink: 0;
  }
  #term-panel.collapsed #term-tabs { border-bottom: 0; }
  .term-tab {
    display: flex; align-items: center; gap: 6px; height: 28px;
    padding: 0 12px; cursor: pointer; font-size: 11px;
    color: var(--mute); font-weight: 500;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .term-tab.active { color: var(--fg); font-weight: 600; }
  .term-tab.disabled { opacity: .45; }
  .term-tab.disabled .tag::after { content: ' ⊘'; }
  .term-tab.active.console { border-bottom-color: var(--accent); }
  .term-tab.active.shell   { border-bottom-color: var(--ok); }
  .term-tab.active.logs    { border-bottom-color: var(--warn); }
  .term-tab .tag {
    font-size: 9px; font-weight: 700; padding: 1px 5px;
    border-radius: 3px; font-family: var(--mono); text-transform: uppercase;
  }
  .term-tab.console .tag { background: rgba(88,166,255,.13); color: var(--accent); }
  .term-tab.shell   .tag { background: rgba(63,185,80,.13);  color: var(--ok); }
  .term-tab.logs    .tag { background: rgba(210,153,34,.13); color: var(--warn); }
  .term-tab .sub { font-family: var(--mono); font-size: 10px; opacity: .8; }
  #term-tabs .grow { flex: 1; }
  .term-hdr-btn {
    background: transparent; color: var(--mute); border: 0;
    padding: 4px 9px; font-size: 12px; cursor: pointer; font-family: var(--mono);
  }
  .term-hdr-btn:hover { color: var(--fg); }
  #term-body {
    flex: 1; min-height: 0; overflow: hidden;
    position: relative;
  }
  #term-panel.collapsed #term-body { display: none; }
  .term-pane {
    position: absolute; inset: 0;
    display: none;
    flex-direction: column;
  }
  .term-pane.active { display: flex; }
  .term-xterm-host {
    flex: 1; min-height: 0;
    padding: 6px 8px;
  }
  .term-logs-host {
    flex: 1; min-height: 0; overflow: auto;
    padding: 8px 12px;
    font-family: var(--mono); font-size: 12px; line-height: 1.45;
    color: var(--fg);
  }
  .term-logs-host .empty { color: var(--mute); font-style: italic; }
  .term-logs-host .line { white-space: pre-wrap; word-break: break-all; }
  .term-logs-host .line.warn { color: var(--warn); }
  .term-logs-host .line.err  { color: var(--bad); }

  /* ---------- mobile-only sticky bottom bar + sheets ---------- */
  #mobile-bar { display: none; }
  #term-sheet, #ccv-overlay { display: none; }
  #ccv-overlay.open, #term-sheet.open { display: flex; }

  #term-sheet {
    position: fixed; inset: 0; background: var(--term);
    z-index: 50; flex-direction: column;
  }
  #term-sheet .sheet-hd {
    background: var(--bg2); border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    flex-shrink: 0;
  }
  #term-sheet .sheet-hd .tag {
    font-size: 9px; font-weight: 700; padding: 1px 5px;
    border-radius: 3px; font-family: var(--mono); text-transform: uppercase;
  }
  #term-sheet .sheet-hd .name { font-weight: 600; font-size: 12px; }
  #term-sheet .sheet-hd .grow { flex: 1; }
  #term-sheet .sheet-hd button {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--line);
    border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  #term-sheet .sheet-body { flex: 1; min-height: 0; padding: 6px 8px; }

  /* ---------- ccv iframe overlay (kept; works on desktop + mobile) ---------- */
  #ccv-overlay {
    position: fixed; inset: 0; background: var(--bg); z-index: 60;
    flex-direction: column;
  }
  #ccv-overlay .ov-hd {
    background: var(--bg2); border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    flex-shrink: 0;
  }
  #ccv-overlay .ov-hd .tag {
    background: rgba(88,166,255,.13); color: var(--accent);
    font-size: 9px; font-weight: 700; padding: 1px 5px;
    border-radius: 3px; font-family: var(--mono);
  }
  #ccv-overlay .ov-hd .name { font-weight: 600; font-size: 12px; }
  #ccv-overlay .ov-hd .port { color: var(--mute); font-family: var(--mono); font-size: 11px; }
  #ccv-overlay .ov-hd .path { color: var(--mute); font-family: var(--mono); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ccv-overlay .ov-hd button {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--line);
    border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  #ccv-overlay #ccv-frames {
    position: relative; flex: 1; min-height: 0; background: var(--bg);
  }
  #ccv-overlay #ccv-frames iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; background: var(--bg);
  }
  #ccv-overlay #ccv-frames iframe.hidden {
    display: none;
  }
  #ccv-overlay .ov-hd .grow { flex: 1; }
  #ccv-tabs {
    display: flex; align-items: center; gap: 4px;
    overflow-x: auto; min-width: 0;
  }
  #ccv-tabs::-webkit-scrollbar { display: none; }
  .ccv-tab {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 4px 3px 10px; cursor: pointer;
    background: var(--bg3); color: var(--fg);
    border: 1px solid var(--line); border-radius: 5px;
    font-size: 11px; font-family: var(--mono);
    max-width: 200px;
    user-select: none; white-space: nowrap;
  }
  .ccv-tab:hover { border-color: var(--accent); }
  .ccv-tab.active {
    background: var(--accent); color: var(--bg);
    border-color: var(--accent); font-weight: 600;
  }
  .ccv-tab .nm {
    overflow: hidden; text-overflow: ellipsis;
    max-width: 120px;
  }
  .ccv-tab .port { opacity: .7; font-size: 10px; }
  .ccv-tab .x {
    border: 0; background: transparent;
    color: inherit; opacity: .6; cursor: pointer;
    padding: 0 4px; font-size: 13px; line-height: 1;
    border-radius: 3px;
  }
  .ccv-tab .x:hover { opacity: 1; background: rgba(0,0,0,.18); }
  .ccv-tab.active .x:hover { background: rgba(255,255,255,.22); }
  #ccv-frame-err {
    display: none; position: absolute; inset: 41px 0 0 0;
    background: rgba(13, 17, 23, .96); color: var(--fg);
    flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; padding: 24px;
  }
  #ccv-frame-err.show { display: flex; }
  #ccv-frame-err .err-title { font-size: 15px; font-weight: 600; color: var(--bad); }
  #ccv-frame-err .err-actions { display: flex; gap: 8px; }
  #ccv-frame-err button {
    background: var(--accent); color: var(--bg); border: 0;
    padding: 6px 14px; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  #ccv-frame-err button.secondary { background: var(--bg3); color: var(--fg); border: 1px solid var(--line); }

  /* ---------- +New dialog ---------- */
  dialog#dlg {
    background: var(--bg2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 10px; padding: 18px; min-width: 420px; max-width: 520px;
    box-shadow: 0 10px 32px rgba(0,0,0,.5);
  }
  dialog::backdrop { background: rgba(0,0,0,.55); }
  dialog#dlg h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
  dialog#dlg .label { color: var(--mute); font-size: 11px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
  dialog#dlg input[type="text"] {
    width: 100%; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 10px; font-size: 12px; font-family: var(--mono);
    outline: none;
  }
  dialog#dlg input[type="text"]:focus { border-color: var(--accent); }
  dialog#dlg .tree {
    max-height: 200px; overflow: auto; margin-top: 8px;
    border: 1px solid var(--line); border-radius: 6px;
    font-family: var(--mono); font-size: 11px;
    background: var(--bg);
  }
  dialog#dlg .tree-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px; cursor: pointer;
  }
  dialog#dlg .tree-row:hover { background: var(--bg3); }
  dialog#dlg .tree-row .name { color: var(--fg); }
  dialog#dlg .tree-row.parent .name { color: var(--accent); }
  dialog#dlg .err {
    color: var(--bad); font-size: 11px; margin-top: 8px;
    padding: 6px 8px; background: rgba(248, 81, 73, .1);
    border: 1px solid rgba(248, 81, 73, .3); border-radius: 4px;
  }
  dialog#dlg .err[hidden] { display: none; }
  dialog#dlg .field { margin-top: 10px; }
  dialog#dlg select {
    width: 100%; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 10px; font-size: 12px; font-family: var(--mono);
    outline: none;
  }
  dialog#dlg select:focus { border-color: var(--accent); }
  dialog#dlg .field-hint { color: var(--mute); font-size: 10px; margin-top: 3px; }
  dialog#dlg label.cb {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--fg); cursor: pointer;
  }
  dialog#dlg .row {
    display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px;
  }
  dialog#dlg .row button {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 14px; font-size: 12px; cursor: pointer;
  }
  dialog#dlg .row button.primary {
    background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600;
  }

  /* ---------- empty / loading states ---------- */
  .empty {
    color: var(--mute); text-align: center;
    padding: 40px 24px; font-size: 13px;
  }

  /* ---------- mobile (≤640px) ---------- */
  @media (max-width: 640px) {
    /* Base typography: iOS reads 13px as "tiny". 15px is the natural body
       size on phones; iOS also won't auto-zoom inputs that are ≥16px. */
    body { font-size: 15px; line-height: 1.5; }
    .focus-inner { gap: 14px; padding: 14px 14px; }
    .focus-hd { gap: 6px; }
    .focus-card { padding: 12px 14px; }
    .card-hd { font-size: 11px; margin-bottom: 6px; }
    .card-title { font-size: 14.5px; line-height: 1.5; }
    .focus-hd .topic { font-size: 13px; padding: 8px 28px 8px 10px; }
    .focus-hd .topic .topic-hd { font-size: 10px; }

    /* App bar: sticky, single row, safe-area handled here (not body) */
    #app-bar {
      position: sticky; top: 0; z-index: 50;
      background: rgba(13,17,23,.92);
      -webkit-backdrop-filter: saturate(160%) blur(10px);
      backdrop-filter: saturate(160%) blur(10px);
      padding: calc(env(safe-area-inset-top) + 8px) 12px 8px;
      flex-wrap: nowrap; gap: 8px; height: auto;
    }
    #app-bar .brand,
    #app-bar .server,
    #app-bar #filter,
    #app-bar .stat-quota .bar { display: none; }
    #app-bar .grow { flex: 1; }
    #app-bar .logo { width: 28px; height: 28px; font-size: 13px; }
    #app-bar .stat-cost, #app-bar .stat-quota {
      font-size: 11px; padding: 4px 8px;
    }
    #btn-new {
      padding: 9px 14px; font-size: 13px; font-weight: 700;
      min-height: 36px;
    }
    #app-bar #btn-notif {
      width: 36px; height: 36px; font-size: 16px;
    }

    /* Tab strip: horizontal scroll, no scrollbar, sticky under app bar */
    #tab-strip {
      position: sticky; top: 52px; z-index: 49;
      background: var(--bg);
      padding: 8px 12px; gap: 6px;
      border-bottom: 1px solid var(--line);
      overflow-x: auto; overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scroll-snap-type: x proximity;
      scrollbar-width: none;
      flex-wrap: nowrap;
    }
    #tab-strip::-webkit-scrollbar { display: none; }
    .tab {
      flex: 0 0 auto;
      scroll-snap-align: start;
      border: 1px solid var(--line); border-radius: 999px;
      padding: 7px 13px; margin: 0; background: transparent;
      min-height: 34px; font-size: 13px;
    }
    .tab.active {
      background: var(--bg2); border-color: var(--accent);
      border-radius: 999px; border-top-width: 1px;
    }
    .tab.active.needs-ask { border-color: var(--ask); }
    .tab .port { display: none; }
    .tab .hub-tag { display: none; }

    /* Ask alert: compact strip, not a giant card. Hide the "N 等回答" tag
       (the chip's red left bar + dot already say "ask"), single-line chip
       with name + question, full-width tap. */
    #ask-alert {
      flex-direction: column; align-items: stretch;
      background: rgba(248,81,73,.08);
      border-top: 1px solid rgba(248,81,73,.25);
      border-bottom: 1px solid rgba(248,81,73,.25);
      margin: 0; padding: 6px 12px;
    }
    #ask-alert .alert-tag { display: none; }
    .alert-chips { flex-direction: column; gap: 4px; overflow: visible; }
    .alert-chip {
      background: var(--bg2); border-left: 3px solid var(--ask);
      border-radius: 6px; padding: 8px 10px;
      align-items: center; flex-direction: row; gap: 6px;
      white-space: nowrap; min-height: 38px;
      overflow: hidden;
    }
    .alert-chip .q {
      max-width: none; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;
    }
    #ask-alert .kbd-hint { display: none; }

    /* Layout: single column, no rail, no docked terminal */
    #mc-grid { grid-template-columns: 1fr; }
    #rail { display: none; }
    #term-panel { display: none; }
    #focus { padding-bottom: calc(96px + env(safe-area-inset-bottom)); }
    .focus-inner { padding: 12px 14px; gap: 10px; }
    .focus-hd h1 { font-size: 16px; }

    /* Header: hide redundant "Open ccv" + pid/port meta + row1 status badge
       (the "现在在做的事" card below already conveys the same status with
       a clearer label and avoids iOS's weird ⌨/⏸ glyph fallbacks). */
    .focus-hd .row1 .btn-primary[data-act="open-ccv"] { display: none; }
    .focus-hd .row1 .meta { display: none; }
    .focus-hd .row1 .status-badge { display: none; }
    .focus-hd .row1 { gap: 10px; row-gap: 6px; flex-wrap: wrap; }
    .focus-hd h1 { font-size: 18px; line-height: 1.25; }

    /* Topic quotes (第一条 / 最近一条): clamp to 1 line, tap to expand.
       Current Chromium aliases display:-webkit-box to flow-root, which
       disables -webkit-line-clamp. Use classic nowrap+ellipsis for the
       single-line case; the expanded state restores wrapping. */
    .focus-hd .topic {
      display: block;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      cursor: pointer; position: relative;
      padding-right: 28px;
    }
    .focus-hd .topic::after {
      content: '▾'; position: absolute; right: 8px; top: 50%;
      transform: translateY(-50%); color: var(--mute); font-size: 10px;
    }
    .focus-hd .topic.expanded {
      white-space: normal; overflow: visible; text-overflow: clip;
    }
    .focus-hd .topic.expanded::after { content: '▴'; }

    /* cwd: show tail of path on overflow, copy chip stays right */
    .focus-hd .cwd { font-size: 12px; }
    .focus-hd .cwd-path {
      flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      direction: rtl; text-align: left; unicode-bidi: plaintext;
    }
    .action-chip.cwd-copy { padding: 8px 10px; min-height: 32px; }

    /* Action chips: comfy tap targets */
    .focus-actions { gap: 8px; margin-top: 8px; }
    .action-chip {
      padding: 8px 12px; font-size: 12px;
      min-height: 36px; border-radius: 6px;
    }
    .action-chip .lbl { font-size: 10px; }

    /* Ask choices: full-width tap targets, primary big */
    .ask-choices { gap: 8px; flex-direction: column; }
    .ask-btn {
      width: 100%; min-height: 44px; padding: 11px 14px;
      font-size: 14px; border-radius: 8px;
      justify-content: center; text-align: center;
    }

    /* Stat boxes: 2-col is fine on phone (CONTEXT + COST), since GIT is
       hidden when no worktree. If a worktree exists, the third box wraps
       to a new row at half width, which still reads cleanly. */
    .stat-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
    .stat-box { padding: 10px 12px; }
    .stat-box .big { font-size: 16px; }
    .stat-box .sub { font-size: 11px; margin-top: 4px; }

    /* Recent edits: bigger font, RTL-trick ellipsis to keep filename visible */
    .edits-list { gap: 6px; }
    .edit-row {
      font-size: 12.5px; padding: 4px 0; gap: 10px;
    }
    .edit-tool { font-size: 11px; min-width: 42px; }
    .edit-path {
      direction: rtl; text-align: left; unicode-bidi: plaintext;
    }
    .edit-n { font-size: 11px; }

    /* Bottom action bar: safe-area, ≥44px tap targets */
    #mobile-bar {
      display: flex; gap: 8px;
      position: fixed; left: 0; right: 0; bottom: 0;
      padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
      background: linear-gradient(180deg, transparent, rgba(13,17,23,.85) 30%, var(--bg2));
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      border-top: 1px solid var(--line);
      z-index: 40;
    }
    /* lift toasts above the sticky mobile action bar (body-prefixed so this beats
       the later base #toast-host rule, which has equal specificity + later source order) */
    body #toast-host { bottom: calc(82px + env(safe-area-inset-bottom, 0)); }
    #mobile-bar .primary {
      flex: 1.4; background: var(--accent); color: var(--bg); border: 0;
      padding: 12px 14px; border-radius: 10px;
      font-size: 15px; font-weight: 700; cursor: pointer;
      min-height: 44px;
    }
    #mobile-bar .secondary {
      flex: 1; background: var(--bg3); color: var(--fg);
      border: 1px solid var(--line);
      padding: 12px 12px; border-radius: 10px; font-size: 14px;
      cursor: pointer; min-height: 44px;
    }
  }

  /* ---------- notification settings ---------- */
  #app-bar .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 28px;
    background: transparent; border: 1px solid var(--line);
    border-radius: 5px; color: var(--fg);
    font-size: 14px; cursor: pointer;
    transition: background .15s, border-color .15s;
  }
  #app-bar .icon-btn:hover { background: var(--bg3); }
  #app-bar .icon-btn[data-on="1"] { border-color: var(--accent); color: var(--accent); }
  dialog#notif-dlg {
    background: var(--bg2); color: var(--fg);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 16px 18px; min-width: 360px; max-width: 480px;
    font-size: 13px;
  }
  dialog#notif-dlg::backdrop { background: rgba(0,0,0,.4); }
  dialog#notif-dlg h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
  dialog#notif-dlg .row-flex { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
  dialog#notif-dlg label { cursor: pointer; }
  dialog#notif-dlg .perm-badge {
    font-family: var(--mono); font-size: 11px;
    padding: 2px 8px; border-radius: 4px;
  }
  dialog#notif-dlg .perm-badge.granted { background:#1a3a1f; color:#56d364; }
  dialog#notif-dlg .perm-badge.denied  { background:#3a1a1a; color:#f85149; }
  dialog#notif-dlg .perm-badge.default { background:#2a2a2a; color:#a0a0a0; }
  dialog#notif-dlg .perm-badge.unsupported { background:#2a2a2a; color:#a0a0a0; }
  dialog#notif-dlg button {
    background: var(--bg3); color: var(--fg);
    border: 1px solid var(--line); border-radius: 5px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  dialog#notif-dlg button:hover { background: var(--bg); }
  dialog#notif-dlg .hint { color: var(--mute); font-size: 11px; margin: 8px 0 0; }
  dialog#notif-dlg .actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }

  /* ---- toast ---- */
  #toast-host {
    position: fixed; right: 14px; bottom: 14px; z-index: 9000;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    pointer-events: none;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .toast {
    pointer-events: auto; min-width: 180px; max-width: 360px;
    background: var(--bg2); color: var(--fg);
    border: 1px solid var(--line); border-left: 3px solid var(--mute);
    border-radius: 7px; padding: 9px 12px; font-size: 12.5px; line-height: 1.4;
    box-shadow: 0 6px 24px rgba(0,0,0,.4);
    display: flex; align-items: flex-start; gap: 8px;
    animation: toast-in .16s ease;
  }
  .toast.ok   { border-left-color: var(--ok); }
  .toast.warn { border-left-color: var(--warn); }
  .toast.bad  { border-left-color: var(--bad); }
  .toast .ic { font-weight: 700; }
  .toast.ok .ic { color: var(--ok); }
  .toast.warn .ic { color: var(--warn); }
  .toast.bad .ic { color: var(--bad); }
  .toast .msg { flex: 1; word-break: break-word; }
  .toast .n { color: var(--mute); font-family: var(--mono); font-size: 11px; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .toast.leaving { opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s; }

  /* ---- confirm dialog ---- */
  dialog#confirm-dlg {
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--bg2); color: var(--fg); padding: 0; max-width: 420px; width: calc(100vw - 32px);
  }
  dialog#confirm-dlg::backdrop { background: rgba(0,0,0,.5); }
  dialog#confirm-dlg .body { padding: 18px 18px 0; }
  dialog#confirm-dlg h3 { margin: 0 0 8px; font-size: 14px; }
  dialog#confirm-dlg .txt { font-size: 12.5px; color: var(--mute); line-height: 1.5; white-space: pre-wrap; }
  dialog#confirm-dlg .actions { display: flex; gap: 8px; justify-content: flex-end; padding: 16px 18px 18px; }
  dialog#confirm-dlg button {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 14px; font-size: 12.5px; cursor: pointer;
  }
  dialog#confirm-dlg button:hover { background: var(--bg); }
  dialog#confirm-dlg button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
  dialog#confirm-dlg button.danger  { background: var(--bad); color: #fff; border-color: var(--bad); font-weight: 600; }

  /* ---- help overlay ---- */
  #help-overlay {
    position: fixed; inset: 0; z-index: 8500; display: none;
    align-items: center; justify-content: center; background: rgba(0,0,0,.55);
  }
  #help-overlay.open { display: flex; }
  #help-overlay .panel {
    background: var(--bg2); border: 1px solid var(--line); border-radius: 10px;
    padding: 18px 20px; max-width: 440px; width: calc(100vw - 32px);
    max-height: 80vh; overflow: auto;
  }
  #help-overlay h3 { margin: 0 0 12px; font-size: 14px; }
  #help-overlay .krow { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12.5px; }
  #help-overlay .krow kbd {
    font-family: var(--mono); background: var(--bg3); border: 1px solid var(--line);
    border-radius: 4px; padding: 1px 7px; font-size: 11px; min-width: 22px; text-align: center;
  }
  #help-overlay .krow .desc { color: var(--mute); }

  /* ---- command palette ---- */
  #cmd-palette {
    position: fixed; inset: 0; z-index: 8800; display: none;
    align-items: flex-start; justify-content: center; background: rgba(0,0,0,.5);
    padding-top: 12vh;
  }
  #cmd-palette.open { display: flex; }
  #cmd-palette .box {
    width: 560px; max-width: calc(100vw - 24px); max-height: 64vh;
    background: var(--bg2); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0,0,0,.5); display: flex; flex-direction: column; overflow: hidden;
  }
  #cmd-palette input {
    background: var(--bg); color: var(--fg); border: none; border-bottom: 1px solid var(--line);
    padding: 12px 14px; font-size: 14px; outline: none;
  }
  #cmd-palette .results { overflow: auto; padding: 6px; }
  #cmd-palette .pi {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  #cmd-palette .pi.sel { background: var(--bg3); }
  #cmd-palette .pi .pi-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #cmd-palette .pi .pi-sub { color: var(--mute); font-size: 11px; font-family: var(--mono); }
  #cmd-palette .pi-empty { padding: 14px; color: var(--mute); font-size: 12.5px; text-align: center; }

  /* ---- ops panel ---- */
  dialog#ops-dlg {
    border: 1px solid var(--line); border-radius: 10px; background: var(--bg2); color: var(--fg);
    padding: 0; width: calc(100vw - 32px);
  }
  dialog#ops-dlg::backdrop { background: rgba(0,0,0,.5); }
  dialog#ops-dlg h3 { margin: 0 0 12px; font-size: 14px; }
  dialog#ops-dlg .ops-sec { margin: 0 0 14px; }
  dialog#ops-dlg .ops-sec .hd { font-size: 11px; color: var(--mute); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; }
  dialog#ops-dlg .ops-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 3px 0; }
  dialog#ops-dlg .ops-row .v { font-family: var(--mono); color: var(--fg); }
  dialog#ops-dlg .ops-row .v.ok { color: var(--ok); }
  dialog#ops-dlg .ops-row .v.warn { color: var(--warn); }
  dialog#ops-dlg .ops-row .v.bad { color: var(--bad); }
  dialog#ops-dlg .ops-mini { font-size: 11px; color: var(--mute); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dialog#ops-dlg button {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 14px; font-size: 12.5px; cursor: pointer;
  }
  dialog#ops-dlg button:hover { background: var(--bg); }
  dialog#ops-dlg button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }

  /* ---------- view toggle (app-bar 总览/详情) ---------- */
  #view-toggle { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  #view-toggle button {
    background: transparent; color: var(--mute); border: 0;
    padding: 5px 10px; font-size: 11px; cursor: pointer; font-family: inherit;
  }
  #view-toggle button + button { border-left: 1px solid var(--line); }
  #view-toggle button.on { background: var(--accent); color: var(--bg); font-weight: 600; }
  #view-toggle button:not(.on):hover { color: var(--fg); background: var(--bg3); }

  /* ---------- overview board ---------- */
  /* hidden attr must beat the explicit display on #mc-grid / #overview */
  #mc-grid[hidden], #overview[hidden] { display: none; }
  #overview { flex: 1; min-height: 0; min-width: 0; overflow: auto; background: var(--bg); }
  .board {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px; padding: 14px 16px; align-items: start; min-width: 0;
  }
  .board-col {
    background: var(--bg); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px; min-width: 0;
    display: flex; flex-direction: column; gap: 6px;
  }
  .board-col-hd {
    display: flex; align-items: center; gap: 6px;
    color: var(--mute); font-size: 10px; text-transform: uppercase;
    letter-spacing: .5px; padding: 2px 4px; font-weight: 600;
  }
  .board-col-hd .gc {
    margin-left: auto; background: var(--bg3); border-radius: 8px;
    padding: 0 7px; font-size: 10px; font-family: var(--mono); color: var(--mute);
  }
  .board-col[data-col="attention"] .board-col-hd { color: var(--ask); }
  .board-col-body { display: flex; flex-direction: column; gap: 6px; min-height: 24px; }
  .board-empty { color: var(--mute); font-size: 11px; text-align: center; padding: 10px 0; opacity: .6; }
  .board-card {
    background: var(--bg2); border: 1px solid var(--line);
    border-left: 3px solid var(--mute);
    border-radius: 6px; padding: 9px 11px; cursor: pointer;
    display: flex; flex-direction: column; gap: 5px; min-width: 0;
  }
  .board-card:hover { border-color: var(--accent); }
  .board-card.active { border-color: var(--accent); background: var(--bg3); }
  .board-card.needs-ask { background: rgba(248,81,73,.10); border-left-color: var(--ask) !important; }
  .board-card.needs-ask .bc-badge { animation: dot-pulse 1.4s ease-in-out infinite; }
  .board-card.waiting-input { background: rgba(163,113,247,.08); }
  @media (prefers-reduced-motion: reduce) { .board-card.needs-ask .bc-badge { animation: none; } }
  .board-card .bc-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .board-card .bc-name {
    font-weight: 600; font-size: 12px; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .board-card .bc-badge {
    flex-shrink: 0; font-size: 9px; font-weight: 700; padding: 1px 6px;
    border-radius: 8px; font-family: var(--mono); white-space: nowrap;
  }
  .board-card .bc-age {
    margin-left: auto; flex-shrink: 0; color: var(--mute);
    font-size: 9px; font-family: var(--mono);
  }
  .board-card .bc-topic {
    color: var(--fg); font-size: 12px; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; text-overflow: ellipsis; word-break: break-word;
  }
  .board-card .bc-act {
    color: var(--warn); font-size: 11px; font-family: var(--mono); line-height: 1.35;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .board-card .bc-foot { color: var(--mute); font-size: 10px; font-family: var(--mono); }
  @media (max-width: 640px) {
    .board { grid-template-columns: 1fr; gap: 10px; padding: 12px; }
    .board-card { padding: 11px 13px; }
    .board-card .bc-name { font-size: 13.5px; }
    .board-card .bc-topic { font-size: 13px; }
    .board-card .bc-act { font-size: 12px; }
  }
</style>
</head>
<body>

<header id="app-bar">
  <div class="logo">cc</div>
  <span class="brand">ccv launcher</span>
  <span class="server" id="srv">—</span>
  <span class="grow"></span>
  <div class="stat-cost" id="stat-cost" title="今日累计 (cache_read 含)">
    <span class="lbl">今日</span><span class="val" id="cost-today">—</span>
  </div>
  <div class="stat-quota" id="stat-quota" title="5h sliding window">
    <span class="lbl">5h</span>
    <span class="warn-tag" id="quota-warn" hidden>⚠</span>
    <span class="val" id="quota-val">—</span>
    <div class="bar"><div class="fill" id="quota-fill" style="width:0"></div></div>
  </div>
  <div id="view-toggle" title="总览 / 详情 切换 (V)">
    <button type="button" data-view="overview">总览</button>
    <button type="button" data-view="focus">详情</button>
  </div>
  <input type="text" id="filter" placeholder="filter  /" spellcheck="false" autocomplete="off">
  <button id="ask-count" class="icon-btn" type="button" hidden title="跳到下一个等回答的会话 (J)" aria-label="等回答会话数"></button>
  <button id="btn-notif" class="icon-btn" type="button" title="通知设置" aria-label="通知设置">🔔</button>
  <button id="btn-new">+ New</button>
</header>

<nav id="tab-strip"><div class="empty" style="padding:8px 12px;font-size:11px">loading…</div></nav>

<div id="ask-alert" hidden></div>

<main id="mc-grid">
  <aside id="rail"><div class="empty" style="padding:10px 4px">loading…</div></aside>
  <section id="focus-col">
    <div id="focus"><div class="empty">select a session</div></div>
    <div id="term-panel">
      <div id="term-handle"></div>
      <div id="term-tabs">
        <div class="term-tab console active" data-tab="console">
          <span class="tag">Console</span><span class="sub" id="term-console-sub">:—</span>
        </div>
        <div class="term-tab shell" data-tab="shell">
          <span class="tag">Shell</span><span class="sub">bash</span>
        </div>
        <div class="term-tab logs" data-tab="logs">
          <span class="tag">Logs</span><span class="sub">ccv.log</span>
        </div>
        <span class="grow"></span>
        <button class="term-hdr-btn" id="term-clear" title="清屏">⟲</button>
        <button class="term-hdr-btn" id="term-toggle" title="收起 / 展开">▾</button>
      </div>
      <div id="term-body">
        <div class="term-pane active" data-tab="console"><div class="term-xterm-host" id="host-console"></div></div>
        <div class="term-pane" data-tab="shell"><div class="term-xterm-host" id="host-shell"></div></div>
        <div class="term-pane" data-tab="logs"><div class="term-logs-host" id="host-logs"><div class="empty">ccv 启动后日志会在这里流式显示</div></div></div>
      </div>
    </div>
  </section>
</main>

<main id="overview" hidden><div class="board" id="board-cols"></div></main>

<div id="mobile-bar">
  <button class="primary" id="mob-ccv">↗ 打开 ccv</button>
  <button class="secondary" id="mob-console">Console</button>
  <button class="secondary" id="mob-shell">Shell</button>
</div>

<div id="term-sheet">
  <div class="sheet-hd">
    <span class="tag" id="sheet-tag" style="background:rgba(88,166,255,.13);color:var(--accent)">CONSOLE</span>
    <span class="name" id="sheet-name">—</span>
    <span class="grow"></span>
    <button id="sheet-close">Close</button>
  </div>
  <div class="sheet-body" id="sheet-body"></div>
</div>

<div id="ccv-overlay">
  <div class="ov-hd">
    <span class="tag">CCV</span>
    <div id="ccv-tabs"></div>
    <span class="grow"></span>
    <button id="ccv-newtab" title="在浏览器新 tab 打开当前 session">↗</button>
    <button id="ccv-reload" title="刷新当前 tab">⟳</button>
    <button id="ccv-close" title="关闭 (Esc) — iframe 保留在内存中">Close</button>
  </div>
  <div id="ccv-frames"></div>
  <div id="ccv-frame-err">
    <div class="err-title">⚠ Failed to load ccv</div>
    <div id="ccv-err-detail" style="color:var(--mute);font-size:12px">The ccv at this port did not respond.</div>
    <div class="err-actions">
      <button id="ccv-err-retry">Retry</button>
      <button id="ccv-err-newtab" class="secondary">Open in new tab</button>
    </div>
  </div>
</div>

<dialog id="dlg">
  <h2>Launch new instance</h2>
  <div class="label">Directory</div>
  <input type="text" id="new-cwd" placeholder="/path/to/project">
  <div class="tree" id="new-tree"></div>
  <div class="field" id="new-ccuse-field" hidden>
    <div class="label">CCUse profile</div>
    <select id="new-ccuse"></select>
    <div class="field-hint">下次在这个目录起 ccv 会默认用该 profile</div>
  </div>
  <div class="err" id="new-err" hidden></div>
  <div class="row">
    <button id="new-cancel">Cancel</button>
    <button id="new-launch" class="primary">Launch</button>
  </div>
</dialog>

<dialog id="notif-dlg" aria-label="通知设置">
  <h2>通知设置</h2>
  <div class="row-flex">
    <label><input type="checkbox" id="notif-enabled"> 启用桌面通知</label>
    <span id="notif-perm" class="perm-badge default">default</span>
    <button id="notif-req-perm" type="button">请求权限</button>
  </div>
  <div class="row-flex">
    <label><input type="checkbox" id="notif-sound" checked> 启用声音蜂鸣</label>
    <button id="notif-test" type="button">试发通知</button>
  </div>
  <hr style="border:none;border-top:1px solid var(--line);margin:10px 0">
  <h2 style="font-size:13px">手机推送 (PWA / Web Push)</h2>
  <div class="row-flex">
    <span id="push-status" class="perm-badge default">未启用</span>
    <button id="push-subscribe" type="button">订阅</button>
    <button id="push-unsubscribe" type="button">取消订阅</button>
    <button id="push-test" type="button">发测试推送</button>
  </div>
  <p class="hint">iOS 用户：先把 launcher「添加到主屏幕」，再从主屏图标打开后再来订阅。</p>
  <p class="hint" id="push-caps"></p>
  <p class="hint">触发场景：等待回答 / 工具等待授权 / 完成一轮 / 出错。同一事件 5 分钟内只提醒一次。</p>
  <p class="hint" id="notif-caps"></p>
  <div class="actions">
    <button id="notif-close" type="button">关闭</button>
  </div>
</dialog>

<div id="toast-host" role="status" aria-live="polite"></div>

<dialog id="confirm-dlg" aria-modal="true">
  <div class="body">
    <h3 id="confirm-title">确认</h3>
    <div class="txt" id="confirm-text"></div>
  </div>
  <div class="actions">
    <button type="button" id="confirm-cancel">取消</button>
    <button type="button" id="confirm-ok" class="primary">确定</button>
  </div>
</dialog>

<div id="cmd-palette" role="dialog" aria-modal="true" aria-label="命令面板">
  <div class="box">
    <input type="text" id="cmd-input" placeholder="跳转会话或执行操作…" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="cmd-results">
    <div class="results" id="cmd-results" role="listbox"></div>
  </div>
</div>

<dialog id="ops-dlg" aria-label="运维面板">
  <div class="body" id="ops-body" style="padding:18px 18px 0;min-width:340px;max-width:480px"></div>
  <div class="actions" style="display:flex;gap:8px;justify-content:flex-end;padding:16px 18px 18px">
    <button type="button" id="ops-refresh">刷新</button>
    <button type="button" id="ops-close" class="primary">关闭</button>
  </div>
</dialog>

<div id="help-overlay" role="dialog" aria-modal="true" aria-label="键盘快捷键">
  <div class="panel">
    <h3>键盘快捷键</h3>
    <div class="krow"><kbd>/</kbd><span class="desc">聚焦筛选框</span></div>
    <div class="krow"><kbd>1</kbd>–<kbd>9</kbd><span class="desc">切换到第 N 个会话</span></div>
    <div class="krow"><kbd>j</kbd><span class="desc">跳到下一个等回答的会话</span></div>
    <div class="krow"><kbd>c</kbd><span class="desc">新建会话</span></div>
    <div class="krow"><kbd>w</kbd><span class="desc">关闭当前会话</span></div>
    <div class="krow"><kbd>r</kbd><span class="desc">重命名当前会话（别名）</span></div>
    <div class="krow"><kbd>v</kbd><span class="desc">总览 / 详情 切换</span></div>
    <div class="krow"><kbd>⌘/Ctrl</kbd>+<kbd>k</kbd><span class="desc">命令面板</span></div>
    <div class="krow"><kbd>?</kbd><span class="desc">显示/隐藏本帮助</span></div>
    <div class="krow"><kbd>Esc</kbd><span class="desc">关闭浮层 / 面板</span></div>
  </div>
</div>

<script>
(function() {
  'use strict';

  // ---------- API + helpers ----------
  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  function withTok(path) {
    if (!TOKEN) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  }
  function api(path, init) {
    return fetch(withTok(path), init).then(async function(r) {
      var text = await r.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
      if (!r.ok) {
        var msg = (data && data.error) || text || ('http ' + r.status);
        throw new Error(msg);
      }
      return data;
    });
  }
  function isMobileViewport() {
    return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  }
  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  // ---------- toast ----------
  // 非阻塞反馈，替代原生 alert。相同 (msg,kind) 在 600ms 内合并计数，防抖动刷屏。
  var _toastSeen = {}; // key -> { node, countEl, n, timer }
  var TOAST_ICON = { ok: '✓', warn: '!', bad: '✕' };
  function toast(msg, kind) {
    kind = kind || 'ok';
    var host = document.getElementById('toast-host');
    if (!host) return;
    var key = kind + '|' + msg;
    var prev = _toastSeen[key];
    if (prev) {
      prev.n++;
      prev.countEl.textContent = '×' + prev.n;
      prev.countEl.style.display = '';
      clearTimeout(prev.timer);
      prev.timer = setTimeout(function() { _dismissToast(key); }, 3000);
      return;
    }
    var node = document.createElement('div');
    node.className = 'toast ' + kind;
    node.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    node.innerHTML = '<span class="ic">' + (TOAST_ICON[kind] || '') + '</span><span class="msg"></span><span class="n" style="display:none"></span>';
    node.querySelector('.msg').textContent = msg;
    host.appendChild(node);
    var rec = { node: node, countEl: node.querySelector('.n'), n: 1, timer: null };
    rec.timer = setTimeout(function() { _dismissToast(key); }, 3000);
    _toastSeen[key] = rec;
  }
  function _dismissToast(key) {
    var rec = _toastSeen[key];
    if (!rec) return;
    delete _toastSeen[key];
    rec.node.classList.add('leaving');
    setTimeout(function() { if (rec.node.parentNode) rec.node.parentNode.removeChild(rec.node); }, 200);
  }

  // ---------- confirm dialog ----------
  // 受控确认弹窗，替代原生 confirm。返回 Promise<bool>；Esc/取消=false，确定=true。
  // 焦点陷阱由 <dialog> 原生提供；关闭后焦点回到触发元素。
  function confirmDialog(opts) {
    opts = opts || {};
    var dlg = document.getElementById('confirm-dlg');
    if (!dlg || !dlg.showModal) return Promise.resolve(window.confirm((opts.title || '') + '\\n' + (opts.body || '')));
    var trigger = document.activeElement;
    document.getElementById('confirm-title').textContent = opts.title || '确认';
    document.getElementById('confirm-text').textContent = opts.body || '';
    var okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = opts.okLabel || '确定';
    okBtn.className = opts.danger ? 'danger' : 'primary';
    return new Promise(function(resolve) {
      var done = function(val) {
        okBtn.removeEventListener('click', onOk);
        document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onCancel);
        dlg.removeEventListener('close', onClose);
        try { dlg.close(); } catch (e) {}
        if (trigger && trigger.focus) { try { trigger.focus(); } catch (e) {} }
        resolve(val);
      };
      var onOk = function() { done(true); };
      var onCancel = function(e) { if (e) e.preventDefault(); done(false); };
      var onClose = function() { done(false); };
      okBtn.addEventListener('click', onOk);
      document.getElementById('confirm-cancel').addEventListener('click', onCancel);
      dlg.addEventListener('cancel', onCancel); // Esc
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      okBtn.focus();
    });
  }
  function fmtAge(iso) {
    if (!iso) return '—';
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    return Math.round(ms / 60000) + 'm';
  }
  function fmtTokensK(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1000) return String(n);
    if (n < 1000000) return Math.round(n / 1000) + 'k';
    var m = n / 1000000;
    // 39.5M for <10M, otherwise drop the decimal so "39M" not "39.5M".
    return (m < 10 ? m.toFixed(1) : Math.round(m)) + 'M';
  }
  function fmtMinutes(m) {
    if (m == null || !isFinite(m)) return '—';
    if (m < 60) return Math.round(m) + 'm';
    var h = Math.floor(m / 60);
    var rest = Math.round(m - h * 60);
    return h + 'h ' + (rest ? rest + 'm' : '');
  }

  // ---------- status visual map (shared between tab strip + rail + focus) ----
  var STATUS_VIEW = {
    waiting_ask:   { dot: '#f85149', text: '等待回答', icon: '?',  color: '#f85149' },
    waiting_tool:  { dot: '#d29922', text: '工具等待', icon: '⏸', color: '#d29922' },
    waiting_input: { dot: '#a371f7', text: '等输入',   icon: '⌨', color: '#a371f7' },
    thinking:      { dot: '#58a6ff', text: '思考中',   icon: '·',  color: '#58a6ff' },
    tool_running:  { dot: '#d29922', text: '执行中',   icon: '▶', color: '#d29922' },
    idle:          { dot: '#7d8590', text: '空闲',     icon: '○', color: '#7d8590' },
    no_session:    { dot: '#7d8590', text: '无会话',   icon: '·', color: '#7d8590' },
    error:         { dot: '#f85149', text: '错误',     icon: '⚠', color: '#f85149' },
  };
  function statusView(s) { return STATUS_VIEW[s] || STATUS_VIEW.idle; }

  // ---------- keyed DOM reconcile ----------
  // 按 data-key 复用现有子节点，只在签名变化时改 class/innerHTML/属性，
  // 不命中则新建、多余则删除、按序复位。配合事件委托（监听器挂在容器上、
  // 永不解绑），消除"每次轮询整块 innerHTML 重建 + 重新 addEventListener"
  // 带来的闪烁与滚动跳动。opts: {tag?, keyOf, classOf, innerOf, attrsOf?, sigOf?}
  function _setAttrs(node, attrs) {
    if (!attrs) return;
    for (var k in attrs) { if (attrs[k] == null) node.removeAttribute(k); else node.setAttribute(k, attrs[k]); }
  }
  function reconcileRows(container, items, opts) {
    // 只管理元素子节点：先清掉初始 "loading…" 之类的文本/注释节点
    [].slice.call(container.childNodes).forEach(function(n) { if (n.nodeType !== 1) container.removeChild(n); });
    var byKey = {};
    [].slice.call(container.children).forEach(function(node) {
      var k = node.getAttribute('data-key');
      if (k != null) byKey[k] = node; else container.removeChild(node);
    });
    var used = {};
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = String(opts.keyOf(item));
      used[key] = true;
      var sig = opts.sigOf ? String(opts.sigOf(item)) : null;
      var node = byKey[key];
      if (!node) {
        node = document.createElement(opts.tag || 'div');
        node.setAttribute('data-key', key);
        byKey[key] = node;
        node.className = opts.classOf(item);
        node.innerHTML = opts.innerOf(item);
        _setAttrs(node, opts.attrsOf ? opts.attrsOf(item) : null);
        if (sig != null) node.setAttribute('data-sig', sig);
      } else if (sig == null || node.getAttribute('data-sig') !== sig) {
        node.className = opts.classOf(item);
        node.innerHTML = opts.innerOf(item);
        _setAttrs(node, opts.attrsOf ? opts.attrsOf(item) : null);
        if (sig != null) node.setAttribute('data-sig', sig);
      }
      var ref = container.children[i];
      if (ref !== node) container.insertBefore(node, ref || null);
    }
    [].slice.call(container.children).forEach(function(node) {
      var k = node.getAttribute('data-key');
      if (k == null || !used[k]) container.removeChild(node);
    });
  }

  // ---------- module state ----------
  var _state = {
    activePid: null,
    termTab: 'console',
    termOpen: true,
    termHeight: 280,
    answered: {},           // pid -> { askId, label }
    instances: [],          // /api/launcher/list payload
    activityByPid: {},      // pid -> activity entry
    gitByPid: {},           // pid -> { fetchedAt, data }
    editsByPid: {},         // pid -> { fetchedAt, files, bash }
    serverHost: location.hostname,
    serverPort: location.port,
    filter: '',
    caps: { shell: true }, // optimistic default; replaced on first probe
    history: [],            // idle workspaces (cwd seen before, no ccv now)
    shellHistory: [],       // cwds with bare-CLI jsonls but never opened in ccv
    localCcSessions: [],    // bare claude processes not under ccv
    prefs: null,            // { availableProfiles: [], defaultCcuseProfile, ... }
    railOpen: { hist: false, untracked: false, shellHist: false },
    histOpen: {},           // cwd -> true when that history card is expanded
    sessionsByCwd: {},      // cwd -> { fetchedAt, items } or { loading: true }
    openCcvs: [],           // pids of ccv iframes currently mounted in overlay
    activeOverlayPid: null, // which pid is visible in #ccv-overlay
    lastStatusByPid: {},    // pid -> last seen status (transition detection baseline)
    notifPrefs: { enabled: false, soundEnabled: true },
    notifRecentTags: {},    // tag -> ts (cross-tab dedup window)
    notifThrottle: {},      // 'pid-status' -> last notify ts (5-min throttle)
    notifSkipNextDetect: false,
    audioCtx: null,
    push: { supported: false, subscribed: false, endpoint: null, status: 'idle', error: '' },
    sortMode: 'activity',   // activity | name | cost | status
    groupByProject: false,
    viewMode: 'overview',   // overview (看板总览) | focus (单会话详情)
    _overviewSig: null,
  };
  try {
    var p = JSON.parse(localStorage.getItem('ccvMcState') || '{}');
    if (p && typeof p === 'object') {
      if (p.activePid) _state.activePid = +p.activePid || null;
      if (p.termTab) _state.termTab = p.termTab;
      if (typeof p.termOpen === 'boolean') _state.termOpen = p.termOpen;
      if (p.termHeight && p.termHeight >= 80 && p.termHeight <= 2000) _state.termHeight = p.termHeight;
      if (p.railOpen && typeof p.railOpen === 'object') {
        _state.railOpen.hist = !!p.railOpen.hist;
        _state.railOpen.untracked = !!p.railOpen.untracked;
        _state.railOpen.shellHist = !!p.railOpen.shellHist;
      }
      if (p.sortMode && /^(activity|name|cost|status)$/.test(p.sortMode)) _state.sortMode = p.sortMode;
      if (typeof p.groupByProject === 'boolean') _state.groupByProject = p.groupByProject;
      if (p.viewMode && /^(overview|focus)$/.test(p.viewMode)) _state.viewMode = p.viewMode;
    }
  } catch (e) {}
  function persistState() {
    try {
      localStorage.setItem('ccvMcState', JSON.stringify({
        activePid: _state.activePid,
        termTab: _state.termTab,
        termOpen: _state.termOpen,
        termHeight: _state.termHeight,
        railOpen: _state.railOpen,
        sortMode: _state.sortMode,
        groupByProject: _state.groupByProject,
        viewMode: _state.viewMode,
      }));
    } catch (e) {}
  }

  // ---------- ask normalization ----------
  function extractAsks(activity) {
    // ccv pendingAsks shape: [{ id, questions: [{ header, question, options|choices: [{label,description?}], multiSelect? }], createdAt }]
    // The store field is "options"; "choices" kept for forward compat.
    var list = [];
    if (!activity) return list;
    var asks = activity.pendingAsks || [];
    for (var i = 0; i < asks.length; i++) {
      var a = asks[i];
      var q = (a.questions && a.questions[0]) || {};
      var raw = Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []);
      var choices = raw.map(function(c) {
        if (typeof c === 'string') return { label: c, description: '' };
        if (c && typeof c === 'object') return { label: c.label || c.text || JSON.stringify(c), description: c.description || '' };
        return { label: String(c), description: '' };
      });
      list.push({
        id: a.id,
        question: q.question || q.header || 'AskUserQuestion',
        rawQuestion: q.question || '',
        header: q.header || '',
        context: a.context || a.summary || '',
        choices: choices,
        multiSelect: !!q.multiSelect,
        questionCount: Array.isArray(a.questions) ? a.questions.length : 0,
        createdAt: a.createdAt || null,
      });
    }
    return list;
  }

  function activePidOnFirstLoad() {
    var inst = _state.instances;
    var act = _state.activityByPid;
    // 1) waiting_ask
    for (var i = 0; i < inst.length; i++) {
      var a = act[inst[i].pid];
      if (a && a.status === 'waiting_ask') return inst[i].pid;
    }
    // 2) most recent lastEventAt
    var best = null, bestTs = 0;
    for (var j = 0; j < inst.length; j++) {
      var a2 = act[inst[j].pid];
      if (!a2 || !a2.lastEventAt) continue;
      var t = new Date(a2.lastEventAt).getTime();
      if (t > bestTs) { bestTs = t; best = inst[j].pid; }
    }
    if (best) return best;
    // 3) first non-hub
    for (var k = 0; k < inst.length; k++) {
      if (!inst[k].isHub) return inst[k].pid;
    }
    return inst[0] ? inst[0].pid : null;
  }

  // ---------- render: app bar stats ----------
  function paintCost(today) {
    var el = document.getElementById('cost-today');
    if (!el) return;
    if (today == null) { el.textContent = '—'; return; }
    el.textContent = '$' + (today >= 100 ? today.toFixed(0) : today.toFixed(2));
  }
  function paintQuota(q) {
    var v = document.getElementById('quota-val');
    var f = document.getElementById('quota-fill');
    var w = document.getElementById('quota-warn');
    if (!v || !f) return;
    if (w) w.hidden = true;
    if (!q || q.percent == null) { v.textContent = '—'; f.style.width = '0%'; return; }
    var raw = +q.percent || 0;
    var saturated = raw >= 100;
    var pct = Math.max(0, Math.min(100, raw));
    var txt;
    if (saturated && q.used != null && q.limit != null) {
      // Pegged at 100% — the % is no signal anymore; show just used/limit so
      // the magnitude is what stands out.
      txt = fmtTokensK(q.used) + ' / ' + fmtTokensK(q.limit);
    } else if (q.used != null && q.limit != null) {
      txt = pct.toFixed(0) + '%  ' + fmtTokensK(q.used) + '/' + fmtTokensK(q.limit);
    } else {
      txt = pct.toFixed(0) + '%';
    }
    v.textContent = txt;
    f.style.width = pct.toFixed(1) + '%';
    f.className = 'fill' + (pct >= 80 ? ' bad' : pct >= 50 ? ' warn' : '');
    if (w) {
      if (q.source === 'jsonl_compute') {
        w.hidden = false;
        w.textContent = '⚠';
        w.title = '推算（基于本地 jsonl，input + output + cache_creation，不含 cache_read；可能与服务端实际计数有偏差）';
      } else if (q.source === 'cc_usage_cache' && q.sourceStale) {
        w.hidden = false;
        w.textContent = '⏱';
        var ageMin = Math.round((q.sourceAgeMs || 0) / 60000);
        w.title = '数据来自 Claude Code 本地缓存（' + ageMin + ' 分钟前刷新），可能滞后于实时';
      }
    }
    var quotaEl = document.getElementById('stat-quota');
    var tip = ['source: ' + (q.source || '—')];
    if (q.plan_name) tip.push('plan: ' + q.plan_name);
    if (q.burn_rate) tip.push('burn: ' + Math.round(q.burn_rate) + ' tok/min');
    if (q.reset_at) {
      var remain = (new Date(q.reset_at).getTime() - Date.now()) / 60000;
      if (remain > 0) tip.push('reset in: ' + fmtMinutes(remain));
    }
    if (saturated) tip.push('actual: ' + raw.toFixed(0) + '% (capped at 100% for the bar)');
    if (quotaEl) quotaEl.title = tip.join('\\n');
  }

  // ---------- render: tab strip ----------
  // 点击通过 #tab-strip 上的委托监听（见 wireDelegation）分发，这里只做键控渲染。
  function tabName(it) { return it.alias || it.displayName || it.projectName || (it.cwd ? it.cwd.split('/').pop() : '?'); }
  function renderTabStrip() {
    var strip = document.getElementById('tab-strip');
    if (!strip) return;
    var inst = filteredInstancesWithActivePinned();
    if (!inst.length) {
      strip.innerHTML = '<div class="empty" style="padding:8px 12px;font-size:11px">还没有实例 · 按 <kbd>c</kbd> 或点 + New 启动</div>';
      return;
    }
    reconcileRows(strip, inst, {
      keyOf: function(it) { return it.pid; },
      attrsOf: function(it) { return { 'data-pid': it.pid }; },
      classOf: function(it) {
        var act = _state.activityByPid[it.pid] || {};
        var active = it.pid === _state.activePid;
        var needsAsk = extractAsks(act).length > 0 && !_state.answered[it.pid];
        var pinned = active && _state._activeFilteredOut;
        var wi = act.status === 'waiting_input';
        return 'tab' + (active ? ' active' : '') + (needsAsk ? ' needs-ask' : '') + (wi ? ' waiting-input' : '') + (pinned ? ' filtered-pinned' : '');
      },
      sigOf: function(it) {
        var act = _state.activityByPid[it.pid] || {};
        var view = statusView(act.status || 'idle');
        var active = it.pid === _state.activePid;
        var needsAsk = extractAsks(act).length > 0 && !_state.answered[it.pid];
        var pinned = active && _state._activeFilteredOut;
        return [act.status || 'idle', view.dot, active ? 1 : 0, needsAsk ? 1 : 0, tabName(it), it.port || '', it.isHub ? 1 : 0, pinned ? 1 : 0].join('|');
      },
      innerOf: function(it) {
        var act = _state.activityByPid[it.pid] || {};
        var view = statusView(act.status || 'idle');
        var needsAsk = extractAsks(act).length > 0 && !_state.answered[it.pid];
        var h = '<span class="dot" style="background:' + view.dot + '"></span>';
        if (it.isHub) h += '<span class="hub-tag">HUB</span>';
        h += '<span class="name">' + escape(tabName(it)) + '</span>';
        if (it.port) h += '<span class="port">:' + it.port + '</span>';
        if (needsAsk) h += '<span class="ask-badge">!</span>';
        return h;
      },
    });
  }

  // app-bar 等回答计数徽标 + 标题前缀，让后台标签页也能一眼看出有几个在等。
  function paintAskCount(n) {
    var btn = document.getElementById('ask-count');
    if (btn) {
      if (n > 0) { btn.hidden = false; btn.textContent = '⏳ ' + n; }
      else { btn.hidden = true; btn.textContent = ''; }
    }
    document.title = n > 0 ? '(' + n + ') ccv launcher' : 'ccv launcher';
  }
  // 跳到下一个等回答的会话（badge 点击 + J 键共用）。
  function jumpNextAsk() {
    var asks = _state.instances.filter(function(x) {
      var a = _state.activityByPid[x.pid];
      return a && a.status === 'waiting_ask' && !_state.answered[x.pid];
    });
    if (!asks.length) return;
    var idx = asks.findIndex(function(x) { return x.pid === _state.activePid; });
    setActive(asks[(idx + 1) % asks.length].pid);
  }

  // ---------- render: ask alert ----------
  function renderAskAlert() {
    var el = document.getElementById('ask-alert');
    if (!el) return;
    var asks = [];
    for (var i = 0; i < _state.instances.length; i++) {
      var it = _state.instances[i];
      if (_state.answered[it.pid]) continue;
      var act = _state.activityByPid[it.pid];
      if (!act || act.status !== 'waiting_ask') continue;
      var list = extractAsks(act);
      if (!list.length) continue;
      asks.push({ inst: it, ask: list[0], all: list });
    }
    paintAskCount(asks.length);
    if (!asks.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    var html = '<span class="alert-tag">' + asks.length + ' 等回答</span>';
    html += '<div class="alert-chips">';
    for (var j = 0; j < asks.length; j++) {
      var a = asks[j];
      var active = a.inst.pid === _state.activePid;
      var nm = a.inst.alias || a.inst.displayName || a.inst.projectName || '?';
      html += '<button class="alert-chip' + (active ? ' active' : '') + '" data-pid="' + a.inst.pid + '">';
      html += '<span class="dot"></span>';
      html += '<b>' + escape(nm) + '</b>';
      html += '<span class="q">' + escape(a.ask.question) + '</span>';
      html += '</button>';
    }
    html += '</div>';
    html += '<span class="kbd-hint"><kbd>J</kbd> 跳到下一个</span>';
    el.innerHTML = html;
    [].forEach.call(el.querySelectorAll('.alert-chip'), function(btn) {
      btn.addEventListener('click', function() { setActive(+btn.getAttribute('data-pid')); });
    });
  }

  // ---------- render: rail ----------
  // rail 拆成两块：#rail-sessions（live 会话卡，3s 轮询键控更新）与
  // #rail-extras（历史/shell 历史/未托管，仅 refreshList/折叠/别名变更时刷新）。
  // 解耦后高频轮询不再重建静态区块，滚动位置不丢。点击统一走 #rail 委托。
  function ensureRailContainers() {
    var el = document.getElementById('rail');
    if (!el) return null;
    var s = document.getElementById('rail-sessions');
    var x = document.getElementById('rail-extras');
    if (!s || !x) {
      el.innerHTML = '<div id="rail-sessions"></div><div id="rail-extras"></div>';
      s = document.getElementById('rail-sessions');
      x = document.getElementById('rail-extras');
    }
    return { sessions: s, extras: x };
  }

  function renderRail() { renderRailSessions(); renderRailExtras(); }

  function railSub(it, act) {
    return act.title || (act.preview ? act.preview.replace(/^user:\s*/, '') : '') || (it.cwd || '').split('/').slice(-2).join('/');
  }
  // 会话区头部（标签 + 排序下拉 + 分组开关）只建一次并就地复用，避免高频轮询
  // 重建控件、丢焦点。控件自身 stopPropagation，不触发 #rail 委托。
  function buildRailSessionsHost(host) {
    host.innerHTML =
      '<div class="rail-hd">' +
        '<span class="rail-hd-label"></span>' +
        '<span style="flex:1"></span>' +
        '<select id="rail-sort" class="rail-ctl" title="排序">' +
          '<option value="activity">活动</option><option value="name">名称</option>' +
          '<option value="cost">成本</option><option value="status">状态</option>' +
        '</select>' +
        '<button id="rail-group" class="rail-ctl" type="button" title="按项目分组">⊞</button>' +
      '</div>' +
      '<div id="rail-cards"></div>';
    var sel = host.querySelector('#rail-sort');
    sel.value = _state.sortMode;
    sel.addEventListener('click', function(e) { e.stopPropagation(); });
    sel.addEventListener('change', function() { _state.sortMode = sel.value; persistState(); renderRailSessions(); });
    var gb = host.querySelector('#rail-group');
    gb.classList.toggle('on', _state.groupByProject);
    gb.addEventListener('click', function(e) {
      e.stopPropagation();
      _state.groupByProject = !_state.groupByProject;
      gb.classList.toggle('on', _state.groupByProject);
      persistState(); renderRailSessions();
    });
  }
  function renderRailSessions() {
    var c = ensureRailContainers();
    if (!c) return;
    var host = c.sessions;
    var cards = host.querySelector('#rail-cards');
    if (!cards) { buildRailSessionsHost(host); cards = host.querySelector('#rail-cards'); }
    var hd = host.querySelector('.rail-hd');
    var label = host.querySelector('.rail-hd-label');
    var inst = filteredInstancesWithActivePinned();
    if (!inst.length) {
      hd.style.display = 'none';
      cards.innerHTML = '<div class="empty" style="padding:10px 4px;font-size:11px">还没有会话 · 按 <kbd>c</kbd> 新建</div>';
      return;
    }
    hd.style.display = '';
    label.textContent = '会话 · ' + inst.length;
    var ph = cards.querySelector('.empty'); if (ph) ph.remove();
    // 分组时把项目头作为 keyed 行（key=g:<name>）交错插入会话卡之间。
    var items = inst;
    if (_state.groupByProject) {
      var byKey = {}, order = [];
      inst.forEach(function(it) { var k = groupKeyOf(it); if (!byKey[k]) { byKey[k] = []; order.push(k); } byKey[k].push(it); });
      items = [];
      order.forEach(function(k) { items.push({ __group: k, count: byKey[k].length }); byKey[k].forEach(function(it) { items.push(it); }); });
    }
    reconcileRows(cards, items, {
      keyOf: function(it) { return it.__group ? ('g:' + it.__group) : it.pid; },
      attrsOf: function(it) {
        if (it.__group) return { 'data-pid': null, 'style': null };
        var view = statusView((_state.activityByPid[it.pid] || {}).status || 'idle');
        return { 'data-pid': it.pid, 'style': 'border-left-color:' + view.dot };
      },
      classOf: function(it) {
        if (it.__group) return 'rail-group-hd';
        var act = _state.activityByPid[it.pid] || {};
        var active = it.pid === _state.activePid;
        var needsAsk = act.status === 'waiting_ask' && !_state.answered[it.pid];
        var pinned = active && _state._activeFilteredOut;
        var wi = act.status === 'waiting_input';
        return 'rail-card' + (active ? ' active' : '') + (needsAsk ? ' needs-ask' : '') + (wi ? ' waiting-input' : '') + (pinned ? ' filtered-pinned' : '');
      },
      sigOf: function(it) {
        if (it.__group) return 'g|' + it.__group + '|' + it.count;
        var act = _state.activityByPid[it.pid] || {};
        var view = statusView(act.status || 'idle');
        var active = it.pid === _state.activePid;
        var needsAsk = act.status === 'waiting_ask' && !_state.answered[it.pid];
        var pinned = active && _state._activeFilteredOut;
        return [act.status || 'idle', view.dot, active ? 1 : 0, needsAsk ? 1 : 0, tabName(it), railSub(it, act), fmtAge(act.lastEventAt), pinned ? 1 : 0].join('|');
      },
      innerOf: function(it) {
        if (it.__group) return '<span>' + escape(it.__group) + '</span><span class="gc">' + it.count + '</span>';
        var act = _state.activityByPid[it.pid] || {};
        var needsAsk = act.status === 'waiting_ask' && !_state.answered[it.pid];
        var h = '<div class="top"><span class="name">' + escape(tabName(it)) + '</span>';
        if (needsAsk) h += '<span class="ask-pill">!</span>';
        h += '<span class="age">' + escape(fmtAge(act.lastEventAt)) + '</span></div>';
        h += '<div class="sub">' + escape(railSub(it, act) || '—') + '</div>';
        return h;
      },
    });
  }

  function renderRailExtras() {
    var c = ensureRailContainers();
    if (!c) return;
    var el = c.extras;
    var html = '';

    // ---- 历史项目 (idle workspaces) ----
    var hist = filteredHistory();
    if (hist.length) {
      var openH = _state.railOpen.hist;
      html += '<div class="rail-section' + (openH ? ' open' : '') + '" data-sec="hist">';
      html += '<div class="sec-hd"><span class="caret">▸</span><span>历史项目</span><span class="count">' + hist.length + '</span></div>';
      html += '<div class="sec-body">';
      var histMax = openH ? hist.length : 0;
      for (var j = 0; j < histMax; j++) {
        var h = hist[j];
        var hname = h.alias || h.projectName || (h.cwd || '').split('/').pop() || '?';
        var hsub = (h.cwd || '').replace(/^\\/Users\\/[^/]+/, '~');
        var sCount = +h.sessionCount || 0;
        var expanded = !!_state.histOpen[h.cwd];
        html += '<div class="rail-hist-card' + (expanded ? ' open' : '') + '" data-cwd="' + escape(h.cwd) + '" title="' + escape(h.cwd) + '">';
        html += '<div class="row1">';
        if (sCount > 0) html += '<span class="caret">▸</span>';
        html += '<span class="name">' + escape(hname) + '</span>';
        if (sCount > 0) html += '<span class="sess-count" title="历史会话数">' + sCount + '</span>';
        html += '<span class="age">' + escape(fmtAge(h.lastUsed)) + '</span>';
        if (sCount > 0) html += '<button class="spawn-fresh" data-cwd="' + escape(h.cwd) + '" title="此目录新启一个 session">+</button>';
        html += '</div>';
        html += '<div class="meta"><span>' + escape(hsub) + '</span></div>';
        html += '</div>';
        if (expanded) {
          html += renderSessionsBlock(h.cwd);
        }
      }
      html += '</div></div>';
    }

    // ---- shell 历史 (有 jsonl 但没经过 ccv 的 cwd) ----
    // Same card shape as 历史项目 so the existing .rail-hist-card click
    // handler (expand sessions / +-fresh) just works.
    var shellHist = filteredShellHistory();
    if (shellHist.length) {
      var openSH = _state.railOpen.shellHist;
      html += '<div class="rail-section' + (openSH ? ' open' : '') + '" data-sec="shellHist">';
      html += '<div class="sec-hd"><span class="caret">▸</span><span>shell 历史</span><span class="count">' + shellHist.length + '</span></div>';
      html += '<div class="sec-body">';
      var shMax = openSH ? shellHist.length : 0;
      for (var sh = 0; sh < shMax; sh++) {
        var sHist = shellHist[sh];
        var shName = sHist.projectName || (sHist.cwd || '').split('/').pop() || '?';
        var shSub = (sHist.cwd || '').replace(/^\\/Users\\/[^/]+/, '~');
        var shCount = +sHist.sessionCount || 0;
        var shExpanded = !!_state.histOpen[sHist.cwd];
        html += '<div class="rail-hist-card' + (shExpanded ? ' open' : '') + '" data-cwd="' + escape(sHist.cwd) + '" title="' + escape(sHist.cwd) + '">';
        html += '<div class="row1">';
        if (shCount > 0) html += '<span class="caret">▸</span>';
        html += '<span class="name">' + escape(shName) + '</span>';
        if (shCount > 0) html += '<span class="sess-count" title="历史会话数">' + shCount + '</span>';
        html += '<span class="age">' + escape(fmtAge(sHist.lastUsed)) + '</span>';
        if (shCount > 0) html += '<button class="spawn-fresh" data-cwd="' + escape(sHist.cwd) + '" title="此目录新启一个 session">+</button>';
        html += '</div>';
        html += '<div class="meta"><span>' + escape(shSub) + '</span></div>';
        html += '</div>';
        if (shExpanded) {
          html += renderSessionsBlock(sHist.cwd);
        }
      }
      html += '</div></div>';
    }

    // ---- 未托管 claude (bare CLI) ----
    var loc = _state.localCcSessions || [];
    if (loc.length) {
      var openU = _state.railOpen.untracked;
      html += '<div class="rail-section has-warn' + (openU ? ' open' : '') + '" data-sec="untracked">';
      html += '<div class="sec-hd"><span class="caret">▸</span><span>未托管 claude</span><span class="count">' + loc.length + '</span></div>';
      html += '<div class="sec-body">';
      var locMax = openU ? loc.length : 0;
      for (var k = 0; k < locMax; k++) {
        var u = loc[k];
        var uname = (u.cwd || '').split('/').pop() || ('pid ' + u.pid);
        var ucwd = (u.cwd || '').replace(/^\\/Users\\/[^/]+/, '~');
        var sidShort = u.sessionId ? u.sessionId.slice(0, 8) : '?';
        html += '<div class="rail-untracked-card" data-pid="' + u.pid + '" data-sid="' + escape(u.sessionId || '') + '" data-cwd="' + escape(u.cwd || '') + '" title="点击：kill 裸 claude 并在新 Terminal 用 ccv -r 接管">';
        html += '<div class="name">' + escape(uname) + '</div>';
        html += '<div class="meta"><span>pid ' + u.pid + '</span><span>' + escape(sidShort) + '</span><span style="margin-left:auto">' + escape(ucwd) + '</span></div>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    // extras 没有内容时留空即可（"no sessions" 由 #rail-sessions 负责）。
    el.innerHTML = html;
  }

  // 渲染单个 history 卡片展开后的会话子列表。状态：loading / empty / list。
  function renderSessionsBlock(cwd) {
    var entry = _state.sessionsByCwd[cwd];
    var html = '<div class="rail-sess-list" data-cwd="' + escape(cwd) + '">';
    if (!entry || entry.loading) {
      html += '<div class="rail-sess-loading">载入中…</div>';
    } else if (!entry.items || !entry.items.length) {
      html += '<div class="rail-sess-empty">无历史会话</div>';
    } else {
      for (var i = 0; i < entry.items.length; i++) {
        var s = entry.items[i];
        var preview = (s.firstUser || '').slice(0, 80);
        var sidShort = (s.sessionId || '').slice(0, 8);
        var ageStr = fmtAge(new Date(s.mtimeMs).toISOString());
        html += '<div class="rail-sess-card" data-cwd="' + escape(cwd) + '" data-sid="' + escape(s.sessionId) + '" title="resume session ' + escape(s.sessionId) + '">';
        html += '<div class="preview' + (preview ? '' : ' empty') + '">' + escape(preview || '(无 user 消息)') + '</div>';
        html += '<div class="meta"><span class="sid">' + escape(sidShort) + '</span>';
        if (s.gitBranch) html += '<span>' + escape(s.gitBranch) + '</span>';
        html += '<span class="age">' + escape(ageStr) + '</span></div>';
        html += '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  function toggleHistExpand(cwd) {
    if (_state.histOpen[cwd]) {
      delete _state.histOpen[cwd];
      renderRailExtras();
      return;
    }
    _state.histOpen[cwd] = true;
    var cur = _state.sessionsByCwd[cwd];
    if (!cur || (!cur.loading && (Date.now() - (cur.fetchedAt || 0) > 30000))) {
      fetchSessionsForCwd(cwd);
    }
    renderRailExtras();
  }

  function fetchSessionsForCwd(cwd) {
    _state.sessionsByCwd[cwd] = { loading: true };
    api('/api/launcher/sessions?cwd=' + encodeURIComponent(cwd)).then(function(res) {
      _state.sessionsByCwd[cwd] = {
        items: (res && res.sessions) || [],
        fetchedAt: Date.now(),
      };
      // 只重渲展开中的卡片，避免抖动其他东西
      if (_state.histOpen[cwd]) renderRailExtras();
    }).catch(function(err) {
      _state.sessionsByCwd[cwd] = { items: [], fetchedAt: Date.now(), error: err.message };
      if (_state.histOpen[cwd]) renderRailExtras();
    });
  }

  // 用一个新的受 launcher 管控的 ccv 子进程接管历史会话（claude -r <sid>）。
  function resumeSession(cwd, sessionId) {
    if (!cwd || !sessionId) return;
    api('/api/launcher/spawn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: cwd, resumeSessionId: sessionId }),
    }).then(function(res) {
      if (res && res.instance && res.instance.pid) _state.activePid = res.instance.pid;
      else if (res && res.pid) _state.activePid = res.pid;
      refreshList();
      toast('已恢复会话', 'ok');
    }).catch(function(err) {
      toast('resume 失败: ' + (err && err.message || err), 'bad');
    });
  }

  function filteredHistory() {
    var q = (_state.filter || '').trim().toLowerCase();
    if (!q) return _state.history;
    return _state.history.filter(function(h) {
      return ((h.alias || '') + ' ' + (h.projectName || '') + ' ' + (h.cwd || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  function filteredShellHistory() {
    var q = (_state.filter || '').trim().toLowerCase();
    if (!q) return _state.shellHistory;
    return _state.shellHistory.filter(function(h) {
      return ((h.projectName || '') + ' ' + (h.cwd || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  // ---------- render: focus pane ----------
  // focus 每 3s 轮询若整块重渲，timeline (overflow:auto) 会滚回顶部。用签名脏检查：
  // 只有 active 实例真正变化的字段（覆盖 renderFocus 读取的全部来源）才重渲。
  function focusSig(inst, act) {
    if (!inst) return '__none__';
    var edits = _state.editsByPid[inst.pid], git = _state.gitByPid[inst.pid];
    var ctx = act.contextUsage, su = act.sessionUsage, cs = act.compactStatus;
    return [
      inst.pid, inst.alias || '', inst.ccuseProfile || '', inst.worktree ? (inst.worktree.branch || 1) : '',
      act.status || '', act.lastEventAt || '', act.statusLabel || '',
      act.title || '', act.preview || '',
      extractAsks(act).length, _state.answered[inst.pid] ? (_state.answered[inst.pid].label || 1) : 0,
      ctx ? ctx.percent : '', su ? su.costUSD : '', su ? su.requestCount : '', cs ? cs.recommended : '',
      (act.recentEvents || []).length,
      edits ? edits.fetchedAt : 0, git ? git.fetchedAt : 0,
    ].join('|');
  }
  function renderFocusIfChanged() {
    var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
    var sig = focusSig(inst, inst ? (_state.activityByPid[inst.pid] || {}) : {});
    if (sig === _state._focusSig) return;
    renderFocus();
  }
  function renderFocus() {
    var el = document.getElementById('focus');
    if (!el) return;
    var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
    if (!inst) { el.innerHTML = '<div class="empty">选择左侧一个会话查看详情 · 按 <kbd>c</kbd> 新建</div>'; _state._focusSig = '__none__'; return; }
    var act = _state.activityByPid[inst.pid] || {};
    var view = statusView(act.status || 'idle');
    var asks = extractAsks(act);
    var answered = _state.answered[inst.pid];

    var html = '<div class="focus-inner">';

    // header
    var name = inst.alias || inst.displayName || inst.projectName || (inst.cwd ? inst.cwd.split('/').pop() : '?');
    html += '<div class="focus-hd">';
    html += '<div class="row1">';
    html += '<span class="status-badge" style="background:' + view.color + '20;color:' + view.color + '">' + view.icon + ' ' + escape(view.text) + '</span>';
    html += '<h1>' + escape(name) + '</h1>';
    html += '<span class="meta">pid ' + inst.pid + (inst.port ? ' · :' + inst.port : '') + '</span>';
    html += '<span class="grow"></span>';
    html += '<button class="btn-primary" data-act="open-ccv">Open ccv ↗</button>';
    html += '</div>';
    html += '<div class="cwd">';
    html += '<span class="cwd-path" title="' + escape(inst.cwd || '') + '">' + escape(inst.cwd || '') + '</span>';
    if (inst.cwd) {
      html += '<button class="action-chip cwd-copy" data-act="copy-cwd" title="复制路径">📋</button>';
    }
    html += '</div>';
    if (!inst.isHub) {
      html += '<div class="focus-actions">';
      html += '<button class="action-chip" data-act="alias" title="自定义这个项目的显示名">';
      html +=   '<span class="lbl">别名</span><span class="val">' + escape(inst.alias || '—') + '</span><span style="color:var(--mute)">✎</span>';
      html += '</button>';
      var profiles = (_state.prefs && _state.prefs.availableProfiles) || [];
      if (profiles.length) {
        var curProf = inst.ccuseProfile || (_state.prefs && _state.prefs.defaultCcuseProfile) || '';
        html += '<button class="action-chip" data-act="ccuse" title="切换 ccuse profile (会重启 ccv)">';
        html +=   '<span class="lbl">ccuse</span><span class="val">' + escape(curProf || 'default') + '</span><span class="caret">▾</span>';
        html += '</button>';
      }
      if (inst.cwd) {
        html += '<button class="action-chip" data-act="new-session" title="在同一目录再起一个 ccv (force spawn)">';
        html +=   '<span class="lbl">同目录</span><span class="val">+ 新 session</span>';
        html += '</button>';
      }
      html += '<button class="action-chip danger" data-act="kill" title="SIGTERM 这个 ccv 进程">';
      html +=   '<span class="lbl">此 session</span><span class="val">⏹ 停止</span>';
      html += '</button>';
      html += '<span style="flex:1"></span>';
      html += '</div>';
    }
    if (act.title) {
      html += '<div class="topic" title="' + escape(act.title) + '">';
      html += '<span class="topic-hd">第一条信息</span>' + escape(act.title);
      html += '</div>';
    }
    var lastMsg = (act.preview || '').replace(/^user:\\s*/, '').trim();
    if (lastMsg && lastMsg !== act.title) {
      html += '<div class="topic recent" title="' + escape(lastMsg) + '">';
      html += '<span class="topic-hd">最近一条</span>' + escape(lastMsg);
      html += '</div>';
    }
    html += '</div>';

    // 现在在做
    if (act.statusLabel) {
      html += '<div class="focus-card accent">';
      html += '<div class="card-hd">现在在做的事</div>';
      html += '<div class="card-title">' + escape(act.statusLabel) + '</div>';
      html += '</div>';
    }

    // ask card
    if (asks.length > 0 && !answered) {
      var a = asks[0];
      // multi-select 没法用单按钮回，回退到跳 ccv 的旧行为
      // multi-question (a.questions.length > 1)：launcher inline 只展示 q[0]，
      // 直接答会丢 q[1..N] —— 后端 answers map 残缺导致 ccv 那侧渲染错乱，
      // 同样退回到跳 ccv。
      var multi = !!a.multiSelect;
      var multiQ = (a.questionCount || 0) > 1;
      var inlineAnswerable = !multi && !multiQ;
      html += '<div class="focus-card ask">';
      html += '<div class="card-hd">⏳ ccv 在等你回答</div>';
      html += '<div class="ask-q">' + escape(a.question) + '</div>';
      if (a.context) html += '<div class="ask-ctx">' + escape(a.context) + '</div>';
      html += '<div class="ask-choices">';
      if (a.choices.length && inlineAnswerable) {
        for (var i = 0; i < a.choices.length; i++) {
          var c = a.choices[i];
          html += '<button class="ask-btn' + (i === 0 ? ' primary' : '') + '" data-act="answer-ask" data-ask="' + escape(a.id || '') + '" data-idx="' + i + '" data-label="' + escape(c.label) + '" data-qtext="' + escape(a.rawQuestion || '') + '"' + (c.description ? ' title="' + escape(c.description) + '"' : '') + '>' + escape(c.label) + '</button>';
        }
        html += '<button class="ask-btn" data-act="open-ccv" title="在 ccv 内查看完整上下文 / 选 Other">↗</button>';
      } else if (a.choices.length) {
        // multi-select 或 multi-question：保留跳 ccv 的入口（直接答需要更复杂的 UI）
        for (var j = 0; j < a.choices.length; j++) {
          var cc = a.choices[j];
          html += '<button class="ask-btn' + (j === 0 ? ' primary' : '') + '" data-act="open-ccv"' + (cc.description ? ' title="' + escape(cc.description) + '"' : '') + '>' + escape(cc.label) + ' ↗</button>';
        }
      } else {
        html += '<button class="ask-btn primary" data-act="open-ccv">在 ccv 内回答 ↗</button>';
      }
      html += '</div>';
      if (multi) {
        html += '<div class="ask-ctx" style="margin-top:8px;margin-bottom:0">多选题，跳到 ccv 页面勾选</div>';
      } else if (multiQ) {
        html += '<div class="ask-ctx" style="margin-top:8px;margin-bottom:0">本次问了 ' + (a.questionCount || 0) + ' 个问题，跳到 ccv 页面一起回答</div>';
      }
      html += '</div>';
    } else if (answered) {
      html += '<div class="focus-card ok">';
      html += '<span style="color:var(--ok)">✓</span>';
      html += '<span style="font-size:12px">已回复 <b>' + escape(answered.label) + '</b> · 发送给 ccv :' + (inst.port || '?') + '</span>';
      html += '</div>';
    }

    // stat grid: Context / Cost / Git
    html += '<div class="stat-grid">';
    // Context
    var ctx = act.contextUsage;
    html += '<div class="stat-box">';
    html += '<div class="hd">Context</div>';
    if (ctx) {
      var pct = +ctx.percent || 0;
      var cls = pct >= 80 ? 'bad' : pct >= 60 ? 'warn' : '';
      html += '<div><span class="big">' + pct.toFixed(0) + '%</span> <span class="sub" style="display:inline;margin:0 0 0 6px">' + fmtTokensK(ctx.used) + '/' + fmtTokensK(ctx.limit) + '</span></div>';
      html += '<div class="ctx-bar"><div class="ctx-fill ' + cls + '" style="width:' + Math.min(100, pct).toFixed(1) + '%"></div></div>';
    } else {
      html += '<div class="big">—</div>';
    }
    html += '</div>';
    // Cost
    var su = act.sessionUsage;
    html += '<div class="stat-box">';
    html += '<div class="hd">Cost</div>';
    if (su && su.costUSD != null) {
      html += '<div class="big">$' + (+su.costUSD).toFixed(2) + '</div>';
      var ageMs = inst.startedAt ? Date.now() - new Date(inst.startedAt).getTime() : 0;
      var ageMin = Math.max(0, Math.round(ageMs / 60000));
      html += '<div class="sub">' + (su.requestCount || 0) + ' req · uptime ' + ageMin + 'm</div>';
    } else {
      html += '<div class="big">—</div>';
    }
    html += '</div>';
    // Git — only render box when there's a worktree (empty state wastes space)
    var git = (_state.gitByPid[inst.pid] || {}).data;
    var wt = (git && git.worktree) || inst.worktree;
    if (wt) {
      html += '<div class="stat-box">';
      html += '<div class="hd">Git</div>';
      html += '<div style="font-family:var(--mono);font-size:11px;color:#a5d6ff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🌿 ' + escape(wt.branch || '?') + '</div>';
      if (git && git.stat) {
        html += '<div class="sub"><span style="color:var(--ok)">+' + (git.stat.additions || 0) + '</span> <span style="color:var(--bad);margin:0 6px">−' + (git.stat.deletions || 0) + '</span> <span>' + (git.stat.files || 0) + ' files</span></div>';
      }
      var wtTip = [];
      if (wt.path) wtTip.push('worktree: ' + wt.path);
      if (wt.baseRef) wtTip.push('base: ' + wt.baseRef);
      if (wt.originalCwd) wtTip.push('orig: ' + wt.originalCwd);
      if (wtTip.length) {
        var tipText = wtTip.join('\\n');
        html += '<div class="wt-details" title="' + escape(tipText) + '">';
        if (wt.baseRef) html += '<div><span class="k">base</span><span class="v">' + escape(wt.baseRef) + '</span></div>';
        if (wt.originalCwd) {
          var origShort = wt.originalCwd.replace(/^\\/Users\\/[^/]+/, '~');
          html += '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="k">from</span><span class="v">' + escape(origShort) + '</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    // recent edits
    var edits = _state.editsByPid[inst.pid];
    if (edits && (edits.files.length || edits.bash.length)) {
      var total = (edits.files || []).length + (edits.bash || []).length;
      html += '<div class="focus-card">';
      html += '<div class="card-hd">最近改了 (' + total + ')</div>';
      html += '<div class="edits-list">';
      var rows = (edits.files || []).slice(0, 4);
      for (var r = 0; r < rows.length; r++) {
        var e = rows[r];
        var rel = e.path.length > 60 ? '…' + e.path.slice(-58) : e.path;
        html += '<div class="edit-row"><span class="edit-tool">' + escape(e.tool || 'Edit') + '</span><span class="edit-path">' + escape(rel) + '</span><span class="edit-n">×' + (e.count || 1) + '</span></div>';
      }
      var bashRows = (edits.bash || []).slice(0, Math.max(0, 4 - rows.length));
      for (var rb = 0; rb < bashRows.length; rb++) {
        var be = bashRows[rb];
        html += '<div class="edit-row"><span class="edit-tool">Bash</span><span class="edit-path">' + escape(be.path || be.command || '') + '</span><span class="edit-n">×' + (be.count || 1) + '</span></div>';
      }
      html += '</div></div>';
    }

    // recent activity timeline (from activity payload's recentEvents).
    // Marked .timeline-card so it grows to fill leftover #focus height and
    // scrolls internally — keeps focus pane visually full even when other
    // sections are sparse (e.g. fresh session, no edits, no worktree).
    var events = act.recentEvents || [];
    if (events.length) {
      html += '<div class="focus-card timeline-card">';
      html += '<div class="card-hd">最近活动 (' + events.length + ')</div>';
      html += '<div class="timeline">';
      for (var ev = 0; ev < events.length; ev++) {
        var it = events[ev];
        var ago = fmtAge(it.ts);
        var dur = it.inProgress ? '…' : fmtDur(it.durationMs);
        html += '<div class="tl-row">';
        html += '<span class="tl-time">' + escape(ago) + '</span>';
        html += '<div class="tl-body">';
        if (it.toolUse) {
          html += '<span class="tl-tool" title="' + escape(it.toolUse) + '">' + escape(it.toolUse) + '</span>';
        }
        if (it.assistantText) {
          html += '<div class="tl-text">' + escape(it.assistantText) + '</div>';
        } else if (it.userPrompt) {
          html += '<div class="tl-text tl-user">' + escape(it.userPrompt) + '</div>';
        }
        html += '</div>';
        html += '<span class="tl-dur">' + escape(dur) + '</span>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    html += '</div>';
    el.innerHTML = html;

    // wire buttons
    [].forEach.call(el.querySelectorAll('[data-act="open-ccv"]'), function(btn) {
      btn.addEventListener('click', function() { openCcv(inst); });
    });
    [].forEach.call(el.querySelectorAll('[data-act="answer-ask"]'), function(btn) {
      btn.addEventListener('click', function() {
        var askId = btn.getAttribute('data-ask');
        var idx = +btn.getAttribute('data-idx');
        var label = btn.getAttribute('data-label');
        var qtext = btn.getAttribute('data-qtext') || '';
        answerAsk(inst, askId, idx, label, qtext, btn);
      });
    });
    [].forEach.call(el.querySelectorAll('[data-act="copy-cwd"]'), function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        copyText(inst.cwd, btn, '📋', '✓');
      });
    });
    [].forEach.call(el.querySelectorAll('[data-act="alias"]'), function(btn) {
      btn.addEventListener('click', function() { editAlias(inst); });
    });
    [].forEach.call(el.querySelectorAll('[data-act="ccuse"]'), function(btn) {
      btn.addEventListener('click', function(e) { openCcuseMenu(btn, inst); });
    });
    [].forEach.call(el.querySelectorAll('[data-act="kill"]'), function(btn) {
      btn.addEventListener('click', function() { killCcv(inst); });
    });
    [].forEach.call(el.querySelectorAll('[data-act="new-session"]'), function(btn) {
      btn.addEventListener('click', function() { spawnNewSessionAt(inst, btn); });
    });
    [].forEach.call(el.querySelectorAll('.focus-hd .topic'), function(t) {
      t.addEventListener('click', function() { t.classList.toggle('expanded'); });
    });
    // 更新脏检查基线，使后续 renderFocusIfChanged 能正确跳过未变化的轮询。
    _state._focusSig = focusSig(inst, act);
  }

  // ---------- answer ask ----------
  // 把 launcher 上选中的选项打回 ccv，避免用户每次都得跳到 ccv 标签去点。
  // 走 launcher 后端 /answer-ask（再用短连 WS 发到 ccv 的 ws-hook 桥）。
  // 乐观更新：先把 inst 标记成 answered，让 ✓ 横条立刻出现；失败时撤销并退回到打开 ccv。
  function answerAsk(inst, askId, idx, label, questionText, btn) {
    if (btn) btn.disabled = true;
    _state.answered[inst.pid] = { askId: askId, label: label, at: Date.now() };
    renderAskAlert(); renderTabStrip(); renderFocus();
    api('/api/launcher/instances/' + inst.pid + '/answer-ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ askId: askId, choiceIndex: idx, choiceLabel: label, questionText: questionText || '' }),
    }).catch(function(err) {
      // Don't auto-open ccv on failure: most "failures" here are bookkeeping
      // (WS ack didn't arrive in time) while the answer actually landed at
      // ccv. The 3s activity poll is the source of truth — if the ask is
      // still pending after a beat, we drop the optimistic ✓ and let the
      // user click again. If it cleared, we leave the ✓ alone.
      _state.answered[inst.pid] = Object.assign({}, _state.answered[inst.pid], { error: (err && err.message) || 'send failed' });
      renderAskAlert(); renderTabStrip(); renderFocus();
      setTimeout(function() {
        var act = _state.activityByPid[inst.pid] || {};
        var still = (act.pendingAsks || []).some(function(a) { return a.id === askId; });
        if (still) {
          delete _state.answered[inst.pid];
          renderAskAlert(); renderTabStrip(); renderFocus();
        }
        if (btn) btn.disabled = false;
      }, 3500);
    });
  }

  function instanceSortKey(it) {
    var act = _state.activityByPid[it.pid] || {};
    return Date.parse(act.lastEventAt) || 0;
  }
  // 状态优先级：等回答/等输入靠前，空闲/无会话靠后。
  var STATUS_RANK = { waiting_ask: 0, waiting_input: 1, waiting_tool: 2, tool_running: 3, thinking: 4, error: 5, idle: 6, no_session: 7 };
  function groupKeyOf(it) {
    if (it && it.projectName) return it.projectName;
    var c = (it && it.cwd) || '';
    return c.split('/').filter(Boolean).pop() || '?';
  }
  // 按 _state.sortMode 排序：activity(默认,最近活动) | name | cost | status。
  function sortInstances(list) {
    var mode = _state.sortMode || 'activity';
    return list.slice().sort(function(a, b) {
      var d = 0;
      if (mode === 'name') {
        d = tabName(a).toLowerCase().localeCompare(tabName(b).toLowerCase());
      } else if (mode === 'cost') {
        var ca = ((_state.activityByPid[a.pid] || {}).sessionUsage || {}).costUSD || 0;
        var cb = ((_state.activityByPid[b.pid] || {}).sessionUsage || {}).costUSD || 0;
        d = cb - ca;
      } else if (mode === 'status') {
        var ra = STATUS_RANK[(_state.activityByPid[a.pid] || {}).status] != null ? STATUS_RANK[(_state.activityByPid[a.pid] || {}).status] : 9;
        var rb = STATUS_RANK[(_state.activityByPid[b.pid] || {}).status] != null ? STATUS_RANK[(_state.activityByPid[b.pid] || {}).status] : 9;
        d = ra - rb;
        if (d === 0) d = instanceSortKey(b) - instanceSortKey(a);
      } else { // activity
        d = instanceSortKey(b) - instanceSortKey(a);
      }
      if (d !== 0) return d;
      return (a.pid || 0) - (b.pid || 0);
    });
  }
  function filteredInstances() {
    var q = (_state.filter || '').trim().toLowerCase();
    var base = _state.instances;
    if (q) {
      base = base.filter(function(it) {
        var hay = [it.displayName, it.projectName, it.alias, it.cwd, (it.tags || []).join(' ')].join(' ').toLowerCase();
        return q.split(/\\s+/).every(function(t) { return hay.indexOf(t) >= 0; });
      });
    }
    return sortInstances(base);
  }
  // filter 命中列表 + 钉住当前 active（即便不匹配），避免选中态从 tab/rail 消失。
  // 副作用：设 _state._activeFilteredOut，供渲染层加 .filtered-pinned 弱化样式。
  function filteredInstancesWithActivePinned() {
    var list = filteredInstances();
    _state._activeFilteredOut = false;
    var ap = _state.activePid;
    if (ap && !list.some(function(x) { return x.pid === ap; })) {
      var act = _state.instances.find(function(x) { return x.pid === ap; });
      if (act) { list = list.concat([act]); _state._activeFilteredOut = true; }
    }
    return list;
  }

  function setActive(pid) {
    if (pid === _state.activePid) return;
    _state.activePid = pid;
    persistState();
    renderTabStrip();
    renderRailSessions();
    renderFocusIfChanged();
    renderAskAlert();
    refreshActivePidExtras();
    rewireTerminalForActive();
  }

  function rewireTerminalForActive() {
    // Reset all terminal wires when active instance changes.
    detachConsole();
    detachShell();
    stopLogsPoll();
    if (isMobileViewport()) return; // term panel hidden on mobile
    setTermTab(_state.termTab, true);
  }

  // ---------- overview board ----------
  // 三列状态分组的卡墙：一眼看全所有 session 在干嘛（借鉴 Symphony 看板的
  // 「粗列分组 + 卡内实时活动行」）。数据全复用 _state.activityByPid，零后端改动。
  var BOARD_COLS = [
    { key: 'attention', label: '⏳ 等你',  statuses: ['waiting_ask', 'waiting_input'] },
    { key: 'running',   label: '▶ 运行中', statuses: ['tool_running', 'thinking', 'waiting_tool'] },
    { key: 'idle',      label: '○ 空闲',   statuses: ['idle', 'no_session', 'error'] },
  ];
  function boardColOf(status) {
    for (var i = 0; i < BOARD_COLS.length; i++) {
      if (BOARD_COLS[i].statuses.indexOf(status) >= 0) return BOARD_COLS[i].key;
    }
    return 'idle';
  }
  function ensureBoardCols() {
    var host = document.getElementById('board-cols');
    if (!host) return null;
    if (host.querySelector('.board-col')) return host;
    var h = '';
    for (var i = 0; i < BOARD_COLS.length; i++) {
      var col = BOARD_COLS[i];
      h += '<div class="board-col" data-col="' + col.key + '">'
        +    '<div class="board-col-hd"><span class="lbl">' + col.label + '</span><span class="gc" data-count>0</span></div>'
        +    '<div class="board-col-body" data-body="' + col.key + '"></div>'
        +  '</div>';
    }
    host.innerHTML = h;
    return host;
  }
  function boardCardInner(it) {
    var act = _state.activityByPid[it.pid] || {};
    var view = statusView(act.status || 'idle');
    var topic = act.title || railSub(it, act) || (it.cwd || '');
    var s = '';
    s += '<div class="bc-top">';
    s +=   '<span class="bc-name">' + escape(tabName(it)) + '</span>';
    s +=   '<span class="bc-badge" style="background:' + view.color + '20;color:' + view.color + '">' + view.icon + ' ' + escape(view.text) + '</span>';
    s +=   '<span class="bc-age">' + escape(fmtAge(act.lastEventAt)) + '</span>';
    s += '</div>';
    s += '<div class="bc-topic" title="' + escape(topic) + '">' + escape(topic) + '</div>';
    // 实时活动行：statusLabel 已含动作 + （等待类还含时长）。idle 状态只是
    // "idle Xs"，右上角 age 已表达，省掉这行避免噪音。
    var isIdle = act.status === 'idle' || act.status === 'no_session';
    if (act.statusLabel && !isIdle) {
      s += '<div class="bc-act">' + escape(act.statusLabel) + '</div>';
    }
    var foot = [];
    var ctx = act.contextUsage;
    if (ctx && ctx.percent != null) foot.push('ctx ' + (+ctx.percent).toFixed(0) + '%');
    var su = act.sessionUsage;
    if (su && su.costUSD != null) foot.push('$' + (+su.costUSD).toFixed(2));
    if (foot.length) s += '<div class="bc-foot">' + escape(foot.join(' · ')) + '</div>';
    return s;
  }
  function overviewSig() {
    var list = _state.instances || [];
    var parts = ['f=' + (_state.filter || ''), 'a=' + (_state.activePid || '')];
    for (var i = 0; i < list.length; i++) {
      var it = list[i], act = _state.activityByPid[it.pid] || {};
      var ctx = act.contextUsage || {}, su = act.sessionUsage || {};
      parts.push(it.pid + ':' + (act.status || '') + ':' + (act.statusLabel || '') + ':'
        + (act.title || '') + ':' + (act.lastEventAt || '') + ':' + (ctx.percent || '') + ':'
        + (su.costUSD || '') + ':' + (_state.answered[it.pid] ? 1 : 0) + ':' + tabName(it));
    }
    return parts.join('|');
  }
  function renderOverviewIfChanged() {
    if (_state.viewMode !== 'overview') return;
    if (overviewSig() === _state._overviewSig) return;
    renderOverview();
  }
  function renderOverview() {
    var host = ensureBoardCols();
    if (!host) return;
    var list = filteredInstances();
    var buckets = { attention: [], running: [], idle: [] };
    for (var i = 0; i < list.length; i++) {
      var act = _state.activityByPid[list[i].pid] || {};
      buckets[boardColOf(act.status || 'idle')].push(list[i]);
    }
    for (var c = 0; c < BOARD_COLS.length; c++) {
      var col = BOARD_COLS[c];
      var items = buckets[col.key].slice().sort(function(a, b) { return instanceSortKey(b) - instanceSortKey(a); });
      var cnt = host.querySelector('[data-col="' + col.key + '"] [data-count]');
      if (cnt) cnt.textContent = items.length;
      var body = host.querySelector('[data-body="' + col.key + '"]');
      if (!body) continue;
      if (!items.length) { body.innerHTML = '<div class="board-empty">—</div>'; continue; }
      reconcileRows(body, items, {
        keyOf: function(it) { return it.pid; },
        attrsOf: function(it) {
          var v = statusView((_state.activityByPid[it.pid] || {}).status || 'idle');
          return { 'data-pid': it.pid, 'style': 'border-left-color:' + v.dot };
        },
        classOf: function(it) {
          var act = _state.activityByPid[it.pid] || {};
          var cls = 'board-card';
          if (it.pid === _state.activePid) cls += ' active';
          if (act.status === 'waiting_ask' && !_state.answered[it.pid]) cls += ' needs-ask';
          if (act.status === 'waiting_input') cls += ' waiting-input';
          return cls;
        },
        sigOf: function(it) {
          var act = _state.activityByPid[it.pid] || {};
          var ctx = act.contextUsage || {}, su = act.sessionUsage || {};
          return [act.status || '', act.statusLabel || '', act.title || '', act.lastEventAt || '',
            ctx.percent || '', su.costUSD || '', it.pid === _state.activePid ? 1 : 0,
            _state.answered[it.pid] ? 1 : 0, tabName(it)].join('|');
        },
        innerOf: boardCardInner,
      });
    }
    _state._overviewSig = overviewSig();
  }
  // 切换 mc-grid(详情) / overview(总览) 的可见性 + toggle 按钮高亮（不 persist/render）。
  function applyViewDom() {
    var ov = document.getElementById('overview');
    var grid = document.getElementById('mc-grid');
    var isOv = _state.viewMode === 'overview';
    if (ov) ov.hidden = !isOv;
    if (grid) grid.hidden = isOv;
    var tg = document.getElementById('view-toggle');
    if (tg) [].forEach.call(tg.querySelectorAll('button'), function(b) {
      b.classList.toggle('on', b.getAttribute('data-view') === _state.viewMode);
    });
  }
  function setViewMode(mode) {
    if (mode !== 'overview' && mode !== 'focus') return;
    var changed = _state.viewMode !== mode;
    _state.viewMode = mode;
    if (changed) persistState();
    applyViewDom();
    if (mode === 'overview') { renderOverview(); }
    else { renderFocusIfChanged(); rewireTerminalForActive(); }
  }

  // ---------- per-instance actions ----------
  function copyText(text, btn, before, after) {
    if (!text) return;
    var done = function(ok) {
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = ok ? (after || '✓') : '✗';
      setTimeout(function() { btn.textContent = orig; }, 1000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() { done(true); }, function() { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    }
  }

  // 内联别名编辑：把 focus header 里的「别名」chip 原地换成输入框，
  // Enter 保存 / Esc 取消 / 失焦保存。复用 /prefs/alias 端点。
  function editAlias(inst) {
    var btn = document.querySelector('#focus [data-act="alias"]');
    if (!btn || btn.querySelector('input')) return;
    var current = inst.alias || '';
    btn.innerHTML = '<span class="lbl">别名</span>';
    var input = document.createElement('input');
    input.type = 'text'; input.value = current; input.placeholder = '留空清除';
    input.style.cssText = 'background:var(--bg);color:var(--fg);border:1px solid var(--accent);border-radius:4px;font-size:11px;padding:1px 5px;width:130px;outline:none';
    btn.appendChild(input);
    input.focus(); input.select();
    var done = false;
    var cancel = function() { if (done) return; done = true; renderFocus(); };
    var commit = function() {
      if (done) return; done = true;
      var next = (input.value || '').trim();
      if (next === current) { renderFocus(); return; }
      api('/api/launcher/prefs/alias', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: inst.cwd, alias: next }),
      }).then(function() {
        inst.alias = next;
        toast(next ? '别名已更新' : '别名已清除', 'ok');
        renderTabStrip(); renderRail(); renderFocus();
      }).catch(function(err) {
        toast('设置别名失败: ' + (err && err.message || err), 'bad');
        renderFocus();
      });
    };
    input.addEventListener('click', function(e) { e.stopPropagation(); });
    input.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  function spawnNewSessionAt(inst, btn) {
    if (!inst || !inst.cwd) return;
    confirmDialog({
      title: '同目录新建 session',
      body: '在以下目录再启动一个 ccv 实例（会占用一个新端口）：\\n' + inst.cwd,
      okLabel: '新建',
    }).then(function(ok) {
      if (!ok) return;
      var origLabel = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="lbl">同目录</span><span class="val">Launching…</span>';
      }
      var newPid = null;
      api('/api/launcher/spawn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: inst.cwd, force: true, ccuseProfile: inst.ccuseProfile || '' }),
      }).then(function(res) {
        newPid = (res && res.instance && res.instance.pid) || (res && res.pid) || null;
        return refreshList();
      }).then(function() {
        if (newPid) setActive(newPid);
        toast('已新建 session', 'ok');
      }).catch(function(err) {
        toast('新建 session 失败: ' + (err && err.message || err), 'bad');
      }).finally(function() {
        if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
      });
    });
  }

  function killCcv(inst) {
    var name = inst.alias || inst.displayName || inst.projectName || ('pid ' + inst.pid);
    confirmDialog({
      title: '关闭 ccv 实例',
      body: name + (inst.port ? ' :' + inst.port : '') + '\\n\\nSIGTERM 会发送给进程，正在运行的任务会被打断。',
      danger: true, okLabel: '关闭',
    }).then(function(ok) {
      if (!ok) return;
      api('/api/launcher/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: inst.pid }),
      }).then(function() {
        // Optimistically remove from local state.
        _state.instances = _state.instances.filter(function(x) { return x.pid !== inst.pid; });
        delete _state.activityByPid[inst.pid];
        if (_state.activePid === inst.pid) _state.activePid = activePidOnFirstLoad();
        renderTabStrip(); renderRailSessions(); renderFocus();
        setTimeout(refreshList, 500);
        toast('已关闭 ' + name, 'ok');
      }).catch(function(err) {
        toast('关闭失败: ' + (err && err.message || err), 'bad');
      });
    });
  }

  function _closeCcusePop() {
    var existing = document.getElementById('ccuse-pop');
    if (existing) existing.remove();
  }

  function openCcuseMenu(anchor, inst) {
    _closeCcusePop();
    var prefs = _state.prefs || {};
    var profiles = (prefs.availableProfiles || []).slice();
    var current = inst.ccuseProfile || prefs.defaultCcuseProfile || '';
    var rect = anchor.getBoundingClientRect();
    var pop = document.createElement('div');
    pop.id = 'ccuse-pop'; pop.className = 'ccuse-pop';
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
    var html = '<div class="hdr">切换 ccuse profile</div>';
    html += '<div class="opt" data-prof="" title="使用 zsh 的当前默认 / 不指定 profile">';
    html += '<span class="check">' + (current === '' ? '✓' : '') + '</span><span>default</span></div>';
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      html += '<div class="opt' + (p === current ? ' current' : '') + '" data-prof="' + escape(p) + '">';
      html += '<span class="check">' + (p === current ? '✓' : '') + '</span><span>' + escape(p) + '</span></div>';
    }
    html += '<div class="sep"></div>';
    html += '<div class="opt" data-set-default="1" title="把当前选中设为默认 profile">设为默认…</div>';
    pop.innerHTML = html;
    document.body.appendChild(pop);
    // Clamp into viewport
    var pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
    }
    var off = function(e) {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      _closeCcusePop();
      document.removeEventListener('mousedown', off, true);
    };
    document.addEventListener('mousedown', off, true);
    [].forEach.call(pop.querySelectorAll('[data-prof]'), function(opt) {
      opt.addEventListener('click', function() {
        var prof = opt.getAttribute('data-prof');
        _closeCcusePop();
        if (prof === current) return;
        switchCcuse(inst, prof);
      });
    });
    var defOpt = pop.querySelector('[data-set-default]');
    if (defOpt) {
      defOpt.addEventListener('click', function() {
        _closeCcusePop();
        var next = prompt('设为默认 profile (留空清除):', current || '');
        if (next === null) return;
        api('/api/launcher/prefs/ccuse-profile', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ default: (next || '').trim() }),
        }).then(function() { loadPrefs(true).then(renderFocus); toast('默认 profile 已更新', 'ok'); })
          .catch(function(err) { toast('设置默认 profile 失败: ' + (err && err.message || err), 'bad'); });
      });
    }
  }

  function switchCcuse(inst, profile) {
    confirmDialog({
      title: '切换 ccuse profile',
      body: '切换为 "' + (profile || 'default') + '" 会重启 ccv（SIGTERM → 重新 spawn）。继续？',
      okLabel: '切换并重启',
    }).then(function(ok) {
      if (!ok) return;
      api('/api/launcher/restart', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: inst.pid, ccuseProfile: profile }),
      }).then(function(res) {
        // Switch active to the new pid; full refresh follows.
        if (res && res.instance && res.instance.pid) _state.activePid = res.instance.pid;
        loadPrefs(true);
        refreshList();
        toast('已切换到 ' + (profile || 'default'), 'ok');
      }).catch(function(err) {
        toast('切换 profile 失败: ' + (err && err.message || err), 'bad');
      });
    });
  }

  function takeoverLocal(pid, sessionId, cwd) {
    if (!pid || !sessionId || !cwd) return;
    confirmDialog({
      title: '接管裸 claude 进程',
      body: 'pid: ' + pid + '\\nsession: ' + sessionId + '\\ncwd: ' + cwd +
            '\\n\\n动作：SIGTERM 该 pid → 在新 Terminal 窗口里 ccv -r <sid> 接管该会话。',
      danger: true, okLabel: '接管',
    }).then(function(ok) {
      if (!ok) return;
      api('/api/launcher/takeover-cc-session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: pid, sessionId: sessionId, cwd: cwd }),
      }).then(function() {
        // Refresh after a moment so the new ccv shows up via runtime watcher.
        setTimeout(refreshList, 2000);
        toast('已接管，正在新 Terminal 启动…', 'ok');
      }).catch(function(err) {
        toast('接管失败: ' + (err && err.message || err), 'bad');
      });
    });
  }

  // ---------- terminal: shared xterm builder ----------
  function buildTermConfig() {
    return {
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 3000,
      theme: { background: '#0f1115', foreground: '#e6e8ec', cursor: '#6ea8fe' },
    };
  }
  function attachXterm(host, wsUrl, opts) {
    opts = opts || {};
    while (host.firstChild) host.removeChild(host.firstChild);
    var term = new Terminal(buildTermConfig());
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch (e) {}
    term.writeln('\\x1b[90mConnecting to ' + wsUrl + '...\\x1b[0m');
    var ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch (e) {}
      if (opts.onOpen) opts.onOpen(ws, term);
    };
    ws.onmessage = function(ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === 'data' && msg.data) term.write(msg.data);
        else if (msg.type === 'hello' && msg.sessionId && opts.persistSessionKey) {
          try { sessionStorage.setItem(opts.persistSessionKey, msg.sessionId); } catch (e) {}
          if (msg.isReattach) term.writeln('\\x1b[32m[reattached]\\x1b[0m');
        }
        else if (msg.type === 'exit') term.writeln('\\r\\n\\x1b[33m[process exited: ' + (msg.exitCode == null ? '?' : msg.exitCode) + ']\\x1b[0m');
        else if (msg.type === 'state' && !msg.running) term.writeln('\\x1b[90m[no active process — type to spawn]\\x1b[0m');
      } catch (e) { term.write(ev.data); }
    };
    ws.onerror = function() { term.writeln('\\r\\n\\x1b[31mWebSocket error\\x1b[0m'); };
    ws.onclose = function() { term.writeln('\\r\\n\\x1b[90m[disconnected]\\x1b[0m'); };
    term.onData(function(data) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: data }));
    });
    term.onResize(function(sz) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: sz.cols, rows: sz.rows }));
    });
    var ro = new ResizeObserver(function() { try { fit.fit(); } catch (e) {} });
    ro.observe(host);
    return { term: term, ws: ws, fit: fit, ro: ro };
  }
  function tearDown(handle) {
    if (!handle) return;
    try { handle.ro && handle.ro.disconnect(); } catch (e) {}
    try { handle.ws && handle.ws.close(); } catch (e) {}
    try { handle.term && handle.term.dispose(); } catch (e) {}
  }

  // ---------- Console / Shell / Logs wires ----------
  var _console = null;
  var _shell = null;
  var _logsTimer = null;
  function wsUrlForConsole(inst) {
    var loc = window.location;
    if (inst.publicUrl) {
      try { var u = new URL(inst.publicUrl); return (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host + '/ws/terminal'; } catch (e) {}
    }
    if (inst.lanUrl) {
      try { var u2 = new URL(inst.lanUrl); return 'ws://' + u2.host + '/ws/terminal'; } catch (e) {}
    }
    return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.hostname + ':' + inst.port + '/ws/terminal';
  }
  function wsUrlForShell(cwd) {
    var loc = window.location;
    var proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    var stored = null;
    try { stored = sessionStorage.getItem('ccvShellSessionId'); } catch (e) {}
    var sid = stored ? '&sessionId=' + encodeURIComponent(stored) : '';
    return proto + '//' + loc.host + '/ws/shell?cwd=' + encodeURIComponent(cwd) + sid;
  }
  function attachConsole(inst) {
    detachConsole();
    var host = document.getElementById('host-console');
    if (!host || !inst || !inst.port) return;
    document.getElementById('term-console-sub').textContent = ':' + inst.port;
    _console = attachXterm(host, wsUrlForConsole(inst));
  }
  function detachConsole() { tearDown(_console); _console = null; }
  function attachShell(inst) {
    detachShell();
    var host = document.getElementById('host-shell');
    if (!host || !inst || !inst.cwd) return;
    if (_state.caps && _state.caps.shell === false) {
      host.innerHTML = '<div class="empty" style="padding:14px 16px;line-height:1.55">'
        + '<div style="color:var(--warn);font-weight:600;margin-bottom:6px">shell pty 不可用</div>'
        + '<div style="font-size:11.5px">当前 cc-viewer 构建缺少 <code>pty-session-manager</code>，hub 没启用 <code>/ws/shell</code>。<br>'
        + '可在 ccv 内置终端使用 (Open ccv ↗)，或升级 cc-viewer。</div>'
        + '</div>';
      return;
    }
    _shell = attachXterm(host, wsUrlForShell(inst.cwd), { persistSessionKey: 'ccvShellSessionId' });
  }
  function detachShell() { tearDown(_shell); _shell = null; }
  function stopLogsPoll() {
    if (_logsTimer) { clearInterval(_logsTimer); _logsTimer = null; }
  }
  function startLogsPoll(inst) {
    stopLogsPoll();
    if (!inst || !inst.pid) return;
    if (isMobileViewport()) return; // term panel hidden on mobile
    var pid = inst.pid;
    var host = document.getElementById('host-logs');
    function tick() {
      // Skip the round-trip entirely when the tab is backgrounded or the user
      // navigated away from this instance's Logs tab. The .then guard below only
      // drops the *response* — without this the request still fired every 3s per
      // hidden browser tab.
      if (document.hidden || _state.activePid !== pid || _state.termTab !== 'logs') return;
      api('/api/launcher/instances/' + pid + '/ccv-log?tail=200').then(function(data) {
        if (_state.activePid !== pid || _state.termTab !== 'logs') return;
        if (!host) return;
        var lines = data.lines || [];
        if (!lines.length) {
          if (data.reason === 'no_log_file') {
            host.innerHTML = '<div class="empty" style="padding:14px 16px;line-height:1.55">'
              + '<div style="color:var(--mute);font-weight:600;margin-bottom:6px">此会话无捕获日志</div>'
              + '<div style="font-size:11.5px">该 ccv 实例启动早于日志捕获功能上线，<br>'
              + '从 launcher 内 +New 启动的新会话才会有 ccv.log。</div>'
              + '</div>';
          } else {
            host.innerHTML = '<div class="empty">no log lines yet (等待 ccv 输出…)</div>';
          }
          return;
        }
        var html = '';
        for (var i = 0; i < lines.length; i++) {
          var t = String(lines[i] || '');
          var cls = 'line';
          if (/\\b(err(or)?|fail|fatal)\\b/i.test(t)) cls += ' err';
          else if (/\\bwarn(ing)?\\b/i.test(t)) cls += ' warn';
          html += '<div class="' + cls + '">' + escape(t) + '</div>';
        }
        host.innerHTML = html;
        host.scrollTop = host.scrollHeight;
      }).catch(function() {});
    }
    tick();
    _logsTimer = setInterval(tick, 3000);
  }
  function setTermTab(tab, force) {
    if (tab !== 'console' && tab !== 'shell' && tab !== 'logs') tab = 'console';
    if (!force && tab === _state.termTab && _state.termOpen) return;
    _state.termTab = tab; _state.termOpen = true; persistState();
    var panel = document.getElementById('term-panel');
    if (panel) {
      panel.classList.remove('collapsed');
      // 切 tab 时若之前是 collapsed (inline flex 已清), restore 用户自定高度
      if (_state.termHeight) applyTermSize(_state.termHeight);
    }
    var tabs = document.querySelectorAll('#term-tabs .term-tab');
    [].forEach.call(tabs, function(t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    var panes = document.querySelectorAll('#term-body .term-pane');
    [].forEach.call(panes, function(p) {
      p.classList.toggle('active', p.getAttribute('data-tab') === tab);
    });
    var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
    if (!inst) return;
    if (tab === 'console') { stopLogsPoll(); attachConsole(inst); }
    else if (tab === 'shell') { stopLogsPoll(); attachShell(inst); }
    else if (tab === 'logs') { startLogsPoll(inst); }
  }
  function toggleTerm() {
    var panel = document.getElementById('term-panel');
    if (!panel) return;
    var open = !panel.classList.toggle('collapsed');
    _state.termOpen = open; persistState();
    document.getElementById('term-toggle').textContent = open ? '▾' : '▴';
    if (open) {
      // 展开时 restore 用户拖过的高度; inline flex 之前可能被清掉
      if (_state.termHeight) applyTermSize(_state.termHeight);
      // remount xterm because hidden during collapsed
      setTermTab(_state.termTab, true);
    } else {
      // 折叠时清 inline flex/min-height, 让 .collapsed CSS class 生效
      panel.style.flex = '';
      panel.style.minHeight = '';
    }
  }

  // ---------- ccv iframe overlay (multi-tab) ----------
  function ccvUrl(inst) {
    if (inst.publicUrl) return inst.publicUrl;
    if (inst.lanUrl) return inst.lanUrl;
    return location.protocol + '//' + location.hostname + ':' + inst.port + '/' + (inst.token ? ('?token=' + encodeURIComponent(inst.token)) : '');
  }
  // Multi-tab ccv overlay. Each "Open ccv" call adds (or focuses) a tab in
  // the overlay's top strip; iframes for non-active tabs are kept alive but
  // hidden so switching is instant and state (scroll, input, sse stream)
  // is preserved.
  function openCcv(inst) {
    if (!inst) return;
    var pid = inst.pid;
    if (!_state.openCcvs.includes(pid)) _state.openCcvs.push(pid);
    _state.activeOverlayPid = pid;
    var ov = document.getElementById('ccv-overlay');
    if (ov) ov.classList.add('open');
    ensureCcvFrame(inst);
    renderCcvTabs();
    showActiveCcvFrame();
  }

  function ensureCcvFrame(inst) {
    var host = document.getElementById('ccv-frames');
    if (!host) return;
    var existing = host.querySelector('iframe[data-pid="' + inst.pid + '"]');
    if (existing) return existing;
    var fr = document.createElement('iframe');
    fr.setAttribute('data-pid', String(inst.pid));
    fr.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
    fr.className = 'hidden';
    fr.src = ccvUrl(inst);
    host.appendChild(fr);
    return fr;
  }

  function showActiveCcvFrame() {
    var host = document.getElementById('ccv-frames');
    if (!host) return;
    var pid = _state.activeOverlayPid;
    [].forEach.call(host.querySelectorAll('iframe'), function(fr) {
      var p = +fr.getAttribute('data-pid');
      fr.classList.toggle('hidden', p !== pid);
    });
    var err = document.getElementById('ccv-frame-err');
    if (err) err.classList.remove('show');
  }

  function renderCcvTabs() {
    var el = document.getElementById('ccv-tabs');
    if (!el) return;
    var html = '';
    for (var i = 0; i < _state.openCcvs.length; i++) {
      var pid = _state.openCcvs[i];
      var inst = _state.instances.find(function(x) { return x.pid === pid; });
      var label = inst ? (inst.alias || inst.displayName || inst.projectName || ('pid ' + pid)) : ('pid ' + pid);
      var port = inst && inst.port ? (':' + inst.port) : '';
      var active = pid === _state.activeOverlayPid;
      html += '<div class="ccv-tab' + (active ? ' active' : '') + '" data-pid="' + pid + '" title="' + escape((inst && inst.cwd) || '') + '">';
      html += '<span class="nm">' + escape(label) + '</span>';
      if (port) html += '<span class="port">' + escape(port) + '</span>';
      html += '<button class="x" data-close-pid="' + pid + '" title="关闭此 tab">×</button>';
      html += '</div>';
    }
    el.innerHTML = html;
    [].forEach.call(el.querySelectorAll('.ccv-tab'), function(t) {
      t.addEventListener('click', function(e) {
        if (e.target && e.target.classList && e.target.classList.contains('x')) return;
        var pid = +t.getAttribute('data-pid');
        _state.activeOverlayPid = pid;
        renderCcvTabs();
        showActiveCcvFrame();
      });
    });
    [].forEach.call(el.querySelectorAll('.x'), function(x) {
      x.addEventListener('click', function(e) {
        e.stopPropagation();
        closeCcvTab(+x.getAttribute('data-close-pid'));
      });
    });
  }

  function closeCcvTab(pid) {
    var idx = _state.openCcvs.indexOf(pid);
    if (idx < 0) return;
    _state.openCcvs.splice(idx, 1);
    var host = document.getElementById('ccv-frames');
    var fr = host && host.querySelector('iframe[data-pid="' + pid + '"]');
    if (fr) fr.remove();
    if (_state.activeOverlayPid === pid) {
      _state.activeOverlayPid = _state.openCcvs[Math.min(idx, _state.openCcvs.length - 1)] || null;
    }
    if (!_state.openCcvs.length) {
      closeCcv();
      return;
    }
    renderCcvTabs();
    showActiveCcvFrame();
  }

  function closeCcv() {
    var ov = document.getElementById('ccv-overlay');
    if (ov) ov.classList.remove('open');
    // Keep iframes alive so reopening is instant — only hide the panel.
    // Use closeAllCcvTabs() if a true "destroy everything" path is needed.
  }

  function reloadActiveCcv() {
    var pid = _state.activeOverlayPid;
    var host = document.getElementById('ccv-frames');
    var fr = host && host.querySelector('iframe[data-pid="' + pid + '"]');
    if (fr) fr.src = fr.src;
  }
  function openActiveCcvInNewTab() {
    var pid = _state.activeOverlayPid;
    var inst = _state.instances.find(function(x) { return x.pid === pid; });
    if (inst) window.open(ccvUrl(inst), '_blank', 'noopener,noreferrer');
  }

  // ---------- mobile sheet (fullscreen Console/Shell) ----------
  var _sheet = null;
  function openSheet(kind, inst) {
    closeSheet();
    var s = document.getElementById('term-sheet');
    if (!s || !inst) return;
    document.getElementById('sheet-tag').textContent = kind.toUpperCase();
    document.getElementById('sheet-name').textContent = (inst.alias || inst.displayName || '?') + (inst.port ? ' :' + inst.port : '');
    s.classList.add('open');
    var body = document.getElementById('sheet-body');
    while (body.firstChild) body.removeChild(body.firstChild);
    var host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    body.appendChild(host);
    if (kind === 'console') {
      _sheet = attachXterm(host, wsUrlForConsole(inst));
    } else {
      _sheet = attachXterm(host, wsUrlForShell(inst.cwd), { persistSessionKey: 'ccvShellSessionId' });
    }
  }
  function closeSheet() {
    var s = document.getElementById('term-sheet');
    if (s) s.classList.remove('open');
    tearDown(_sheet); _sheet = null;
  }

  // ---------- +New dialog ----------
  function openNew(presetCwd) {
    // Guard: addEventListener passes the Event as first arg, which would
    // poison presetCwd → "[object PointerEvent]" landing in /spawn. Accept
    // strings only; ignore anything else (including events).
    var cwd = typeof presetCwd === 'string' ? presetCwd : '';
    var dlg = document.getElementById('dlg');
    document.getElementById('new-cwd').value = cwd;
    document.getElementById('new-err').hidden = true;
    document.getElementById('new-err').textContent = '';
    populateCcuseSelect(cwd);
    dlg.showModal();
    // Empty path → backend defaults to homedir. Never send "~" literally
    // (resolvePath doesn't expand it).
    loadDir(cwd || localStorage.getItem('ccvNewLastDir') || '');
  }

  function populateCcuseSelect(cwd) {
    var field = document.getElementById('new-ccuse-field');
    var sel = document.getElementById('new-ccuse');
    if (!field || !sel) return;
    loadPrefs().then(function(prefs) {
      var profiles = (prefs && prefs.availableProfiles) || [];
      if (!profiles.length) { field.hidden = true; return; }
      field.hidden = false;
      var perCwd = (prefs.ccuseProfiles || {})[cwd || ''] || '';
      var dflt = perCwd || prefs.defaultCcuseProfile || '';
      var html = '<option value="">default (zsh 当前)</option>';
      for (var i = 0; i < profiles.length; i++) {
        var p = profiles[i];
        html += '<option value="' + escape(p) + '"' + (p === dflt ? ' selected' : '') + '>' + escape(p) + (p === dflt ? ' (默认)' : '') + '</option>';
      }
      sel.innerHTML = html;
    });
  }
  function loadDir(path) {
    // Defense in depth: even if a caller accidentally passes the click Event
    // (addEventListener forwards it as arg[0]), don't let it land in /new-cwd.
    if (typeof path !== 'string') path = '';
    var qs = path ? ('?path=' + encodeURIComponent(path)) : '';
    api('/api/launcher/browse-dir' + qs).then(function(d) {
      // Backend shape: { current, parent, dirs: [{ name, path, hasGit }] }
      var tree = document.getElementById('new-tree');
      var html = '';
      if (d.parent) html += '<div class="tree-row parent" data-path="' + escape(d.parent) + '"><span class="name">.. (' + escape(d.parent) + ')</span></div>';
      (d.dirs || []).forEach(function(e) {
        var ico = e.hasGit ? '🌿' : '📁';
        html += '<div class="tree-row" data-path="' + escape(e.path) + '"><span class="name">' + ico + ' ' + escape(e.name) + '</span></div>';
      });
      tree.innerHTML = html;
      document.getElementById('new-cwd').value = d.current || path || '';
      document.getElementById('new-err').hidden = true;
      document.getElementById('new-err').textContent = '';
      [].forEach.call(tree.querySelectorAll('.tree-row'), function(row) {
        row.addEventListener('click', function() { loadDir(row.getAttribute('data-path')); });
      });
    }).catch(function(err) {
      document.getElementById('new-err').textContent = err.message;
      document.getElementById('new-err').hidden = false;
    });
  }
  function submitNew() {
    var cwd = document.getElementById('new-cwd').value.trim();
    if (!cwd) { document.getElementById('new-err').textContent = 'cwd required'; document.getElementById('new-err').hidden = false; return; }
    var sel = document.getElementById('new-ccuse');
    var ccuseProfile = sel && !document.getElementById('new-ccuse-field').hidden ? (sel.value || '') : '';
    var btn = document.getElementById('new-launch');
    btn.disabled = true; btn.textContent = 'Launching…';
    api('/api/launcher/spawn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: cwd, force: true, ccuseProfile: ccuseProfile }),
    }).then(function(res) {
      try { localStorage.setItem('ccvNewLastDir', cwd); } catch (e) {}
      document.getElementById('dlg').close();
      if (res && res.instance && res.instance.pid) _state.activePid = res.instance.pid;
      else if (res && res.pid) _state.activePid = res.pid;
      loadPrefs(true);
      refreshList();
    }).catch(function(err) {
      document.getElementById('new-err').textContent = err.message;
      document.getElementById('new-err').hidden = false;
    }).finally(function() {
      btn.disabled = false; btn.textContent = 'Launch';
    });
  }

  // ---------- per-active-instance lazy extras (git + recent edits) ----------
  function refreshActivePidExtras() {
    var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
    if (!inst) return;
    var pid = inst.pid;
    var now = Date.now();
    // recent edits (30s cache)
    var ec = _state.editsByPid[pid];
    if (!ec || now - ec.fetchedAt > 30000) {
      api('/api/launcher/instances/' + pid + '/recent-edits').then(function(d) {
        _state.editsByPid[pid] = { fetchedAt: now, files: d.files || [], bash: d.bash || [] };
        if (_state.activePid === pid) renderFocus();
      }).catch(function() {});
    }
    // git diff: only meaningful for worktree-spawned instances. Without the
    // gate the backend returns 400 every refresh (correctly — non-worktree
    // git mutations are disallowed) and the console fills with noise.
    var gc = _state.gitByPid[pid];
    if (inst.worktree && (!gc || now - gc.fetchedAt > 30000)) {
      api('/api/launcher/instances/' + pid + '/git-diff').then(function(d) {
        _state.gitByPid[pid] = { fetchedAt: now, data: d };
        if (_state.activePid === pid) renderFocus();
      }).catch(function() {
        _state.gitByPid[pid] = { fetchedAt: now, data: null };
      });
    } else if (!inst.worktree && !gc) {
      _state.gitByPid[pid] = { fetchedAt: now, data: null };
    }
  }

  // ---------- polling ----------
  var _listTimer = null, _actTimer = null, _statsTimer = null;
  var _visible = !document.hidden;
  document.addEventListener('visibilitychange', function() {
    _visible = !document.hidden;
    if (_visible) {
      // Skip the first detect after returning visible so accumulated background
      // transitions don't all fire as a burst of notifications.
      _state.notifSkipNextDetect = true;
      refreshList(); refreshActivity(); refreshStats();
    }
  });

  function loadPrefs(force) {
    if (_state.prefs && !force) return Promise.resolve(_state.prefs);
    return api('/api/launcher/prefs').then(function(p) {
      _state.prefs = p || {};
      return _state.prefs;
    }).catch(function() {
      _state.prefs = { availableProfiles: [], defaultCcuseProfile: '', ccuseProfiles: {} };
      return _state.prefs;
    });
  }

  function refreshList() {
    return api('/api/launcher/list').then(function(d) {
      var prev = _state.instances;
      _state.instances = (d.instances || []).slice();
      _state.history = (d.history || []).slice().sort(function(a, b) {
        return (Date.parse(b.lastUsed) || 0) - (Date.parse(a.lastUsed) || 0);
      });
      _state.shellHistory = (d.shellHistory || []).slice();
      _state.localCcSessions = (d.localCcSessions || []).slice();
      // pick active pid if missing
      if (!_state.activePid || !_state.instances.find(function(x) { return x.pid === _state.activePid; })) {
        _state.activePid = activePidOnFirstLoad();
      }
      // server addr line
      var hub = _state.instances.find(function(x) { return x.isHub; });
      if (hub) {
        var host = (hub.lanUrl ? (function() { try { return new URL(hub.lanUrl).hostname; } catch (e) { return location.hostname; } })() : location.hostname);
        document.getElementById('srv').textContent = host + ':' + (hub.port || location.port);
      }
      renderTabStrip(); renderRail(); renderFocusIfChanged(); renderOverviewIfChanged();
      // Refresh activity immediately for any new instances
      if (prev.length !== _state.instances.length) refreshActivity();
    }).catch(function() {});
  }
  function refreshActivity() {
    return api('/api/launcher/activity').then(function(d) {
      var arr = d.activity || [];
      var map = {};
      for (var i = 0; i < arr.length; i++) map[arr[i].pid] = arr[i];
      _state.activityByPid = map;
      // clear optimistic answered if server now reports the ask cleared
      Object.keys(_state.answered).forEach(function(pidStr) {
        var pid = +pidStr;
        var act = map[pid];
        var asks = extractAsks(act);
        if (!asks.length) delete _state.answered[pid];
      });
      // Detect runs before render so notifications fire on the same tick as UI
      // updates, but a notification bug must never block rendering — hence the guard.
      try { detectStatusTransitions(map); } catch (e) { console.warn('[NotifMgr] detect failed:', e && e.message); }
      // 3s 高频路径：只键控刷新会话卡 + 脏检查 focus，不重建 rail 静态区块。
      renderTabStrip(); renderRailSessions(); renderFocusIfChanged(); renderAskAlert(); renderOverviewIfChanged();
      refreshActivePidExtras();
    }).catch(function() {});
  }
  function refreshStats() {
    api('/api/launcher/usage/summary?range=today').then(function(d) {
      paintCost(d.totalUSD);
    }).catch(function() {});
    api('/api/launcher/quota/5h').then(function(q) { paintQuota(q); }).catch(function() {});
  }

  // ---------- term panel drag-resize ----------
  // 0cd30b5 改成 flex: 1 1 0 + min-height: 280px (auto-absorb leftover space).
  // 在 flex 布局里 inline height 会被 flex-basis 算法忽略, 所以这里改成
  // 调整 flex-basis + 关掉 min-height, 让 drag 能真正生效, 并放开上限
  // 到窗口高度 - 100px, 用户能把 term 往上拉覆盖几乎整个 focus。
  function applyTermSize(h) {
    var panel = document.getElementById('term-panel');
    if (!panel) return;
    panel.style.flex = '0 0 ' + h + 'px';
    panel.style.minHeight = '0';
  }
  function wireTermHandle() {
    var handle = document.getElementById('term-handle');
    var panel = document.getElementById('term-panel');
    if (!handle || !panel) return;
    if (_state.termHeight) applyTermSize(_state.termHeight);
    var dragging = false, startY = 0, startH = 0;
    handle.addEventListener('mousedown', function(e) {
      if (panel.classList.contains('collapsed')) return;
      dragging = true; startY = e.clientY; startH = panel.getBoundingClientRect().height;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var dy = startY - e.clientY;
      var maxH = Math.max(200, window.innerHeight - 100);
      var h = Math.max(80, Math.min(maxH, startH + dy));
      applyTermSize(h);
    });
    document.addEventListener('mouseup', function() {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      _state.termHeight = document.getElementById('term-panel').getBoundingClientRect().height;
      persistState();
    });
  }

  // ---------- mobile bar wires ----------
  function wireMobile() {
    document.getElementById('mob-ccv').addEventListener('click', function() {
      var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
      if (inst) openCcv(inst);
    });
    document.getElementById('mob-console').addEventListener('click', function() {
      var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
      if (inst) openSheet('console', inst);
    });
    document.getElementById('mob-shell').addEventListener('click', function() {
      var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
      if (inst) openSheet('shell', inst);
    });
    document.getElementById('sheet-close').addEventListener('click', closeSheet);
  }

  // ---------- keyboard ----------
  function toggleHelp(force) {
    var ov = document.getElementById('help-overlay');
    if (!ov) return;
    var open = force == null ? !ov.classList.contains('open') : force;
    ov.classList.toggle('open', open);
  }
  function activeInst() { return _state.instances.find(function(x) { return x.pid === _state.activePid; }); }
  function isOpenEl(id) { var el = document.getElementById(id); return !!(el && el.classList.contains('open')); }
  // 是否有任何模态/浮层打开（含原生 <dialog open>：confirm/ops）。
  function anyModalOpen() {
    return !!document.querySelector('dialog[open]') || isOpenEl('help-overlay') ||
      isOpenEl('cmd-palette') || isOpenEl('ccv-overlay') || isOpenEl('term-sheet');
  }

  document.addEventListener('keydown', function(e) {
    // Bail on form fields AND when focus is inside an embedded terminal (xterm
    // routes keys via a hidden textarea, but guard the host div too so single-key
    // shortcuts like c/w/r never leak into a focused Console/Shell pane).
    var inTerm = e.target && e.target.closest && e.target.closest('.term-xterm-host, #term-sheet');
    if ((e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) || inTerm) {
      if (e.key === 'Escape' && e.target.id === 'filter') { e.target.blur(); }
      return;
    }
    // Esc closes the topmost overlay we manage (native <dialog> handles its own Esc).
    if (e.key === 'Escape') {
      if (isOpenEl('help-overlay')) { toggleHelp(false); return; }
      if (isOpenEl('cmd-palette') && typeof closeCommandPalette === 'function') { closeCommandPalette(); return; }
      if (isOpenEl('ccv-overlay')) { closeCcv(); return; }
      if (isOpenEl('term-sheet')) { closeSheet(); return; }
      return;
    }
    // '?' toggles help (works even when help itself is open), but not over a dialog/palette/overlay.
    if (e.key === '?') {
      if (!document.querySelector('dialog[open]') && !isOpenEl('cmd-palette') && !isOpenEl('ccv-overlay') && !isOpenEl('term-sheet')) { e.preventDefault(); toggleHelp(); }
      return;
    }
    // Any modal/overlay open → suppress action shortcuts (incl ⌘K) so e.g. W can't
    // re-invoke killCcv() and showModal() an already-open confirm dialog.
    if (anyModalOpen()) return;
    // command palette: ⌘K / Ctrl+K
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      if (typeof openCommandPalette === 'function') { e.preventDefault(); openCommandPalette(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('filter').focus();
    } else if (e.key >= '1' && e.key <= '9') {
      var vis = filteredInstancesWithActivePinned();
      var pick = vis[(+e.key) - 1];
      if (pick) { e.preventDefault(); setActive(pick.pid); }
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      openNew();
    } else if (e.key === 'w' || e.key === 'W') {
      var ki = activeInst();
      if (ki && !ki.isHub) { e.preventDefault(); killCcv(ki); }
    } else if (e.key === 'r' || e.key === 'R') {
      var ri = activeInst();
      if (ri && !ri.isHub) { e.preventDefault(); editAlias(ri); }
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      setViewMode(_state.viewMode === 'overview' ? 'focus' : 'overview');
    } else if (e.key === 'j' || e.key === 'n' || e.key === 'J' || e.key === 'N') {
      jumpNextAsk();
    }
  });
  // click outside the help panel closes it
  (function() {
    var ov = document.getElementById('help-overlay');
    if (ov) ov.addEventListener('click', function(e) { if (e.target === ov) toggleHelp(false); });
  })();

  // ---------- notification manager ----------
  var NOTIF_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2358a6ff'/%3E%3Ctext x='32' y='42' font-family='Inter,Arial,sans-serif' font-size='32' font-weight='700' text-anchor='middle' fill='%230d1117'%3Ecc%3C/text%3E%3C/svg%3E";
  var NOTIF_CLAIM_WINDOW_MS = 4000;
  var NOTIF_CLEANUP_INTERVAL_MS = 5000;
  var NOTIF_THROTTLE_MS = 5 * 60 * 1000;
  var NOTIF_INTEREST = {
    waiting_ask:   { title: '需要回答', body: '%name 提了一个问题' },
    waiting_tool:  { title: '等待授权', body: '%name 的工具调用等待批准' },
    waiting_input: { title: '完成一轮', body: '%name 等待你的下一步指令' },
    error:         { title: '出错',     body: '%name 出现异常' },
  };
  var _notifChannel = null;
  var _notifCleanupTimer = null;

  function instanceDisplayName(inst) {
    if (!inst) return '实例';
    return inst.alias || inst.displayName || inst.projectName
      || (inst.cwd ? String(inst.cwd).split('/').pop() : '')
      || ('PID ' + inst.pid);
  }

  function loadNotifPrefs() {
    try {
      var stored = JSON.parse(localStorage.getItem('ccvNotifPrefs') || '{}');
      _state.notifPrefs = {
        enabled: !!stored.enabled,
        soundEnabled: stored.soundEnabled !== false,
      };
    } catch (e) {
      _state.notifPrefs = { enabled: false, soundEnabled: true };
    }
  }

  function saveNotifPrefs(broadcast) {
    try {
      localStorage.setItem('ccvNotifPrefs', JSON.stringify({
        enabled: !!_state.notifPrefs.enabled,
        soundEnabled: !!_state.notifPrefs.soundEnabled,
        _v: 1,
      }));
    } catch (e) {}
    refreshNotifIndicator();
    if (broadcast) {
      var ch = getNotifChannel();
      if (ch) {
        try { ch.postMessage({ type: 'prefs', prefs: _state.notifPrefs, ts: Date.now() }); } catch (e) {}
      }
    }
  }

  function getNotifChannel() {
    if (_notifChannel) return _notifChannel;
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
      _notifChannel = new BroadcastChannel('ccv-notif');
      _notifChannel.onmessage = function(ev) {
        var d = ev && ev.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'claim' && d.tag) {
          _state.notifRecentTags[d.tag] = d.ts || Date.now();
        } else if (d.type === 'prefs' && d.prefs) {
          _state.notifPrefs = {
            enabled: !!d.prefs.enabled,
            soundEnabled: d.prefs.soundEnabled !== false,
          };
          renderNotifPanel();
          refreshNotifIndicator();
        }
      };
      if (_notifCleanupTimer) clearInterval(_notifCleanupTimer);
      _notifCleanupTimer = setInterval(function() {
        var now = Date.now();
        var keys = Object.keys(_state.notifRecentTags);
        for (var i = 0; i < keys.length; i++) {
          if (now - _state.notifRecentTags[keys[i]] > NOTIF_CLEANUP_INTERVAL_MS) {
            delete _state.notifRecentTags[keys[i]];
          }
        }
        var tkeys = Object.keys(_state.notifThrottle);
        for (var j = 0; j < tkeys.length; j++) {
          if (now - _state.notifThrottle[tkeys[j]] > NOTIF_THROTTLE_MS * 2) {
            delete _state.notifThrottle[tkeys[j]];
          }
        }
      }, NOTIF_CLEANUP_INTERVAL_MS);
    } catch (e) {
      _notifChannel = null;
    }
    return _notifChannel;
  }

  function notifPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission || 'default';
  }

  function requestNotifPermission() {
    if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    try {
      var r = Notification.requestPermission();
      if (r && typeof r.then === 'function') return r;
      return Promise.resolve(Notification.permission);
    } catch (e) {
      return Promise.resolve(Notification.permission || 'denied');
    }
  }

  function ensureAudioCtx() {
    if (_state.audioCtx) return _state.audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      _state.audioCtx = new AC();
    } catch (e) {
      console.warn('[NotifMgr] AudioContext init failed:', e && e.message);
      _state.audioCtx = null;
    }
    return _state.audioCtx;
  }

  function playBeep() {
    if (!_state.notifPrefs.soundEnabled) return;
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.34);
    } catch (e) {
      console.warn('[NotifMgr] playBeep failed:', e && e.message);
    }
  }

  // Tag identifies a (pid, state, event) triple. Second-level stamp keeps the tag
  // stable across the 3s poll window so the OS dedups repeats; lastEventAt may be
  // null on probe errors → fall back to 0 (subsequent error entries on same pid
  // stay deduped, which is the desired behavior).
  function buildNotifTag(pid, status, lastEventAt) {
    var stamp = 0;
    if (lastEventAt) {
      var t = Date.parse(lastEventAt);
      if (!isNaN(t)) stamp = Math.floor(t / 1000);
    }
    return 'ccv-' + pid + '-' + status + '-' + stamp;
  }

  function showNotif(title, body, tag, pid, status) {
    if (!_state.notifPrefs.enabled) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    // When Web Push is subscribed and the page is hidden, let the server's
    // push (delivered via SW) be the sole channel — otherwise iOS would
    // fire nothing AND Chrome would fire both (in-window + SW push). Tags
    // match so OS-level dedup catches the overlap if it still occurs.
    if (_state.push && _state.push.subscribed && document && document.visibilityState === 'hidden') return;
    var claimedAt = _state.notifRecentTags[tag];
    if (claimedAt && Date.now() - claimedAt < NOTIF_CLAIM_WINDOW_MS) return;
    _state.notifRecentTags[tag] = Date.now();
    var ch = getNotifChannel();
    if (ch) {
      try { ch.postMessage({ type: 'claim', tag: tag, ts: Date.now() }); } catch (e) {}
    }
    try {
      var n = new Notification(title, { body: body, tag: tag, icon: NOTIF_FAVICON });
      n.onclick = function() {
        try { window.focus(); } catch (e) {}
        if (pid != null) {
          try { setActive(pid); } catch (e) { _state.activePid = pid; }
        }
        try { n.close(); } catch (e) {}
      };
    } catch (e) {
      console.warn('[NotifMgr] Notification failed:', e && e.message);
    }
  }

  function detectStatusTransitions(map) {
    if (!_state.notifPrefs.enabled || _state.notifSkipNextDetect) {
      // Refresh baseline without notifying.
      var snap = {};
      for (var k = 0; k < _state.instances.length; k++) {
        var p = _state.instances[k].pid;
        snap[p] = map[p] && map[p].status || 'no_session';
      }
      _state.lastStatusByPid = snap;
      _state.notifSkipNextDetect = false;
      return;
    }
    for (var i = 0; i < _state.instances.length; i++) {
      var inst = _state.instances[i];
      var pid = inst.pid;
      var act = map[pid];
      var curr = (act && act.status) || 'no_session';
      var prev = _state.lastStatusByPid[pid];
      // First time we see this pid: just set baseline. Notifying here would fire
      // on every page reload (when the in-memory snapshot is empty but the server
      // already shows the instance in waiting_ask/error/etc.), which is noise.
      if (prev === undefined) {
        _state.lastStatusByPid[pid] = curr;
        continue;
      }
      if (curr === prev) continue;
      var meta = NOTIF_INTEREST[curr];
      if (!meta) {
        _state.lastStatusByPid[pid] = curr;
        continue;
      }
      // waiting_ask: skip if already answered or no real ask payload
      if (curr === 'waiting_ask') {
        var asks = extractAsks(act);
        if (!asks.length || _state.answered[pid]) {
          _state.lastStatusByPid[pid] = curr;
          continue;
        }
      }
      // Throttle key includes lastEventAt so distinct events (e.g. ask A → answer →
      // ask B within 5 min) are still allowed; only the same event reentering the
      // same state within 5 min is suppressed (e.g. idle↔error flapping).
      var tkey = buildNotifTag(pid, curr, act && act.lastEventAt);
      var lastAt = _state.notifThrottle[tkey] || 0;
      if (Date.now() - lastAt < NOTIF_THROTTLE_MS) {
        _state.lastStatusByPid[pid] = curr;
        continue;
      }
      _state.notifThrottle[tkey] = Date.now();
      var name = instanceDisplayName(inst);
      showNotif(meta.title, meta.body.replace('%name', name),
                buildNotifTag(pid, curr, act && act.lastEventAt), pid, curr);
      playBeep();
      _state.lastStatusByPid[pid] = curr;
    }
  }

  function refreshNotifIndicator() {
    var btn = document.getElementById('btn-notif');
    if (!btn) return;
    btn.setAttribute('data-on', _state.notifPrefs.enabled && notifPermission() === 'granted' ? '1' : '0');
  }

  function renderNotifPanel() {
    var dlg = document.getElementById('notif-dlg');
    if (!dlg) return;
    var cbE = document.getElementById('notif-enabled');
    var cbS = document.getElementById('notif-sound');
    var perm = document.getElementById('notif-perm');
    var caps = document.getElementById('notif-caps');
    if (cbE) cbE.checked = !!_state.notifPrefs.enabled;
    if (cbS) cbS.checked = !!_state.notifPrefs.soundEnabled;
    var permState = notifPermission();
    if (perm) {
      perm.textContent = permState;
      perm.className = 'perm-badge ' + permState;
    }
    if (caps) {
      var msgs = [];
      if (permState === 'unsupported') msgs.push('此浏览器不支持桌面通知');
      if (permState === 'denied') msgs.push('权限被拒绝，需在浏览器地址栏设置中重新允许');
      if (typeof BroadcastChannel === 'undefined') msgs.push('当前浏览器不支持跨标签同步');
      if (!(window.AudioContext || window.webkitAudioContext)) msgs.push('当前浏览器不支持 Web Audio，蜂鸣不可用');
      caps.textContent = msgs.join(' · ');
      caps.hidden = !msgs.length;
    }
    refreshPushPanel();
  }

  function openNotifDlg() {
    renderNotifPanel();
    var dlg = document.getElementById('notif-dlg');
    if (dlg && typeof dlg.showModal === 'function') {
      try { dlg.showModal(); } catch (e) {}
    }
  }

  // ---------- web push (PWA / iOS) ----------
  // SW + pushManager.subscribe + reconcile with server. Distinct from the
  // in-window Notification path: those go through new Notification() and
  // only work while the page is alive. Web Push goes through APNs / FCM
  // and survives PWA suspension on iOS.
  function pushSupported() {
    return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  }
  function b64urlToUint8Array(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function registerSW() {
    if (!pushSupported()) return Promise.reject(new Error('unsupported'));
    return navigator.serviceWorker.register('/launcher/sw.js', { scope: '/launcher/' });
  }
  function getExistingSubscription() {
    if (!pushSupported()) return Promise.resolve(null);
    return navigator.serviceWorker.ready.then(function(reg) { return reg.pushManager.getSubscription(); });
  }
  // Reconcile on boot: browser may still hold a sub from a previous session
  // while the server's push-subs.json is gone (launcher restart cleared it).
  // We silently re-POST so the user doesn't lose pushes after a hub bounce.
  function pushReconcile() {
    if (!pushSupported()) {
      _state.push.supported = false;
      refreshPushPanel();
      return;
    }
    _state.push.supported = true;
    getExistingSubscription().then(function(sub) {
      if (!sub) { _state.push.subscribed = false; _state.push.endpoint = null; refreshPushPanel(); return; }
      _state.push.subscribed = true;
      _state.push.endpoint = sub.endpoint;
      refreshPushPanel();
      var qs = 'endpoint=' + encodeURIComponent(sub.endpoint);
      api('/api/launcher/push/check?' + qs).then(function(r) {
        if (r && r.known === false) {
          // Server forgot us — re-POST without re-prompting.
          var subJson = sub.toJSON();
          api('/api/launcher/push/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
          }).catch(function(e) { console.warn('[push] reconcile re-subscribe failed:', e && e.message); });
        }
      }).catch(function() { /* offline or auth missing — ignore */ });
    });
  }
  function pushSubscribe() {
    if (!pushSupported()) return Promise.reject(new Error('unsupported'));
    _state.push.status = 'subscribing'; _state.push.error = ''; refreshPushPanel();
    return Promise.resolve()
      .then(function() {
        if (Notification.permission === 'granted') return 'granted';
        return Notification.requestPermission();
      })
      .then(function(perm) {
        if (perm !== 'granted') throw new Error('notification permission ' + perm);
        return api('/api/launcher/push/vapid-public-key');
      })
      .then(function(r) {
        if (!r || !r.publicKey) throw new Error('vapid public key unavailable');
        return navigator.serviceWorker.ready.then(function(reg) {
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64urlToUint8Array(r.publicKey),
          });
        });
      })
      .then(function(sub) {
        var sj = sub.toJSON();
        return api('/api/launcher/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sj.endpoint, keys: sj.keys }),
        }).then(function() { return sub; });
      })
      .then(function(sub) {
        _state.push.subscribed = true;
        _state.push.endpoint = sub.endpoint;
        _state.push.status = 'idle';
        refreshPushPanel();
      })
      .catch(function(err) {
        _state.push.status = 'idle';
        _state.push.error = (err && err.message) || 'subscribe failed';
        refreshPushPanel();
        console.warn('[push] subscribe failed:', err);
      });
  }
  function pushUnsubscribe() {
    if (!pushSupported()) return Promise.resolve();
    _state.push.status = 'unsubscribing'; refreshPushPanel();
    return getExistingSubscription().then(function(sub) {
      if (!sub) {
        _state.push.subscribed = false; _state.push.endpoint = null;
        _state.push.status = 'idle'; refreshPushPanel();
        return;
      }
      var endpoint = sub.endpoint;
      return sub.unsubscribe()
        .then(function() {
          return api('/api/launcher/push/unsubscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: endpoint }),
          }).catch(function() { /* server-side cleanup is best-effort */ });
        })
        .then(function() {
          _state.push.subscribed = false; _state.push.endpoint = null;
          _state.push.status = 'idle'; refreshPushPanel();
        });
    });
  }
  function refreshPushPanel() {
    var badge = document.getElementById('push-status');
    var subBtn = document.getElementById('push-subscribe');
    var unsubBtn = document.getElementById('push-unsubscribe');
    var caps = document.getElementById('push-caps');
    var p = _state.push;
    if (badge) {
      if (!p.supported) { badge.textContent = '不支持'; badge.className = 'perm-badge unsupported'; }
      else if (p.status === 'subscribing') { badge.textContent = '订阅中…'; badge.className = 'perm-badge default'; }
      else if (p.status === 'unsubscribing') { badge.textContent = '取消中…'; badge.className = 'perm-badge default'; }
      else if (p.subscribed) { badge.textContent = '已订阅'; badge.className = 'perm-badge granted'; }
      else { badge.textContent = '未启用'; badge.className = 'perm-badge default'; }
    }
    if (subBtn) subBtn.disabled = !p.supported || p.subscribed || p.status !== 'idle';
    if (unsubBtn) unsubBtn.disabled = !p.supported || !p.subscribed || p.status !== 'idle';
    var testBtn = document.getElementById('push-test');
    if (testBtn) testBtn.disabled = !p.supported || !p.subscribed || p.status !== 'idle';
    if (caps) {
      var msgs = [];
      if (!p.supported) msgs.push('当前浏览器不支持 Web Push（iOS 必须 ≥ 16.4 且从主屏图标启动）');
      if (p.error) msgs.push('最近错误: ' + p.error);
      caps.textContent = msgs.join(' · ');
      caps.hidden = !msgs.length;
    }
  }
  function bindPushUI() {
    var sub = document.getElementById('push-subscribe');
    var unsub = document.getElementById('push-unsubscribe');
    var test = document.getElementById('push-test');
    if (sub) sub.addEventListener('click', function() { pushSubscribe(); });
    if (unsub) unsub.addEventListener('click', function() { pushUnsubscribe(); });
    if (test) test.addEventListener('click', function() {
      api('/api/launcher/push/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '测试推送 · ' + new Date().toLocaleTimeString() }),
      }).then(function(r) {
        _state.push.error = '';
        if (!r || r.sent === 0) {
          _state.push.error = '后端没把推送送出去: ' + JSON.stringify(r && r.results && r.results[0] || r);
        }
        refreshPushPanel();
      }).catch(function(err) {
        _state.push.error = (err && err.message) || 'test failed';
        refreshPushPanel();
      });
    });
  }
  function wireSWMessages() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', function(ev) {
      var d = ev && ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'notification:navigate' && d.pid != null) {
        try { setActive(+d.pid); } catch (e) { _state.activePid = +d.pid; }
      }
    });
  }

  function bindNotifUI() {
    var btn = document.getElementById('btn-notif');
    if (btn) btn.addEventListener('click', openNotifDlg);
    var dlg = document.getElementById('notif-dlg');
    var cbE = document.getElementById('notif-enabled');
    var cbS = document.getElementById('notif-sound');
    var reqBtn = document.getElementById('notif-req-perm');
    var testBtn = document.getElementById('notif-test');
    var closeBtn = document.getElementById('notif-close');
    if (cbE) {
      cbE.addEventListener('change', function() {
        if (cbE.checked) {
          var perm = notifPermission();
          if (perm === 'unsupported') {
            cbE.checked = false;
            renderNotifPanel();
            return;
          }
          if (perm === 'default') {
            requestNotifPermission().then(function(r) {
              if (r !== 'granted') {
                cbE.checked = false;
              }
              _state.notifPrefs.enabled = cbE.checked;
              saveNotifPrefs(true);
              renderNotifPanel();
            });
            return;
          }
          if (perm === 'denied') {
            cbE.checked = false;
            renderNotifPanel();
            return;
          }
        }
        _state.notifPrefs.enabled = cbE.checked;
        // Pre-warm AudioContext on this user gesture so future beeps are unlocked.
        if (cbE.checked) { ensureAudioCtx(); var c = _state.audioCtx; if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} } }
        saveNotifPrefs(true);
        renderNotifPanel();
      });
    }
    if (cbS) {
      cbS.addEventListener('change', function() {
        _state.notifPrefs.soundEnabled = cbS.checked;
        if (cbS.checked) { ensureAudioCtx(); var c = _state.audioCtx; if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} } }
        saveNotifPrefs(true);
      });
    }
    if (reqBtn) {
      reqBtn.addEventListener('click', function() {
        requestNotifPermission().then(function() { renderNotifPanel(); });
      });
    }
    if (testBtn) {
      testBtn.addEventListener('click', function() {
        // Force send a one-off test notification, ignoring throttle.
        var name = '试发';
        var tag = 'ccv-test-' + Date.now();
        playBeep();
        if (notifPermission() !== 'granted') {
          requestNotifPermission().then(function(p) {
            if (p === 'granted') {
              _state.notifPrefs.enabled = true;
              saveNotifPrefs(true);
              showNotif('ccv launcher', '测试通知 · ' + name, tag, null, null);
              renderNotifPanel();
            }
          });
          return;
        }
        var was = _state.notifPrefs.enabled;
        _state.notifPrefs.enabled = true;
        showNotif('ccv launcher', '测试通知 · ' + name, tag, null, null);
        _state.notifPrefs.enabled = was;
      });
    }
    if (closeBtn && dlg) closeBtn.addEventListener('click', function() { try { dlg.close(); } catch (e) {} });
  }

  window.addEventListener('beforeunload', function() {
    try { if (_notifChannel) _notifChannel.close(); } catch (e) {}
    try { if (_state.audioCtx) _state.audioCtx.close(); } catch (e) {}
  });

  // ---------- event delegation ----------
  // 单一常驻委托监听（容器级，永不解绑；键控渲染只回收/复用 DOM 节点）。
  // 点击时用 e.target.closest 重新读取 data-*，不依赖渲染期闭包。
  function wireDelegation() {
    var strip = document.getElementById('tab-strip');
    if (strip) strip.addEventListener('click', function(e) {
      var t = e.target.closest('.tab[data-pid]');
      if (t) setActive(+t.getAttribute('data-pid'));
    });
    var rail = document.getElementById('rail');
    if (rail) rail.addEventListener('click', function(e) {
      var sf = e.target.closest('.spawn-fresh');
      if (sf) { e.stopPropagation(); var fc = sf.getAttribute('data-cwd'); if (fc) openNew(fc); return; }
      var hd = e.target.closest('.rail-section .sec-hd');
      if (hd) {
        var sec = hd.closest('.rail-section').getAttribute('data-sec');
        _state.railOpen[sec] = !_state.railOpen[sec];
        persistState(); renderRailExtras(); return;
      }
      var sess = e.target.closest('.rail-sess-card');
      if (sess) { var c = sess.getAttribute('data-cwd'), s = sess.getAttribute('data-sid'); if (c && s) resumeSession(c, s); return; }
      var hist = e.target.closest('.rail-hist-card');
      if (hist) {
        var hcwd = hist.getAttribute('data-cwd'); if (!hcwd) return;
        var hItem = (_state.history || []).find(function(x) { return x.cwd === hcwd; })
                 || (_state.shellHistory || []).find(function(x) { return x.cwd === hcwd; });
        var hasSessions = hItem && +hItem.sessionCount > 0;
        if (!hasSessions) { openNew(hcwd); return; }
        toggleHistExpand(hcwd); return;
      }
      var unt = e.target.closest('.rail-untracked-card');
      if (unt) { takeoverLocal(+unt.getAttribute('data-pid'), unt.getAttribute('data-sid'), unt.getAttribute('data-cwd')); return; }
      var card = e.target.closest('.rail-card[data-pid]');
      if (card) { setActive(+card.getAttribute('data-pid')); return; }
    });
    // 看板卡点击：选中并切到详情视图（Symphony「扫一眼 → 点进去看 agent」）。
    var board = document.getElementById('board-cols');
    if (board) board.addEventListener('click', function(e) {
      var bc = e.target.closest('.board-card[data-pid]');
      if (bc) { setActive(+bc.getAttribute('data-pid')); setViewMode('focus'); }
    });
  }

  // ---------- command palette (⌘K / Ctrl+K) ----------
  var _palItems = [], _palSel = 0;
  // 子序列模糊匹配：连续命中给更高分，无命中返回 -1。
  function fuzzyScore(hay, q) {
    hay = (hay || '').toLowerCase(); q = (q || '').toLowerCase();
    if (!q) return 0;
    var hi = 0, score = 0;
    for (var i = 0; i < q.length; i++) {
      var idx = hay.indexOf(q[i], hi);
      if (idx < 0) return -1;
      score += (idx === hi ? 2 : 1);
      hi = idx + 1;
    }
    return score;
  }
  function paletteSource() {
    var items = [];
    items.push({ label: '＋ 新建会话', search: 'new 新建 spawn create', run: function() { openNew(); } });
    var ai = activeInst();
    if (ai) {
      items.push({ label: '↗ 打开 ccv · ' + tabName(ai), search: 'open ccv ' + tabName(ai), run: function() { openCcv(ai); } });
      if (!ai.isHub) {
        items.push({ label: '✎ 重命名当前 · ' + tabName(ai), search: 'rename alias 重命名 ' + tabName(ai), run: function() { editAlias(ai); } });
        items.push({ label: '⏹ 关闭当前 · ' + tabName(ai), search: 'kill close 关闭 ' + tabName(ai), run: function() { killCcv(ai); } });
      }
    }
    items.push({ label: '⏳ 跳到下一个等回答', search: 'ask jump 等回答', run: jumpNextAsk });
    items.push({ label: '⚙ 运维面板', search: 'ops reaper 运维 worktree push', run: openOpsPanel });
    items.push({ label: '? 快捷键帮助', search: 'help keys 帮助 快捷键', run: function() { toggleHelp(true); } });
    sortInstances(_state.instances).forEach(function(it) {
      var act = _state.activityByPid[it.pid] || {};
      var v = statusView(act.status || 'idle');
      items.push({
        label: '› ' + tabName(it) + (it.port ? '  :' + it.port : ''),
        sub: v.text,
        search: tabName(it) + ' ' + (it.cwd || '') + ' ' + (it.port || ''),
        run: function() { setActive(it.pid); },
      });
    });
    return items;
  }
  function renderPalette(q) {
    var box = document.getElementById('cmd-results');
    if (!box) return;
    var all = paletteSource();
    var filtered;
    if (!q) filtered = all;
    else filtered = all.map(function(it) { return { it: it, s: fuzzyScore((it.search || '') + ' ' + it.label, q) }; })
      .filter(function(x) { return x.s >= 0; })
      .sort(function(a, b) { return b.s - a.s; })
      .map(function(x) { return x.it; });
    _palItems = filtered;
    if (_palSel >= filtered.length) _palSel = Math.max(0, filtered.length - 1);
    if (!filtered.length) { box.innerHTML = '<div class="pi-empty">无匹配</div>'; return; }
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var it = filtered[i];
      html += '<div class="pi' + (i === _palSel ? ' sel' : '') + '" data-i="' + i + '" role="option"' + (i === _palSel ? ' aria-selected="true"' : '') + '>';
      html += '<span class="pi-label">' + escape(it.label) + '</span>';
      if (it.sub) html += '<span class="pi-sub">' + escape(it.sub) + '</span>';
      html += '</div>';
    }
    box.innerHTML = html;
    var sel = box.querySelector('.pi.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  var _palTrigger = null;
  function openCommandPalette() {
    var pal = document.getElementById('cmd-palette');
    var input = document.getElementById('cmd-input');
    if (!pal || !input) return;
    _palTrigger = document.activeElement;
    _palSel = 0;
    pal.classList.add('open');
    input.value = '';
    renderPalette('');
    input.focus();
  }
  function closeCommandPalette() {
    var pal = document.getElementById('cmd-palette');
    if (pal) pal.classList.remove('open');
    if (_palTrigger && _palTrigger.focus) { try { _palTrigger.focus(); } catch (e) {} }
    _palTrigger = null;
  }
  function runPaletteSel() {
    var it = _palItems[_palSel];
    closeCommandPalette();
    if (it && it.run) it.run();
  }

  // ---------- ops panel ----------
  function opsRow(k, v, cls) {
    return '<div class="ops-row"><span>' + escape(k) + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + escape(v) + '</span></div>';
  }
  function openOpsPanel() {
    var dlg = document.getElementById('ops-dlg');
    if (!dlg) return;
    renderOpsPanel();
    if (dlg.showModal && !dlg.open) { try { dlg.showModal(); } catch (e) {} }
  }
  function renderOpsPanel() {
    var body = document.getElementById('ops-body');
    if (!body) return;
    body.innerHTML = '<h3>运维面板</h3><div class="ops-sec"><div class="hd">载入中…</div></div>';
    Promise.all([
      api('/api/launcher/reaper/stats').catch(function() { return null; }),
      api('/api/launcher/push/subscriptions').catch(function() { return null; }),
      api('/api/launcher/worktrees').catch(function() { return null; }),
    ]).then(function(r) {
      var reaper = r[0], push = r[1], wt = r[2];
      var html = '<h3>运维面板</h3>';
      html += '<div class="ops-sec"><div class="hd">Idle Reaper</div>';
      if (reaper) {
        html += opsRow('状态', reaper.running ? '运行中' : '未运行', reaper.running ? 'ok' : 'warn');
        html += opsRow('已回收实例', String(reaper.reaped || 0));
        html += opsRow('tick 次数', String(reaper.ticks || 0));
        html += opsRow('最近 tick', reaper.lastTickAt ? fmtAge(new Date(reaper.lastTickAt).toISOString()) : '—');
      } else { html += '<div class="ops-mini">不可用</div>'; }
      html += '</div>';
      html += '<div class="ops-sec"><div class="hd">Web Push</div>';
      if (push) {
        var subs = push.subs || [];
        html += opsRow('订阅数', String(push.count != null ? push.count : subs.length));
        var poller = push.poller || {};
        if (poller.running != null) html += opsRow('poller', poller.running ? '运行中' : '停止', poller.running ? 'ok' : 'warn');
        var failing = subs.filter(function(s) { return s.lastFailAt && (!s.lastOkAt || s.lastFailAt > s.lastOkAt); }).length;
        if (failing) html += opsRow('投递失败的订阅', String(failing), 'bad');
      } else { html += '<div class="ops-mini">不可用</div>'; }
      html += '</div>';
      html += '<div class="ops-sec"><div class="hd">Worktrees</div>';
      if (wt && wt.worktrees) {
        var list = wt.worktrees;
        html += opsRow('总数', String(wt.count != null ? wt.count : list.length));
        var orphan = list.filter(function(w) { return !w.alive; }).length;
        var dirty = list.filter(function(w) { return w.hasUncommitted; }).length;
        if (orphan) html += opsRow('孤儿(进程已退)', String(orphan), 'warn');
        if (dirty) html += opsRow('有未提交改动', String(dirty), 'warn');
        list.slice(0, 8).forEach(function(w) {
          html += '<div class="ops-mini" title="' + escape(w.path || '') + '">' + (w.alive ? '● ' : '○ ') + escape(w.branch || '?') + (w.hasUncommitted ? ' *' : '') + '</div>';
        });
      } else { html += '<div class="ops-mini">不可用</div>'; }
      html += '</div>';
      body.innerHTML = html;
    });
  }

  function wireCmdAndOps() {
    var input = document.getElementById('cmd-input');
    var results = document.getElementById('cmd-results');
    var pal = document.getElementById('cmd-palette');
    if (input) {
      input.addEventListener('input', function() { _palSel = 0; renderPalette(input.value.trim()); });
      input.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (_palItems.length) { _palSel = (_palSel + 1) % _palItems.length; renderPalette(input.value.trim()); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (_palItems.length) { _palSel = (_palSel - 1 + _palItems.length) % _palItems.length; renderPalette(input.value.trim()); } }
        else if (e.key === 'Enter') { e.preventDefault(); runPaletteSel(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
      });
    }
    if (results) results.addEventListener('click', function(e) {
      var row = e.target.closest('.pi[data-i]');
      if (!row) return;
      _palSel = +row.getAttribute('data-i');
      runPaletteSel();
    });
    if (pal) pal.addEventListener('click', function(e) { if (e.target === pal) closeCommandPalette(); });
    var oc = document.getElementById('ops-close'); if (oc) oc.addEventListener('click', function() { var d = document.getElementById('ops-dlg'); if (d) { try { d.close(); } catch (e) {} } });
    var orf = document.getElementById('ops-refresh'); if (orf) orf.addEventListener('click', renderOpsPanel);
  }

  // ---------- boot ----------
  function init() {
    // Notification settings (load prefs + wire UI before first activity poll
    // so detect logic has its baseline ready).
    loadNotifPrefs();
    getNotifChannel();
    bindNotifUI();
    bindPushUI();
    refreshNotifIndicator();
    // SW + push: don't block init on registration. Errors are non-fatal —
    // the UI just stays in "未启用" / "不支持" until the user can act.
    if (pushSupported()) {
      registerSW().then(function() {
        wireSWMessages();
        pushReconcile();
      }).catch(function(err) { console.warn('[push] sw register failed:', err && err.message); refreshPushPanel(); });
    } else {
      refreshPushPanel();
    }

    // Wire static interactions
    document.getElementById('btn-new').addEventListener('click', openNew);
    document.getElementById('ask-count').addEventListener('click', jumpNextAsk);
    (function() {
      var vt = document.getElementById('view-toggle');
      if (vt) vt.addEventListener('click', function(e) {
        var b = e.target.closest('button[data-view]');
        if (b) setViewMode(b.getAttribute('data-view'));
      });
    })();
    document.getElementById('new-cancel').addEventListener('click', function() { document.getElementById('dlg').close(); });
    document.getElementById('new-launch').addEventListener('click', submitNew);
    document.getElementById('ccv-close').addEventListener('click', closeCcv);
    document.getElementById('ccv-reload').addEventListener('click', reloadActiveCcv);
    document.getElementById('ccv-newtab').addEventListener('click', openActiveCcvInNewTab);
    document.getElementById('ccv-err-retry').addEventListener('click', reloadActiveCcv);
    document.getElementById('ccv-err-newtab').addEventListener('click', openActiveCcvInNewTab);
    document.getElementById('term-toggle').addEventListener('click', toggleTerm);
    document.getElementById('term-clear').addEventListener('click', function() {
      if (_state.termTab === 'console' && _console) _console.term.clear();
      else if (_state.termTab === 'shell' && _shell) _shell.term.clear();
      else if (_state.termTab === 'logs') {
        var h = document.getElementById('host-logs');
        if (h) h.innerHTML = '<div class="empty">cleared (next poll will repopulate)</div>';
      }
    });
    [].forEach.call(document.querySelectorAll('#term-tabs .term-tab'), function(t) {
      t.addEventListener('click', function() { setTermTab(t.getAttribute('data-tab')); });
    });
    var _filterDeb = null;
    document.getElementById('filter').addEventListener('input', function(e) {
      _state.filter = e.target.value;
      if (_filterDeb) clearTimeout(_filterDeb);
      // extras (历史/shell 历史) are filtered too — must re-render on filter change.
      _filterDeb = setTimeout(function() { renderTabStrip(); renderRailSessions(); renderRailExtras(); renderOverviewIfChanged(); }, 120);
    });
    wireDelegation();
    wireCmdAndOps();
    wireTermHandle();
    wireMobile();
    applyViewDom(); // reflect persisted/default viewMode before first paint
    if (!_state.termOpen) {
      document.getElementById('term-panel').classList.add('collapsed');
      document.getElementById('term-toggle').textContent = '▴';
    }
    // Probe hub capabilities first so SHELL tab knows whether to bother with WS.
    api('/api/launcher/capabilities').then(function(c) {
      if (c && typeof c === 'object') _state.caps = Object.assign({ shell: true }, c);
      if (_state.caps && _state.caps.shell === false) {
        var shellTab = document.querySelector('#term-tabs .term-tab[data-tab="shell"]');
        if (shellTab) {
          shellTab.classList.add('disabled');
          shellTab.title = 'shell pty 不可用（cc-viewer 缺 pty-session-manager）';
        }
      }
    }).catch(function() {});
    // Initial load — sequence: list (sets activePid) → activity → stats
    loadPrefs();
    refreshList().then(function() {
      refreshActivity().then(function() {
        if (!isMobileViewport()) setTermTab(_state.termTab, true);
      });
      refreshStats();
    });
    // pollers
    if (_actTimer) clearInterval(_actTimer);
    if (_listTimer) clearInterval(_listTimer);
    if (_statsTimer) clearInterval(_statsTimer);
    _actTimer = setInterval(function() { if (_visible) refreshActivity(); }, 3000);
    _listTimer = setInterval(function() { if (_visible) refreshList(); }, 30000);
    _statsTimer = setInterval(function() { if (_visible) refreshStats(); }, 10000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
</body>
</html>`;
