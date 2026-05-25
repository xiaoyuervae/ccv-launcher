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
  #app-bar .stat-quota .bar { width: 48px; height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
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
  }
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
  <input type="text" id="filter" placeholder="filter  /" spellcheck="false" autocomplete="off">
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
        <div class="term-pane" data-tab="logs"><div class="term-logs-host" id="host-logs"><div class="empty">no logs yet</div></div></div>
      </div>
    </div>
  </section>
</main>

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
        header: q.header || '',
        context: a.context || a.summary || '',
        choices: choices,
        multiSelect: !!q.multiSelect,
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
  function renderTabStrip() {
    var strip = document.getElementById('tab-strip');
    if (!strip) return;
    var inst = filteredInstances();
    if (!inst.length) {
      strip.innerHTML = '<div class="empty" style="padding:8px 12px;font-size:11px">no instances</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < inst.length; i++) {
      var it = inst[i];
      var act = _state.activityByPid[it.pid] || {};
      var view = statusView(act.status || 'idle');
      var asks = extractAsks(act);
      var needsAsk = asks.length > 0 && !_state.answered[it.pid];
      var active = it.pid === _state.activePid;
      var name = it.alias || it.displayName || it.projectName || (it.cwd ? it.cwd.split('/').pop() : '?');
      html += '<div class="tab' + (active ? ' active' : '') + (needsAsk && active ? ' needs-ask' : '') + '" data-pid="' + it.pid + '">';
      html += '<span class="dot" style="background:' + view.dot + '"></span>';
      if (it.isHub) html += '<span class="hub-tag">HUB</span>';
      html += '<span class="name">' + escape(name) + '</span>';
      if (it.port) html += '<span class="port">:' + it.port + '</span>';
      if (needsAsk) html += '<span class="ask-badge">!</span>';
      html += '</div>';
    }
    strip.innerHTML = html;
    [].forEach.call(strip.querySelectorAll('.tab'), function(el) {
      el.addEventListener('click', function() {
        var pid = +el.getAttribute('data-pid');
        setActive(pid);
      });
    });
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
  function renderRail() {
    var el = document.getElementById('rail');
    if (!el) return;
    var inst = filteredInstances();
    var html = '';
    if (!inst.length) {
      html += '<div class="empty" style="padding:10px 4px;font-size:11px">no sessions</div>';
    } else {
      html += '<div class="rail-hd">会话 · ' + inst.length + '</div>';
      for (var i = 0; i < inst.length; i++) {
        var it = inst[i];
        var act = _state.activityByPid[it.pid] || {};
        var view = statusView(act.status || 'idle');
        var active = it.pid === _state.activePid;
        var needsAsk = act.status === 'waiting_ask' && !_state.answered[it.pid];
        var name = it.alias || it.displayName || it.projectName || (it.cwd ? it.cwd.split('/').pop() : '?');
        var sub = act.title || (act.preview ? act.preview.replace(/^user:\s*/, '') : '') || (it.cwd || '').split('/').slice(-2).join('/');
        html += '<div class="rail-card' + (active ? ' active' : '') + '" style="border-left-color:' + view.dot + '" data-pid="' + it.pid + '">';
        html += '<div class="top">';
        html += '<span class="name">' + escape(name) + '</span>';
        if (needsAsk) html += '<span class="ask-pill">!</span>';
        html += '<span class="age">' + escape(fmtAge(act.lastEventAt)) + '</span>';
        html += '</div>';
        html += '<div class="sub">' + escape(sub || '—') + '</div>';
        html += '</div>';
      }
    }

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

    if (!html) html = '<div class="empty" style="padding:10px 4px;font-size:11px">no sessions</div>';
    el.innerHTML = html;

    [].forEach.call(el.querySelectorAll('.rail-card'), function(card) {
      card.addEventListener('click', function() { setActive(+card.getAttribute('data-pid')); });
    });
    [].forEach.call(el.querySelectorAll('.rail-section .sec-hd'), function(hd) {
      hd.addEventListener('click', function() {
        var sec = hd.parentNode.getAttribute('data-sec');
        _state.railOpen[sec] = !_state.railOpen[sec];
        persistState();
        renderRail();
      });
    });
    [].forEach.call(el.querySelectorAll('.rail-hist-card'), function(card) {
      card.addEventListener('click', function(ev) {
        // "+" 按钮显式新启动，跳过展开逻辑
        if (ev.target && ev.target.classList.contains('spawn-fresh')) {
          ev.stopPropagation();
          var fcwd = ev.target.getAttribute('data-cwd');
          if (fcwd) openNew(fcwd);
          return;
        }
        var cwd = card.getAttribute('data-cwd');
        if (!cwd) return;
        // The same .rail-hist-card class is used by both 历史项目 and shell 历史
        // sections; look in both state lists when computing sessionCount.
        var hItem = (_state.history || []).find(function(x) { return x.cwd === cwd; })
                 || (_state.shellHistory || []).find(function(x) { return x.cwd === cwd; });
        var hasSessions = hItem && +hItem.sessionCount > 0;
        if (!hasSessions) { openNew(cwd); return; }
        toggleHistExpand(cwd);
      });
    });
    [].forEach.call(el.querySelectorAll('.rail-sess-card'), function(card) {
      card.addEventListener('click', function() {
        var cwd = card.getAttribute('data-cwd');
        var sid = card.getAttribute('data-sid');
        if (cwd && sid) resumeSession(cwd, sid);
      });
    });
    [].forEach.call(el.querySelectorAll('.rail-untracked-card'), function(card) {
      card.addEventListener('click', function() {
        takeoverLocal(+card.getAttribute('data-pid'), card.getAttribute('data-sid'), card.getAttribute('data-cwd'));
      });
    });
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
      renderRail();
      return;
    }
    _state.histOpen[cwd] = true;
    var cur = _state.sessionsByCwd[cwd];
    if (!cur || (!cur.loading && (Date.now() - (cur.fetchedAt || 0) > 30000))) {
      fetchSessionsForCwd(cwd);
    }
    renderRail();
  }

  function fetchSessionsForCwd(cwd) {
    _state.sessionsByCwd[cwd] = { loading: true };
    api('/api/launcher/sessions?cwd=' + encodeURIComponent(cwd)).then(function(res) {
      _state.sessionsByCwd[cwd] = {
        items: (res && res.sessions) || [],
        fetchedAt: Date.now(),
      };
      // 只重渲展开中的卡片，避免抖动其他东西
      if (_state.histOpen[cwd]) renderRail();
    }).catch(function(err) {
      _state.sessionsByCwd[cwd] = { items: [], fetchedAt: Date.now(), error: err.message };
      if (_state.histOpen[cwd]) renderRail();
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
    }).catch(function(err) {
      alert('resume 失败: ' + (err && err.message || err));
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
  function renderFocus() {
    var el = document.getElementById('focus');
    if (!el) return;
    var inst = _state.instances.find(function(x) { return x.pid === _state.activePid; });
    if (!inst) { el.innerHTML = '<div class="empty">select a session</div>'; return; }
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
      html += '<div class="focus-card ask">';
      html += '<div class="card-hd">⏳ ccv 在等你回答</div>';
      html += '<div class="ask-q">' + escape(a.question) + '</div>';
      if (a.context) html += '<div class="ask-ctx">' + escape(a.context) + '</div>';
      html += '<div class="ask-choices">';
      if (a.choices.length) {
        for (var i = 0; i < a.choices.length; i++) {
          var c = a.choices[i];
          html += '<button class="ask-btn' + (i === 0 ? ' primary' : '') + '" data-act="open-ccv"' + (c.description ? ' title="' + escape(c.description) + '"' : '') + '>' + escape(c.label) + ' ↗</button>';
        }
      } else {
        html += '<button class="ask-btn primary" data-act="open-ccv">在 ccv 内回答 ↗</button>';
      }
      html += '</div>';
      html += '<div class="ask-ctx" style="margin-top:8px;margin-bottom:0">点选项跳到 ccv 页面回答</div>';
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
  }

  // status -> 排序优先级（小=靠前）：等回答 > 进行中 > 等待 > 空闲 > error
  var STATUS_RANK = {
    waiting_ask: 0,
    thinking: 1, tool_running: 1,
    waiting_tool: 2, waiting_input: 2,
    idle: 3, no_session: 3,
    error: 4,
  };
  function instanceSortKey(it) {
    var act = _state.activityByPid[it.pid] || {};
    var rank = STATUS_RANK[act.status];
    if (rank == null) rank = 3;
    var ts = Date.parse(act.lastEventAt) || 0;
    return { rank: rank, ts: ts };
  }
  function sortInstances(list) {
    return list.slice().sort(function(a, b) {
      var ka = instanceSortKey(a), kb = instanceSortKey(b);
      if (ka.rank !== kb.rank) return ka.rank - kb.rank;
      if (ka.ts !== kb.ts) return kb.ts - ka.ts; // 最近优先
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

  function setActive(pid) {
    if (!pid || pid === _state.activePid) {
      if (pid === _state.activePid) return;
    }
    _state.activePid = pid;
    persistState();
    renderTabStrip();
    renderRail();
    renderFocus();
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

  function editAlias(inst) {
    var current = inst.alias || '';
    var next = prompt('为这个项目设置别名 (留空清除):\\n\\n路径: ' + (inst.cwd || ''), current);
    if (next === null) return;
    next = (next || '').trim();
    if (next === current) return;
    api('/api/launcher/prefs/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: inst.cwd, alias: next }),
    }).then(function() {
      inst.alias = next;
      renderTabStrip(); renderRail(); renderFocus();
    }).catch(function(err) {
      alert('设置别名失败: ' + (err && err.message || err));
    });
  }

  function spawnNewSessionAt(inst, btn) {
    if (!inst || !inst.cwd) return;
    var origLabel = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="lbl">同目录</span><span class="val">Launching…</span>';
    }
    var newPid = null;
    api('/api/launcher/spawn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: inst.cwd,
        force: true,
        ccuseProfile: inst.ccuseProfile || '',
      }),
    }).then(function(res) {
      newPid = (res && res.instance && res.instance.pid) || (res && res.pid) || null;
      return refreshList();
    }).then(function() {
      if (newPid) setActive(newPid);
    }).catch(function(err) {
      alert('新建 session 失败: ' + (err && err.message || err));
    }).finally(function() {
      if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    });
  }

  function killCcv(inst) {
    var name = inst.alias || inst.displayName || inst.projectName || ('pid ' + inst.pid);
    if (!confirm('确认关闭这个 ccv 实例?\\n\\n' + name + (inst.port ? ' :' + inst.port : '') + '\\n\\nSIGTERM 会发送给进程，正在运行的任务会被打断。')) return;
    api('/api/launcher/kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: inst.pid }),
    }).then(function() {
      // Optimistically remove from local state.
      _state.instances = _state.instances.filter(function(x) { return x.pid !== inst.pid; });
      delete _state.activityByPid[inst.pid];
      if (_state.activePid === inst.pid) _state.activePid = activePidOnFirstLoad();
      renderTabStrip(); renderRail(); renderFocus();
      setTimeout(refreshList, 500);
    }).catch(function(err) {
      alert('关闭失败: ' + (err && err.message || err));
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
        }).then(function() { loadPrefs(true).then(renderFocus); })
          .catch(function(err) { alert('设置默认 profile 失败: ' + (err && err.message || err)); });
      });
    }
  }

  function switchCcuse(inst, profile) {
    if (!confirm('切换 ccuse profile 为 "' + (profile || 'default') + '" 会重启 ccv (SIGTERM → 重新 spawn)。继续?')) return;
    api('/api/launcher/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: inst.pid, ccuseProfile: profile }),
    }).then(function(res) {
      // Switch active to the new pid; full refresh follows.
      if (res && res.instance && res.instance.pid) _state.activePid = res.instance.pid;
      loadPrefs(true);
      refreshList();
    }).catch(function(err) {
      alert('切换 profile 失败: ' + (err && err.message || err));
    });
  }

  function takeoverLocal(pid, sessionId, cwd) {
    if (!pid || !sessionId || !cwd) return;
    var msg = '接管裸 claude 进程?\\n\\n' +
              'pid: ' + pid + '\\n' +
              'session: ' + sessionId + '\\n' +
              'cwd: ' + cwd + '\\n\\n' +
              '动作: SIGTERM 该 pid → 在新 Terminal 窗口里 ccv -r <sid> 接管该会话。';
    if (!confirm(msg)) return;
    api('/api/launcher/takeover-cc-session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: pid, sessionId: sessionId, cwd: cwd }),
    }).then(function() {
      // Refresh after a moment so the new ccv shows up via runtime watcher.
      setTimeout(refreshList, 2000);
    }).catch(function(err) {
      alert('接管失败: ' + (err && err.message || err));
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
    if (_visible) { refreshList(); refreshActivity(); refreshStats(); }
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
      renderTabStrip(); renderRail(); renderFocus();
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
      renderTabStrip(); renderRail(); renderFocus(); renderAskAlert();
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
  document.addEventListener('keydown', function(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
      if (e.key === 'Escape' && e.target.id === 'filter') { e.target.blur(); }
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('filter').focus();
    } else if (e.key === 'j' || e.key === 'n' || e.key === 'J' || e.key === 'N') {
      // Jump to next waiting_ask
      var asks = _state.instances.filter(function(x) {
        var a = _state.activityByPid[x.pid];
        return a && a.status === 'waiting_ask' && !_state.answered[x.pid];
      });
      if (!asks.length) return;
      var idx = asks.findIndex(function(x) { return x.pid === _state.activePid; });
      var next = asks[(idx + 1) % asks.length];
      setActive(next.pid);
    } else if (e.key === 'Escape') {
      var ov = document.getElementById('ccv-overlay');
      if (ov && ov.classList.contains('open')) { closeCcv(); return; }
      var sh = document.getElementById('term-sheet');
      if (sh && sh.classList.contains('open')) { closeSheet(); return; }
    }
  });

  // ---------- boot ----------
  function init() {
    // Wire static interactions
    document.getElementById('btn-new').addEventListener('click', openNew);
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
    document.getElementById('filter').addEventListener('input', function(e) {
      _state.filter = e.target.value;
      renderTabStrip(); renderRail();
    });
    wireTermHandle();
    wireMobile();
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
