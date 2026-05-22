// The single-page launcher UI: Kanban dashboard + per-card drawers, inline
// xterm console, ccuse switcher, M2 worktree/PR flow, prefs editor, etc.
//
// Pure data — a backtick template literal. Lives in its own module because
// keeping ~2700 lines of HTML+CSS+inline JS inside the plugin entry made
// editing surrounding logic painful. No interpolations (the template has no
// \${...} substitutions), so importing the same string is safe.

export const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ccv launcher</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<style>
  @font-face {
    font-family: 'NerdFont';
    src: url('https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v3.3.0/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFont-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  :root { --bg:#0d1117; --fg:#e6edf3; --mute:#7d8590; --line:#21262d; --card:#161b22; --card-hover:#1c2128; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --tag-bg:#1f2937; --term-font:'NerdFont','MesloLGS NF','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; background:var(--bg); color:var(--fg); min-height:100vh; min-height:100dvh; padding-bottom:env(safe-area-inset-bottom); }

  /* header */
  header { display:flex; align-items:center; gap:12px; padding:12px 24px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(13,17,23,.85); backdrop-filter:blur(12px); z-index:10; }
  header h1 { font-size:15px; font-weight:600; letter-spacing:-.3px; }
  header .meta { color:var(--mute); font-size:12px; }
  header .grow { flex:1; }
  header button { background:var(--accent); color:#0d1117; border:0; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:opacity .15s; }
  header button:hover { opacity:.85; }

  /* topbar stats (T6: cost + 5h quota) */
  .topbar-stats { display:flex; align-items:center; gap:10px; font-size:11px; }
  .stat { display:flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); white-space:nowrap; user-select:none; transition:border-color .15s, opacity .15s; }
  .stat .stat-icon { font-size:12px; opacity:.85; }
  .stat .stat-label { color:var(--mute); }
  .stat .stat-val { color:var(--fg); font-weight:600; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .stat.is-stale .stat-val::after { content:' ↻'; color:var(--accent); font-size:9px; opacity:.7; }
  .stat.is-loading { opacity:.55; }
  .stat-cost { position:relative; }
  .stat-cost:hover { border-color:var(--accent); }
  .cost-multi { display:flex; align-items:baseline; gap:10px; }
  .cost-slot { display:flex; align-items:baseline; gap:4px; cursor:default; transition:opacity .15s; }
  .cost-slot:hover { opacity:.78; }
  .cost-slot .cost-label { color:var(--mute); font-size:10px; text-transform:lowercase; }
  .cost-slot .cost-val   { color:var(--fg); font-weight:600; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .stat-cost .cost-popover { display:none; position:absolute; top:calc(100% + 6px); right:0; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; box-shadow:0 4px 16px rgba(0,0,0,.4); z-index:11; min-width:220px; }
  .stat-cost:hover .cost-popover { display:block; }
  .cost-popover .cp-hd { color:var(--mute); font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding-bottom:4px; border-bottom:1px solid var(--line); margin-bottom:5px; }
  .cost-popover .cp-row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; font-size:11px; }
  .cost-popover .cp-model { color:var(--mute); font-family:ui-monospace,monospace; max-width:160px; overflow:hidden; text-overflow:ellipsis; }
  .cost-popover .cp-val { color:var(--fg); font-weight:600; font-family:ui-monospace,monospace; }
  .cost-popover .cp-total { border-top:1px solid var(--line); margin-top:5px; padding-top:6px; }
  .cost-popover .cp-empty { color:var(--mute); font-size:11px; padding:2px 0; }
  .stat-quota .quota-bar { width:54px; height:4px; background:var(--line); border-radius:2px; overflow:hidden; }
  .stat-quota .quota-fill { height:100%; background:var(--ok); transition:width .3s, background .3s; }
  .stat-quota .quota-fill.warn { background:var(--warn); }
  .stat-quota .quota-fill.bad  { background:var(--bad); }
  .stat-quota .src-tag { font-size:11px; padding:1px 5px; border-radius:3px; font-weight:600; letter-spacing:.2px; }
  .stat-quota .src-tag.computed { color:var(--warn); background:rgba(210,153,34,.14); }
  .stat-quota.unavailable { opacity:.55; }
  /* per-instance session cost mini-tag (T6 spec follow-up) */
  .instance-head .tag.cost { color:var(--mute); background:rgba(125,133,144,.12); font-weight:500; }
  .instance-head .tag.cost[hidden] { display:none; }

  /* per-card context bar (T6: H2) */
  .context-row { display:flex; align-items:center; gap:8px; margin:0 0 8px; font-size:10px; color:var(--mute); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .context-row[hidden] { display:none; }
  .context-row .ctx-bar { flex:0 0 auto; width:120px; height:4px; background:var(--line); border-radius:2px; overflow:hidden; }
  .context-row .ctx-fill { height:100%; background:var(--ok); transition:width .3s, background .3s; }
  .context-row .ctx-fill.warn { background:var(--warn); }
  .context-row .ctx-fill.hot  { background:#f0883e; }
  .context-row .ctx-fill.bad  { background:var(--bad); }
  .context-row .ctx-pct { font-weight:600; color:var(--fg); }
  .context-row .ctx-model { opacity:.7; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* kanban (T7: 3 columns Waiting / Working / Idle) */
  .kanban { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; align-items:start; }
  .kanban-col { border:1px solid var(--line); border-radius:10px; min-height:80px; overflow:hidden; }
  .kanban-col[data-col="waiting"] { border-color:rgba(248,81,73,.28); background:rgba(248,81,73,.04); }
  .kanban-col[data-col="working"] { border-color:rgba(210,153,34,.25); background:rgba(210,153,34,.04); }
  .kanban-col[data-col="idle"]    { border-color:var(--line); }
  .kanban-hd { padding:8px 12px; font-size:11px; color:var(--mute); font-weight:600; text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:6px; background:rgba(13,17,23,.4); }
  .kanban-hd .col-icon { font-size:13px; line-height:1; }
  .kanban-col[data-col="waiting"] .kanban-hd .col-icon { color:var(--bad); }
  .kanban-col[data-col="working"] .kanban-hd .col-icon { color:var(--warn); }
  .kanban-col[data-col="idle"]    .kanban-hd .col-icon { color:var(--mute); }
  .kanban-hd .col-count { margin-left:auto; font-size:10px; background:var(--card); padding:1px 7px; border-radius:10px; font-family:ui-monospace,monospace; color:var(--fg); }
  .kanban-body { padding:8px; display:flex; flex-direction:column; gap:8px; }
  .kanban-body > .group { margin-bottom:0; } /* override default 10px, gap handles spacing */
  .col-empty { padding:14px 8px; text-align:center; color:var(--mute); font-size:11px; opacity:.55; }
  @media (max-width:880px) {
    .kanban { grid-template-columns: 1fr; gap:10px; }
  }

  /* tag chips + filter (T8: H5) */
  .group-tags { display:inline-flex; align-items:center; gap:4px; flex-wrap:wrap; margin-left:4px; }
  .tag-chip { font-size:10px; color:var(--accent); background:rgba(88,166,255,.10); padding:1px 7px; border-radius:10px; cursor:pointer; user-select:none; transition:background .15s, color .15s; }
  .tag-chip::after { content:' ×'; opacity:.4; transition:opacity .15s; }
  .tag-chip:hover { background:rgba(248,81,73,.15); color:var(--bad); }
  .tag-chip:hover::after { opacity:1; }
  .tag-add { font-size:10px; color:var(--mute); background:transparent; border:1px dashed var(--line); padding:0 6px; height:18px; line-height:16px; border-radius:10px; cursor:pointer; font-family:inherit; transition:color .15s, border-color .15s, opacity .15s; opacity:0; }
  .group:hover .tag-add { opacity:1; }
  .tag-add:hover { color:var(--accent); border-color:var(--accent); }
  #tag-filter { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 9px; font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; min-width:160px; transition:border-color .15s; }
  #tag-filter:focus { outline:0; border-color:var(--accent); }
  #tag-filter::placeholder { color:var(--mute); }
  #btn-help { background:transparent; color:var(--mute); border:1px solid var(--line); padding:5px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; }
  #btn-help:hover { color:var(--accent); border-color:var(--accent); }
  #btn-wt { background:transparent; color:#8ddc94; border:1px solid var(--line); padding:5px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; font-family:ui-monospace,monospace; }
  #btn-wt:hover { border-color:#8ddc94; }
  #wt-list .wt-row { display:flex; gap:8px; align-items:center; padding:6px 4px; border-bottom:1px dotted var(--line); }
  #wt-list .wt-row:last-child { border-bottom:0; }
  #wt-list .wt-branch { color:#a5d6ff; font-weight:600; min-width:160px; }
  #wt-list .wt-path { color:var(--mute); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #wt-list .wt-status { font-size:10px; color:var(--mute); }
  #wt-list .wt-status.alive { color:var(--ok); }
  #wt-list .wt-status.dirty { color:var(--warn); }
  .group[data-filter-hidden] { display:none; }
  /* j/n flash highlight */
  @keyframes jumpFlash {
    0%, 100% { background:transparent; }
    20%, 60% { background:rgba(88,166,255,.18); }
  }
  .instance.flash { animation:jumpFlash 1.2s ease-out; }
  /* help dialog */
  #help-dlg { max-width:420px; }
  #help-dlg h2 { margin:0 0 12px; font-size:14px; }
  #help-dlg .kb-table { width:100%; border-collapse:collapse; font-size:12px; }
  #help-dlg .kb-table td { padding:5px 0; vertical-align:top; }
  #help-dlg .kb-table td:first-child { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); white-space:nowrap; padding-right:14px; min-width:90px; }
  #help-dlg .kb-row-hd td { color:var(--mute); font-size:10px; text-transform:uppercase; padding:10px 0 2px; border-bottom:1px solid var(--line); }
  @media (max-width:640px) {
    #tag-filter { min-width:0; flex:1 1 auto; max-width:140px; font-size:10px; padding:4px 7px; }
    #btn-help { padding:4px 8px; }
  }

  /* mobile narrow: shrink stats, hide labels, recenter popover.
     Cost block collapses to one slot + tap-cycle controlled by
     body[data-active-range="..."]; default is 'today'. */
  @media (max-width:640px) {
    .topbar-stats { gap:6px; font-size:10px; }
    .stat { padding:3px 7px; gap:4px; }
    .stat .stat-label { display:none; }
    .stat-cost .cost-popover { right:auto; left:50%; transform:translateX(-50%); min-width:200px; }
    .stat-quota .quota-bar { width:36px; }
    .context-row .ctx-bar { width:80px; }
    .context-row .ctx-model { max-width:90px; }
    /* show only the active cost slot; tap to cycle */
    .cost-multi { cursor:pointer; gap:0; }
    .cost-slot { display:none; }
    body[data-active-range="today"] .cost-slot[data-range="today"],
    body[data-active-range="week"]  .cost-slot[data-range="week"],
    body[data-active-range="month"] .cost-slot[data-range="month"],
    body:not([data-active-range]) .cost-slot[data-range="today"] { display:flex; }
  }

  /* sections */
  .content { max-width:960px; margin:0 auto; padding:16px 24px 32px; }
  .section-hd { display:flex; align-items:center; gap:8px; padding:12px 0 8px; font-size:12px; font-weight:600; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; }
  .section-hd .dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .section-hd .dot.green { background:var(--ok); }
  .section-hd .dot.gray  { background:var(--mute); opacity:.5; }

  /* cards */
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:8px; border-left:2px solid transparent; transition:border-color .15s, background .15s; }
  .card:hover { background:var(--card-hover); }
  .card.running { border-left-color:var(--ok); }
  .card.hub     { border-left-color:var(--accent); }
  .card.idle    { border-left-color:transparent; }

  /* groups (running side) — same-cwd instances share a header */
  .group { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:10px; overflow:hidden; }
  .group.is-hub { border-color:rgba(88,166,255,.25); }
  .group-head { display:grid; grid-template-columns: minmax(0,1fr) auto; grid-template-areas:"id actions" "path actions"; gap:2px 12px; padding:10px 14px; background:var(--card-hover); border-bottom:1px solid var(--line); }
  .group-id { grid-area:id; display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
  .group-id .group-name { font-weight:600; font-size:14px; }
  .group-id .name-sub { font-size:11px; color:var(--mute); font-weight:400; }
  .group-id .name-sub::before { content:'· '; opacity:.5; }
  .group-id .hub-tag { font-size:10px; color:var(--accent); background:rgba(88,166,255,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .group-id .alias-edit { background:transparent; border:0; color:var(--mute); cursor:pointer; font-size:12px; padding:0 2px; line-height:1; opacity:0; transition:opacity .15s; }
  .group:hover .alias-edit { opacity:.7; }
  .group:hover .alias-edit:hover { opacity:1; color:var(--accent); }
  .group-count { font-size:10px; color:var(--mute); background:var(--tag-bg); padding:1px 8px; border-radius:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .group-path { grid-area:path; color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .group-actions { grid-area:actions; display:flex; gap:6px; align-self:center; flex-shrink:0; }
  .group-body { padding:0; }
  .instance { padding:9px 14px; border-top:1px solid var(--line); border-left:2px solid transparent; transition:background .15s; position:relative; }
  .group-body > .instance:first-child { border-top:0; }
  .instance:hover { background:var(--card-hover); }
  .instance.running { border-left-color:var(--ok); }
  .instance.hub { border-left-color:var(--accent); }
  .instance-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:5px; }
  .instance-head .tag.port { color:var(--ok); background:rgba(63,185,80,.12); font-weight:600; }
  .instance-head .ext-tag { font-size:10px; color:var(--warn); background:rgba(210,153,34,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .instance-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:6px; }
  .card-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .card-head .name { font-weight:600; font-size:13px; }
  .card-head .hub-tag { font-size:10px; color:var(--accent); background:rgba(88,166,255,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .card-head .ext-tag { font-size:10px; color:var(--warn); background:rgba(210,153,34,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .card-head .name-sub { font-size:11px; color:var(--mute); font-weight:400; margin-left:2px; }
  .card-head .name-sub::before { content:'· '; opacity:.5; }
  .card-head .alias-edit { background:transparent; border:0; color:var(--mute); cursor:pointer; font-size:12px; padding:0 4px; line-height:1; opacity:0; transition:opacity .15s; }
  .card:hover .alias-edit { opacity:1; }
  .card-head .alias-edit:hover { color:var(--accent); }
  .tag { display:inline-block; font-size:11px; color:var(--mute); background:var(--tag-bg); padding:1px 7px; border-radius:3px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card-path { color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:6px; }
  .card-title { color:var(--fg); font-size:12px; line-height:1.4; margin:2px 0 6px; padding-left:8px; border-left:2px solid var(--accent); opacity:.85; max-height:34px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .card-title:empty { display:none; }
  .card-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
  .card-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }

  /* activity status */
  .activity-row { display:flex; align-items:center; gap:8px; margin:4px 0 8px; font-size:11px; min-height:18px; }
  .badge { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .badge.thinking      { color:#58a6ff; background:rgba(88,166,255,.12); }
  .badge.tool_running  { color:#d29922; background:rgba(210,153,34,.15); }
  .badge.waiting_ask   { color:#f85149; background:rgba(248,81,73,.15); animation:pulseAsk 1.5s ease-in-out infinite; }
  .badge.waiting_input { color:#a371f7; background:rgba(163,113,247,.15); }
  .badge.waiting_tool  { color:#e3b341; background:rgba(227,179,65,.15); }
  .badge.idle          { color:#3fb950; background:rgba(63,185,80,.10); }
  .badge.no_session    { color:var(--mute); background:var(--tag-bg); }
  .badge.error         { color:#f85149; background:rgba(248,81,73,.10); }
  @keyframes pulseAsk { 0%,100%{opacity:1} 50%{opacity:.55} }
  .preview { color:var(--mute); font-size:11px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .activity-toggle { background:transparent; border:0; color:var(--mute); cursor:pointer; font-size:11px; padding:0 4px; user-select:none; }
  .activity-toggle:hover { color:var(--accent); }
  .activity-drawer { display:none; margin:6px 0 8px; padding:8px 10px; background:#0d1117; border:1px solid var(--line); border-radius:6px; font-size:11px; }
  .activity-drawer.open { display:block; }
  .drawer-section { margin-bottom:8px; }
  .drawer-section:last-child { margin-bottom:0; }
  .drawer-h { font-size:10px; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
  .event-row { padding:4px 0; border-bottom:1px dotted var(--line); display:flex; gap:8px; align-items:flex-start; }
  .event-row:last-child { border-bottom:0; }
  .event-ts { color:var(--mute); font-size:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; flex-shrink:0; min-width:54px; }
  .event-body { flex:1; min-width:0; }
  .event-line { color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .event-line.user { color:#a5d6ff; }
  .event-line.tool { color:#d29922; }
  .event-line.assistant { color:var(--fg); opacity:.85; }
  .event-line.flag { color:#58a6ff; font-style:italic; }
  .ask-row { padding:4px 6px; background:rgba(248,81,73,.08); border-radius:4px; margin-bottom:3px; color:#f0a4a0; }
  .ask-row:last-child { margin-bottom:0; }

  /* buttons */
  .btn { display:inline-flex; align-items:center; gap:4px; background:transparent; color:var(--fg); border:1px solid var(--line); padding:4px 10px; border-radius:5px; cursor:pointer; font-size:11px; font-family:inherit; transition:all .15s; white-space:nowrap; }
  .btn:hover { border-color:var(--accent); color:var(--accent); }
  .btn.primary { background:var(--accent); color:#0d1117; border-color:var(--accent); font-weight:600; }
  .btn.primary:hover { opacity:.85; color:#0d1117; }
  .btn.danger:hover { border-color:var(--bad); color:var(--bad); }
  .btn svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }

  /* details / QR */
  details { margin-top:6px; }
  details summary { cursor:pointer; color:var(--mute); font-size:11px; padding:2px 0; user-select:none; }
  details[open] summary { color:var(--accent); }
  .url-row { color:var(--mute); font-size:11px; font-family:ui-monospace,monospace; word-break:break-all; padding:2px 0; }
  .url-row a { color:var(--mute); text-decoration:none; }
  .url-row a:hover { color:var(--accent); }
  .qr { padding:8px; background:#fff; border-radius:6px; display:inline-block; margin-top:6px; }
  .qr canvas { display:block; }

  /* card tabs panel (T11: M1 Run Summary + M3 Recent Edits + Errors) */
  .card-tabs { margin-top:6px; }
  .tab-strip { display:flex; gap:0; border-bottom:1px solid var(--line); margin-bottom:6px; flex-wrap:wrap; }
  .tab-btn { background:transparent; color:var(--mute); border:0; padding:5px 12px; font-size:11px; font-family:inherit; cursor:pointer; border-bottom:2px solid transparent; transition:color .15s, border-color .15s; }
  .tab-btn:hover { color:var(--fg); }
  .tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }
  .tab-btn .tab-count { display:inline-block; margin-left:4px; font-size:10px; opacity:.75; }
  .tab-btn.has-error { color:var(--bad); }
  .tab-btn.has-error.active { border-bottom-color:var(--bad); color:var(--bad); }
  .tab-panel { padding:6px 4px; max-height:280px; overflow-y:auto; font-size:11px; }
  .tab-panel[hidden] { display:none; }
  .tab-empty { color:var(--mute); padding:10px 8px; text-align:center; font-style:italic; opacity:.7; }
  .tab-loading { color:var(--mute); padding:10px 8px; text-align:center; opacity:.8; }
  .tab-error { color:var(--bad); padding:10px 8px; font-family:ui-monospace,monospace; font-size:10px; }
  /* Run Summary timeline */
  .run-totals { display:flex; flex-wrap:wrap; gap:6px; padding:0 0 8px; border-bottom:1px dotted var(--line); margin-bottom:8px; font-size:10px; color:var(--mute); }
  .run-totals .rt-chip { background:var(--card); padding:1px 8px; border-radius:10px; font-family:ui-monospace,monospace; }
  .run-totals .rt-chip.err { color:var(--bad); background:rgba(248,81,73,.10); }
  .run-event-row { display:flex; gap:8px; align-items:baseline; padding:3px 0; border-bottom:1px dotted var(--line); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; }
  .run-event-row:last-child { border-bottom:0; }
  .run-event-row .re-ts { color:var(--mute); min-width:60px; flex-shrink:0; }
  .run-event-row .re-icon { width:14px; text-align:center; flex-shrink:0; }
  .run-event-row.t-prompt          .re-icon { color:#a5d6ff; }
  .run-event-row.t-slash_command   .re-icon { color:var(--accent); }
  .run-event-row.t-auto_compact    .re-icon { color:var(--warn); }
  .run-event-row.t-tool_error      .re-icon { color:var(--bad); }
  .run-event-row.t-subagent        .re-icon { color:#bc8cff; }
  .run-event-row.t-hook_event      .re-icon { color:var(--mute); }
  .run-event-row .re-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  .run-event-row.t-tool_error .re-label { color:#f0a4a0; }
  /* Recent Edits */
  .edits-section { margin-bottom:10px; }
  .edits-section:last-child { margin-bottom:0; }
  .edits-section .es-hd { font-size:10px; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; margin-bottom:5px; }
  .edit-row { padding:5px 0; border-bottom:1px dotted var(--line); }
  .edit-row:last-child { border-bottom:0; }
  .edit-row .er-line1 { display:flex; gap:8px; align-items:baseline; font-family:ui-monospace,monospace; font-size:10px; }
  .edit-row .er-tool { color:var(--mute); min-width:60px; flex-shrink:0; }
  .edit-row .er-path { color:var(--fg); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .edit-row .er-meta { color:var(--mute); flex-shrink:0; font-size:10px; }
  .edit-row .er-preview { color:var(--mute); font-family:ui-monospace,monospace; font-size:10px; padding:3px 0 0 68px; opacity:.85; white-space:pre-wrap; word-break:break-all; max-height:64px; overflow:hidden; }
  .edit-row .er-preview:empty { display:none; }
  /* Errors clustering */
  .err-group { padding:6px 0; border-bottom:1px dotted var(--line); }
  .err-group:last-child { border-bottom:0; }
  .err-group .eg-hd { display:flex; gap:8px; align-items:baseline; font-family:ui-monospace,monospace; font-size:10px; cursor:pointer; user-select:none; }
  .err-group .eg-tool { color:var(--bad); font-weight:600; min-width:60px; flex-shrink:0; }
  .err-group .eg-pattern { flex:1; min-width:0; color:#f0a4a0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .err-group .eg-count { color:var(--mute); flex-shrink:0; }
  /* Git tab */
  .git-summary { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; padding:4px 0 8px; border-bottom:1px dotted var(--line); margin-bottom:6px; font-family:ui-monospace,monospace; font-size:11px; }
  .git-summary .g-branch { color:#a5d6ff; font-weight:600; }
  .git-summary .g-stat-add { color:var(--ok); }
  .git-summary .g-stat-del { color:var(--bad); }
  .git-summary .g-stat-files { color:var(--mute); }
  .git-summary .g-ahead { color:var(--warn); }
  .git-summary .g-ahead.g-muted { color:var(--mute); }
  .git-files { max-height:160px; overflow-y:auto; margin-bottom:8px; }
  .g-file { display:flex; gap:8px; align-items:baseline; font-family:ui-monospace,monospace; font-size:10px; padding:2px 0; border-bottom:1px dotted var(--line); }
  .g-file:last-child { border-bottom:0; }
  .g-file .g-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  .g-file.g-untracked .g-path { color:#8ddc94; }
  .g-file .g-tag-new { font-size:9px; color:var(--ok); background:rgba(63,185,80,.10); padding:0 5px; border-radius:8px; margin-left:4px; }
  .g-file .g-loc { color:var(--mute); flex-shrink:0; }
  .git-actions { display:flex; gap:6px; flex-wrap:wrap; padding-top:4px; border-top:1px dotted var(--line); }
  .git-actions .btn[disabled] { opacity:.4; cursor:not-allowed; }
  .instance-head .wt-tag { font-size:10px; color:#8ddc94; background:rgba(63,185,80,.10); padding:1px 6px; border-radius:3px; font-family:ui-monospace,monospace; }
  /* Memory tab */
  .mem-group { margin-bottom:10px; }
  .mem-group:last-child { margin-bottom:0; }
  .mg-hd { font-size:10px; color:var(--mute); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
  .mem-row { padding:0; border-bottom:1px dotted var(--line); }
  .mem-row:last-child { border-bottom:0; }
  .mem-row .mr-hd { display:flex; gap:8px; align-items:baseline; padding:5px 4px; cursor:pointer; font-family:ui-monospace,monospace; font-size:10px; }
  .mem-row .mr-hd:hover { background:rgba(88,166,255,.06); }
  .mem-row .mr-path { color:#a5d6ff; font-weight:600; min-width:90px; }
  .mem-row .mr-dir { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--mute); direction:rtl; text-align:left; }
  .mem-row .mr-meta { color:var(--mute); flex-shrink:0; }
  .mem-row .mr-body { padding:6px 4px; }
  .mem-row .mr-body textarea { width:100%; height:380px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:8px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.5; resize:vertical; box-sizing:border-box; }
  .mem-row .mr-body textarea:focus { outline:0; border-color:var(--accent); }
  .mem-row .mr-actions { display:flex; gap:6px; margin-top:6px; }
  .mem-row .mr-info { font-size:10px; color:var(--mute); padding-top:4px; }
  /* global Memory drawer */
  #mem-drawer { display:none; position:fixed; right:16px; top:54px; width:400px; max-width:90vw; max-height:70vh; overflow-y:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px; z-index:30; box-shadow:0 6px 24px rgba(0,0,0,.4); }
  #mem-drawer.open { display:block; }
  #mem-drawer .md-hd { display:flex; justify-content:space-between; align-items:center; padding-bottom:6px; border-bottom:1px solid var(--line); margin-bottom:8px; }
  #mem-drawer .md-title { font-size:12px; font-weight:600; }
  #mem-drawer .md-close { background:transparent; color:var(--mute); border:0; font-size:18px; cursor:pointer; }
  #mem-drawer .md-row { display:flex; gap:6px; padding:4px 0; border-bottom:1px dotted var(--line); font-family:ui-monospace,monospace; font-size:10px; }
  #mem-drawer .md-row:last-child { border-bottom:0; }
  #mem-drawer .md-scope { color:#a5d6ff; min-width:54px; font-weight:600; }
  #mem-drawer .md-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  #mem-drawer .md-pids { color:var(--mute); }
  #btn-mem { background:transparent; color:var(--mute); border:1px solid var(--line); padding:5px 10px; border-radius:6px; font-size:12px; cursor:pointer; }
  #btn-mem:hover { color:var(--accent); border-color:var(--accent); }
  .err-group .eg-samples { display:none; padding:4px 0 0 0; }
  .err-group.open .eg-samples { display:block; }
  .err-sample { font-family:ui-monospace,monospace; font-size:10px; color:var(--mute); padding:3px 0; white-space:pre-wrap; word-break:break-all; border-left:2px solid var(--line); padding-left:8px; margin:4px 0; }
  .err-sample .es-ts { color:#7d8590; font-size:9px; opacity:.7; display:block; margin-bottom:2px; }
  /* compactStatus card-level alert (no_inject_channel manual /compact hint) */
  .compact-alert { margin:0 0 8px; padding:6px 10px; background:rgba(248,81,73,.08); border:1px solid rgba(248,81,73,.35); border-left-width:3px; border-radius:6px; font-size:11px; color:#f0a4a0; line-height:1.4; display:flex; align-items:flex-start; gap:8px; }
  .compact-alert[hidden] { display:none; }
  .compact-alert .ca-icon { flex-shrink:0; color:var(--bad); font-weight:600; }
  .compact-alert .ca-cmd { font-family:ui-monospace,monospace; font-weight:600; color:#ffaba3; padding:1px 6px; background:rgba(248,81,73,.18); border-radius:3px; }
  /* Compact Threshold form */
  .th-form { display:flex; flex-direction:column; gap:8px; padding:4px 2px; font-size:11px; }
  .th-form .th-row { display:flex; align-items:center; gap:8px; }
  .th-form .th-row.col { flex-direction:column; align-items:flex-start; gap:3px; }
  .th-form input[type=number] { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:5px; padding:4px 7px; font-family:ui-monospace,monospace; font-size:11px; width:110px; }
  .th-form input[type=number]:focus { outline:0; border-color:var(--accent); }
  .th-form input[type=checkbox] { accent-color:var(--accent); }
  .th-form label { color:var(--fg); font-size:11px; cursor:pointer; }
  .th-form .th-help { color:var(--mute); font-size:10px; margin-left:6px; }
  .th-form .th-meta { padding:6px 8px; background:var(--bg); border:1px solid var(--line); border-radius:5px; font-size:10px; color:var(--mute); display:flex; flex-direction:column; gap:3px; font-family:ui-monospace,monospace; }
  .th-form .th-meta .th-warn { color:#f0a4a0; }
  .th-form .th-err { color:var(--bad); font-size:10px; flex:1; }
  .th-form .th-err[hidden] { display:none; }

  /* dialog */
  dialog { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:20px; max-width:500px; width:92%; }
  dialog::backdrop { background:rgba(0,0,0,.55); }
  dialog h2 { margin:0 0 12px; font-size:14px; font-weight:600; }
  dialog input { width:100%; padding:7px 10px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:5px; font-family:ui-monospace,monospace; font-size:12px; margin-bottom:8px; }
  dialog .row { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
  .tree { font-family:ui-monospace,monospace; font-size:12px; color:var(--mute); max-height:220px; overflow:auto; background:var(--bg); padding:6px; border-radius:5px; }
  .tree .row { padding:3px 6px; cursor:pointer; border-radius:3px; display:flex; gap:6px; align-items:center; }
  .tree .row:hover { background:var(--card); color:var(--fg); }
  .tree .row.dir::before { content:"📁"; font-size:12px; }
  .tree .row.up::before  { content:"↩"; }
  .err { color:var(--bad); font-size:12px; margin-top:6px; }
  .empty { color:var(--mute); text-align:center; padding:48px 20px; font-size:12px; }

  /* terminal overlay */
  #term-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:100; }
  #term-overlay.open { display:flex; flex-direction:column; }
  #term-bar { display:flex; align-items:center; gap:8px; padding:6px 14px; background:var(--card); border-bottom:1px solid var(--line); }
  #term-bar .type-tag { font-size:10px; font-weight:600; padding:2px 7px; border-radius:3px; }
  #term-bar .type-tag.shell   { color:var(--ok); background:rgba(63,185,80,.12); }
  #term-bar .type-tag.console { color:var(--accent); background:rgba(88,166,255,.12); }
  #term-bar .name { font-weight:600; font-size:12px; }
  #term-bar .path { color:var(--mute); font-size:11px; font-family:ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #term-bar .grow { flex:1; min-width:0; }
  #term-bar button { background:transparent; color:var(--mute); border:1px solid var(--line); padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px; }
  #term-bar button:hover { border-color:var(--bad); color:var(--bad); }
  #term-container { flex:1; overflow:hidden; }

  /* ccv inline overlay — embeds the ccv UI in an iframe so user can open/close
     a session without leaving the launcher tab */
  #ccv-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:100; }
  #ccv-overlay.open { display:flex; flex-direction:column; }
  #ccv-bar { display:flex; align-items:center; gap:8px; padding:6px 14px; background:var(--card); border-bottom:1px solid var(--line); }
  #ccv-bar .type-tag { font-size:10px; font-weight:600; padding:2px 7px; border-radius:3px; }
  #ccv-bar .type-tag.ccv-tag { color:var(--ok); background:rgba(63,185,80,.14); }
  #ccv-bar .name { font-weight:600; font-size:12px; }
  #ccv-bar .port { font-size:11px; color:var(--mute); font-family:ui-monospace,monospace; }
  #ccv-bar .path { color:var(--mute); font-size:11px; font-family:ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #ccv-bar .grow { flex:1; min-width:0; }
  #ccv-bar button { background:transparent; color:var(--mute); border:1px solid var(--line); padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px; font-family:inherit; }
  #ccv-bar button:hover { border-color:var(--accent); color:var(--accent); }
  #ccv-bar #ccv-close:hover { border-color:var(--bad); color:var(--bad); }
  #ccv-frame { flex:1; width:100%; border:0; background:#0d1117; }
  /* iframe state overlay — covers the frame area while loading or on failure.
     We can't peek inside cross-origin ccv to know when SPA finished rendering,
     so we treat iframe.onload as "good enough" + watchdog as failure signal. */
  #ccv-frame-status { display:none; position:absolute; left:0; right:0; bottom:0; top:42px; background:#0d1117; align-items:center; justify-content:center; flex-direction:column; gap:14px; color:var(--mute); font-size:13px; pointer-events:none; }
  #ccv-frame-status.show { display:flex; pointer-events:auto; }
  #ccv-frame-status .spinner { width:32px; height:32px; border:3px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:ccvSpin 0.9s linear infinite; }
  @keyframes ccvSpin { to { transform:rotate(360deg); } }
  #ccv-frame-status .err-title { color:var(--bad); font-weight:600; font-size:14px; }
  #ccv-frame-status .err-detail { font-size:11px; max-width:480px; text-align:center; line-height:1.5; }
  #ccv-frame-status .err-actions { display:flex; gap:8px; }
  #ccv-frame-status .err-actions button { background:transparent; color:var(--mute); border:1px solid var(--line); padding:5px 12px; border-radius:4px; cursor:pointer; font-size:11px; font-family:inherit; }
  #ccv-frame-status .err-actions button:hover { border-color:var(--accent); color:var(--accent); }

  /* local CC sessions section */
  .section-hd .dot.amber { background:var(--warn); }
  .local-cc-card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:8px; border-left:2px solid var(--warn); display:grid; grid-template-columns: minmax(0,1fr) auto; grid-template-areas:"id actions" "path actions" "meta actions"; gap:3px 12px; }
  .local-cc-card:hover { background:var(--card-hover); }
  .local-cc-id { grid-area:id; display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
  .local-cc-id .name { font-weight:600; font-size:13px; }
  .local-cc-id .session-tag { font-size:10px; color:var(--mute); background:var(--tag-bg); padding:1px 7px; border-radius:3px; font-family:ui-monospace,monospace; }
  .local-cc-id .bare-tag { font-size:10px; color:var(--warn); background:rgba(210,153,34,.12); padding:1px 6px; border-radius:3px; font-weight:600; }
  .local-cc-path { grid-area:path; color:var(--mute); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .local-cc-meta { grid-area:meta; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .local-cc-actions { grid-area:actions; display:flex; gap:6px; align-self:center; flex-shrink:0; }

  /* pair notification banner */
  .pair-banner { background:rgba(210,153,34,.1); border:1px solid var(--warn); border-radius:8px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pair-banner .pair-info { flex:1; min-width:200px; }
  .pair-banner .pair-code { font-family:ui-monospace,monospace; font-weight:700; font-size:15px; color:var(--warn); letter-spacing:2px; }
  .pair-banner .pair-device { color:var(--mute); font-size:11px; }
  .pair-banner .pair-actions { display:flex; gap:6px; }
  .pair-banner .pair-actions button { font-size:11px; padding:4px 12px; border-radius:5px; cursor:pointer; border:1px solid var(--line); background:transparent; color:var(--fg); }
  .pair-banner .pair-actions .approve { background:var(--ok); color:#0d1117; border-color:var(--ok); font-weight:600; }
  .pair-banner .pair-actions .reject:hover { border-color:var(--bad); color:var(--bad); }

  /* footer */
  footer { padding:10px 24px; border-top:1px solid var(--line); color:var(--mute); font-size:10px; text-align:center; opacity:.6; }
</style>
</head>
<body>
<header>
  <h1>ccv launcher</h1>
  <span class="meta" id="meta">loading…</span>
  <div class="topbar-stats" id="topbar-stats">
    <div class="stat stat-cost is-loading" id="stat-cost" title="cost summary (hover a number for breakdown; tap to cycle on narrow screens)">
      <span class="stat-icon">$</span>
      <div class="cost-multi" id="cost-multi">
        <span class="cost-slot" data-range="today"><span class="cost-label">today</span><span class="cost-val">—</span></span>
        <span class="cost-slot" data-range="week"><span class="cost-label">week</span><span class="cost-val">—</span></span>
        <span class="cost-slot" data-range="month"><span class="cost-label">month</span><span class="cost-val">—</span></span>
      </div>
      <div class="cost-popover" id="stat-cost-popover">
        <div class="cp-hd">By model · <span id="cp-range">today</span></div>
        <div id="cp-list"><div class="cp-empty">loading…</div></div>
      </div>
    </div>
    <div class="stat stat-quota is-loading" id="stat-quota" title="5h sliding window">
      <span class="stat-icon">⏱</span>
      <span class="stat-label">5h</span>
      <span class="stat-val" id="stat-quota-val">—</span>
      <div class="quota-bar"><div class="quota-fill" id="stat-quota-fill" style="width:0"></div></div>
      <span class="src-tag" id="stat-quota-src" hidden></span>
    </div>
  </div>
  <span class="grow"></span>
  <input type="text" id="tag-filter" placeholder="filter tags (/)" autocomplete="off" spellcheck="false">
  <button id="btn-wt" title="git worktrees (click to manage)" hidden>🌿 <span id="btn-wt-count">0</span></button>
  <button id="btn-mem" title="CLAUDE.md across all running instances (aggregated)">📖 Memory</button>
  <button id="btn-help" title="Keyboard shortcuts (?)">?</button>
  <button id="btn-new">+ New</button>
</header>
<div id="mem-drawer">
  <div class="md-hd">
    <span class="md-title">Memory (aggregated)</span>
    <button class="md-close" id="mem-drawer-close" title="close">×</button>
  </div>
  <div id="mem-drawer-body" style="font-size:11px;color:var(--mute)">loading…</div>
</div>
<div id="pair-zone" style="max-width:960px;margin:0 auto;padding:12px 24px 0"></div>
<div class="content" id="list"><div class="empty">loading…</div></div>
<footer>ccv-launcher</footer>

<div id="term-overlay">
  <div id="term-bar">
    <span class="type-tag" id="term-type"></span>
    <span class="name" id="term-name"></span>
    <span class="grow"><span class="path" id="term-path"></span></span>
    <button id="term-close">Close</button>
  </div>
  <div id="term-container"></div>
</div>

<div id="ccv-overlay">
  <div id="ccv-bar">
    <span class="type-tag ccv-tag">CCV</span>
    <span class="name" id="ccv-name"></span>
    <span class="port" id="ccv-port"></span>
    <span class="grow"><span class="path" id="ccv-path"></span></span>
    <button id="ccv-newtab" title="在新标签页打开">↗</button>
    <button id="ccv-reload" title="刷新">⟳</button>
    <button id="ccv-close" title="关闭 (Esc)">Close</button>
  </div>
  <iframe id="ccv-frame" src="about:blank" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  <div id="ccv-frame-status">
    <div data-state="loading" style="display:flex; flex-direction:column; align-items:center; gap:14px;">
      <div class="spinner"></div>
      <div>Loading ccv…</div>
    </div>
    <div data-state="error" style="display:none; flex-direction:column; align-items:center; gap:10px;">
      <div class="err-title">⚠ Failed to load ccv</div>
      <div class="err-detail" id="ccv-frame-err-detail">The ccv at this port did not respond. It may have just restarted or be in the middle of starting up.</div>
      <div class="err-actions">
        <button id="ccv-frame-retry">Retry</button>
        <button id="ccv-frame-newtab">Open in new tab</button>
      </div>
    </div>
  </div>
</div>

<dialog id="dlg">
  <h2>Launch new instance</h2>
  <div style="color:var(--mute);font-size:11px;margin-bottom:4px">Directory:</div>
  <input id="cwd" placeholder="/path/to/project">
  <div class="tree" id="tree"></div>
  <div style="color:var(--mute);font-size:11px;margin:8px 0 4px">ccuse profile (claude 后端):</div>
  <select id="ccuse-select" style="width:100%;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px;font-size:12px">
    <option value="">— 不切 (用 launcher 默认) —</option>
  </select>
  <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--fg);cursor:pointer">
    <input type="checkbox" id="use-worktree">
    <span>新建 git worktree (隔离分支，避免多实例同 cwd 互踩)</span>
  </label>
  <div class="err" id="err" hidden></div>
  <div class="row">
    <button class="btn" id="btn-cancel">Cancel</button>
    <button class="btn primary" id="btn-launch">Launch</button>
  </div>
</dialog>

<dialog id="wt-dlg" style="max-width:760px;width:90%">
  <h2>Worktrees</h2>
  <div id="wt-list" style="max-height:50vh;overflow-y:auto;border:1px solid var(--line);border-radius:6px;padding:8px;font-family:ui-monospace,monospace;font-size:11px">loading…</div>
  <div class="row" style="margin-top:10px;justify-content:space-between">
    <div style="display:flex;gap:8px;align-items:center">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute);cursor:pointer">
        <input type="checkbox" id="wt-force"> force (clobber uncommitted / unpushed)
      </label>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn" id="wt-close">Close</button>
      <button class="btn danger" id="wt-cleanup">Clean selected</button>
    </div>
  </div>
</dialog>

<dialog id="restart-dlg" style="max-width:420px;width:90%">
  <h2 style="font-size:14px;margin-bottom:4px">Restart with ccuse profile</h2>
  <div id="restart-target" style="color:var(--mute);font-size:11px;margin-bottom:10px;font-family:ui-monospace,monospace;word-break:break-all"></div>
  <div id="restart-profiles" style="display:flex;flex-direction:column;gap:6px"></div>
  <div class="err" id="restart-err" hidden></div>
  <div class="row" style="margin-top:14px">
    <button class="btn" id="restart-cancel">Cancel</button>
  </div>
</dialog>

<dialog id="help-dlg">
  <h2>Keyboard shortcuts</h2>
  <table class="kb-table">
    <tr class="kb-row-hd"><td colspan="2">Navigation</td></tr>
    <tr><td>j  /  n</td><td>jump to next <strong>waiting</strong> instance (ask &gt; tool &gt; input)</td></tr>
    <tr><td>/</td><td>focus tag filter</td></tr>
    <tr><td>?</td><td>show this help</td></tr>
    <tr><td>Esc</td><td>close dialog / overlay</td></tr>
    <tr class="kb-row-hd"><td colspan="2">Filter syntax</td></tr>
    <tr><td>tok1 tok2</td><td>AND match — all tokens must match a tag (case-insensitive substring)</td></tr>
  </table>
  <div class="row" style="margin-top:14px">
    <button class="btn" id="help-close">Close</button>
  </div>
</dialog>

<script>
(() => {
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  // Launcher API + /api/browse-dir are served by the multiplexer below the
  // ccv token gate; only attach ?token= when present so direct LAN access
  // (no token in URL) and public access (NPM Basic Auth in front) both work.
  const withMaybeToken = (path) =>
    TOKEN ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : path;
  const api = async (path, init) => {
    const res = await fetch(withMaybeToken(path), init);
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text().catch(() => ''));
    return res.json();
  };

  const dlg = document.getElementById('dlg');
  const listEl = document.getElementById('list');
  const metaEl = document.getElementById('meta');
  const cwdInput = document.getElementById('cwd');
  const treeEl = document.getElementById('tree');
  const errEl = document.getElementById('err');

  function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtAge(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return '';
    const m = Math.floor(ms/60000); const h = Math.floor(m/60);
    if (h >= 24) return Math.floor(h/24) + 'd';
    if (h > 0) return h + 'h ' + (m%60) + 'm';
    if (m > 0) return m + 'm';
    return Math.floor(ms/1000) + 's';
  }

  function renderInstance(it) {
    const cls = it.isHub ? 'instance hub' : 'instance running';
    const name = escape(it.displayName || it.projectName || '?');
    const path = escape(it.cwd || '');
    const pub = escape(it.publicUrl || '');
    const lan = escape(it.lanUrl || '');
    const openHref = pub || lan || '#';
    let actions = ''
      + '<button class="btn primary" data-act="open" data-href="'+escape(openHref)+'" data-port="'+(it.port||'')+'" data-name="'+name+'" data-path="'+path+'">Open</button>'
      + '<button class="btn" data-act="open-newtab" data-href="'+escape(openHref)+'" data-port="'+(it.port||'')+'" title="在新标签页打开">↗</button>'
      + '<button class="btn" data-act="copy" data-text="'+(pub||lan)+'">Copy</button>';
    if (!it.isHub) {
      actions += '<button class="btn" data-act="console" data-port="'+(it.port||'')+'" data-token="'+(it.token||'')+'" data-name="'+name+'" data-path="'+path+'" data-pub="'+(it.publicUrl||'')+'" data-lan="'+(it.lanUrl||'')+'">Console</button>';
      actions += '<button class="btn" data-act="restart" data-pid="'+it.pid+'" data-cwd="'+path+'" data-name="'+name+'" data-current="'+escape(it.ccuseProfile || '')+'" title="重启换 ccuse profile (当前: '+escape(it.ccuseProfile || '默认')+')">↻ ccuse</button>';
      actions += '<button class="btn danger" data-act="stop" data-pid="'+it.pid+'" data-name="'+name+'">Stop</button>';
    }
    return ''
      + '<div class="'+cls+'" data-pid="'+it.pid+'">'
      +   '<div class="instance-head">'
      +     '<span class="tag port">:'+(it.port||'?')+'</span>'
      +     '<span class="tag">pid '+it.pid+'</span>'
      +     '<span class="tag">up '+fmtAge(it.startedAt)+'</span>'
      +     (it.version ? '<span class="tag">'+escape(it.version)+'</span>' : '')
      +     (it.external ? '<span class="ext-tag" title="外部发现 — 此 ccv 在 launcher 插件加载前就已经启动，没自动注册到 runtime/，由 launcher 通过 lsof + /api/version-info 反向发现并接管">外部</span>' : '')
      +     (it.worktree ? '<span class="wt-tag" title="git worktree: ' + escape(it.worktree.path || '') + ' (base ' + escape(it.worktree.baseRef || '') + ')">🌿 ' + escape(it.worktree.branch || '') + '</span>' : '')
      +     (it.isHub ? '' : '<span class="tag cost" data-cost-for="' + it.pid + '" hidden></span>')
      +   '</div>'
      +   '<div class="card-title" data-title-for="' + it.pid + '"></div>'
      +   '<div class="activity-row" data-act-row="' + it.pid + '">'
      +     '<span class="badge no_session">⚫ probing…</span>'
      +     '<span class="preview"></span>'
      +     (it.isHub ? '' : '<button class="activity-toggle" data-act="actdrawer" data-pid="' + it.pid + '" title="show recent activity">▾</button>')
      +   '</div>'
      +   (it.isHub ? '' : '<div class="context-row" data-ctx-for="' + it.pid + '" hidden></div>')
      +   (it.isHub ? '' : '<div class="compact-alert" data-compact-for="' + it.pid + '" hidden></div>')
      +   (it.isHub ? '' : '<div class="activity-drawer" data-act-drawer="' + it.pid + '"></div>')
      +   (it.isHub
            ? '<details><summary>URLs &middot; QR</summary>'
              + (lan ? '<div class="url-row">LAN: <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>' : '')
              + (pub ? '<div class="url-row">Public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>' : '')
              + (pub ? '<div class="qr" data-qr="'+pub+'"></div>' : '')
              + '</details>'
            : '<details><summary>Details &middot; URLs &middot; Summary &middot; Edits &middot; Errors &middot; Memory' + (it.worktree ? ' &middot; Git' : '') + '</summary>'
              + '<div class="card-tabs" data-tabs-for="' + it.pid + '">'
              +   '<div class="tab-strip" role="tablist">'
              +     '<button class="tab-btn active" data-tab-btn="urls"    data-pid="' + it.pid + '">URLs &middot; QR</button>'
              +     '<button class="tab-btn"        data-tab-btn="summary" data-pid="' + it.pid + '">Summary</button>'
              +     '<button class="tab-btn"        data-tab-btn="edits"   data-pid="' + it.pid + '">Edits</button>'
              +     '<button class="tab-btn"        data-tab-btn="errors"  data-pid="' + it.pid + '">Errors</button>'
              +     '<button class="tab-btn"        data-tab-btn="threshold" data-pid="' + it.pid + '" data-cwd="' + escape(it.cwd || '') + '">Threshold</button>'
              +     '<button class="tab-btn"        data-tab-btn="memory"  data-pid="' + it.pid + '">Memory</button>'
              +     (it.worktree ? '<button class="tab-btn" data-tab-btn="git" data-pid="' + it.pid + '">Git</button>' : '')
              +   '</div>'
              +   '<div class="tab-panel" data-tab-panel="urls" data-pid="' + it.pid + '">'
              +     (lan ? '<div class="url-row">LAN: <a href="#" data-act="copy" data-text="'+lan+'">'+lan+'</a></div>' : '')
              +     (pub ? '<div class="url-row">Public: <a href="#" data-act="copy" data-text="'+pub+'">'+pub+'</a></div>' : '')
              +     (pub ? '<div class="qr" data-qr="'+pub+'"></div>' : '')
              +     (!lan && !pub ? '<div class="tab-empty">no URLs</div>' : '')
              +   '</div>'
              +   '<div class="tab-panel" data-tab-panel="summary" data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="edits"   data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="errors"  data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="threshold" data-pid="' + it.pid + '" data-cwd="' + escape(it.cwd || '') + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   '<div class="tab-panel" data-tab-panel="memory" data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>'
              +   (it.worktree ? '<div class="tab-panel" data-tab-panel="git" data-pid="' + it.pid + '" hidden><div class="tab-empty">click to load…</div></div>' : '')
              + '</div>'
              + '</details>')
      +   '<div class="instance-actions">' + actions + '</div>'
      + '</div>';
  }

  function renderGroup(g) {
    const first = g.list[0];
    const path = escape(g.cwd || '');
    const projName = escape(first.displayName || first.projectName || '?');
    const aliasRaw = first.alias || '';
    const aliasEsc = aliasRaw ? escape(aliasRaw) : '';
    const showName = aliasEsc || projName;
    const subName = aliasEsc ? '<span class="name-sub" title="real project name">' + projName + '</span>' : '';
    const aliasBtn = g.hasHub ? '' : '<button class="alias-edit" data-act="alias" data-cwd="'+escape(g.cwd||'')+'" data-current="'+aliasEsc+'" title="编辑别名 (Launcher 自己的别名,跟 ccv 内置别名不同步)">✎</button>';
    const groupActions = g.hasHub ? '' :
        '<button class="btn" data-act="newhere" data-cwd="'+path+'" data-name="'+projName+'" title="Spawn another ccv at the same directory">+ New</button>'
      + '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+projName+'">Shell</button>';
    const count = g.list.length;
    const countTag = count > 1 ? '<span class="group-count">× ' + count + '</span>' : '';
    // Tag chips (T8): editable per-cwd labels, skipped for the hub group
    // (cwd-less, can't be tagged meaningfully). Each chip click removes the
    // tag; "+ tag" button (visible on group hover) prompts for a new one.
    const tagsHtml = (() => {
      if (g.hasHub) return '';
      const cwd = g.cwd || '';
      const cwdEsc = escape(cwd);
      const tags = (_tagsByCwd[cwd] || []).slice().sort();
      const chips = tags.map(t =>
        '<span class="tag-chip" data-act="tag-rm" data-cwd="' + cwdEsc + '" data-tag="' + escape(t) + '" title="点击删除标签">' + escape(t) + '</span>'
      ).join('');
      return '<span class="group-tags">' + chips + '<button class="tag-add" data-act="tag-add" data-cwd="' + cwdEsc + '" title="add tag">+</button></span>';
    })();
    const body = g.list.map(renderInstance).join('');
    return ''
      + '<div class="group' + (g.hasHub ? ' is-hub' : '') + '" data-group-cwd="' + escape(g.cwd || '') + '">'
      +   '<div class="group-head">'
      +     '<div class="group-id">'
      +       '<span class="group-name">' + showName + '</span>'
      +       subName
      +       aliasBtn
      +       countTag
      +       (g.hasHub ? '<span class="hub-tag">HUB</span>' : '')
      +       tagsHtml
      +     '</div>'
      +     '<div class="group-path" title="'+path+'">'+path+'</div>'
      +     (groupActions ? '<div class="group-actions">' + groupActions + '</div>' : '')
      +   '</div>'
      +   '<div class="group-body">' + body + '</div>'
      + '</div>';
  }

  // ---- T7: status iconography + Kanban column mapping ----
  // backend deriveStatus returns one of these enum values; UI is the canonical
  // place to map them to single-char icons + short labels (the longer
  // statusLabel from backend stays available as a tooltip via title=).
  const STATUS_VIEW = {
    thinking:      { icon: '⏳', short: 'thinking' },
    tool_running:  { icon: '●',  short: 'working'  },
    waiting_ask:   { icon: '◐',  short: 'waiting'  },
    waiting_input: { icon: '⌨',  short: 'await msg'},
    waiting_tool:  { icon: '⏸',  short: 'tool wait'},
    idle:          { icon: '○',  short: 'idle'     },
    no_session:    { icon: '○',  short: 'no log'   },
    error:         { icon: '⚠',  short: 'error'    },
  };
  function colForStatus(s) {
    if (s === 'waiting_ask' || s === 'waiting_input' || s === 'waiting_tool') return 'waiting';
    if (s === 'thinking' || s === 'tool_running') return 'working';
    return 'idle'; // idle / no_session / error
  }
  // Pick the most-attention column among instances in a group. waiting > working > idle.
  function colForGroup(g) {
    let best = 'idle';
    for (const it of g.list) {
      const s = _statusByPid.get(it.pid) || 'no_session';
      const col = colForStatus(s);
      if (col === 'waiting') return 'waiting';
      if (col === 'working') best = 'working';
    }
    return best;
  }
  const _statusByPid = new Map();
  let _lastListData = { items: [], history: [], localCc: [] };
  let _lastColByCwd = new Map();
  // T8: tag state — populated by loadPrefs() on initial load and after every
  // tag mutation. Render reads these to paint chips; applyTagFilter() uses
  // them to decide which groups to hide.
  let _tagsByCwd = {};
  let _allTags = [];
  let _filterText = '';
  let _jumpIdx = -1;

  function render(items, history, localCc) {
    _lastListData = { items, history: history || [], localCc: localCc || [] };
    const total = items.length + (history || []).length + ((localCc || []).length);
    metaEl.textContent = items.length + ' running'
      + (localCc && localCc.length ? ' · ' + localCc.length + ' local' : '')
      + (history && history.length ? ' · ' + history.length + ' recent' : '');
    if (!total) {
      listEl.innerHTML = '<div class="empty">No instances yet. Click "+ New" to launch one.</div>';
      _lastColByCwd = new Map();
      return;
    }
    // Group running instances by cwd. Same cwd → one rounded container with a
    // shared header (alias / projectName / path / cwd-level actions) and a list
    // of compact instance rows underneath. Cuts down on repeated path/name
    // chrome when you have multiple ccvs in the same project.
    const groupMap = new Map();
    for (const it of items) {
      const key = it.cwd || '';
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(it);
    }
    const groups = [];
    for (const [cwd, list] of groupMap) {
      list.sort((a,b) => (b.isHub?1:0) - (a.isHub?1:0) || (a.port||0) - (b.port||0));
      const minPort = Math.min(...list.map(x => x.port || 99999));
      const hasHub = list.some(x => x.isHub);
      groups.push({ cwd, list, minPort, hasHub });
    }
    groups.sort((a,b) => (b.hasHub?1:0) - (a.hasHub?1:0) || a.minPort - b.minPort);

    // Bin groups into Kanban columns. Same cwd group is kept together (per
    // team-lead constraint) and goes to the column matching its highest-
    // priority instance status (waiting > working > idle).
    const cols = { waiting: [], working: [], idle: [] };
    const newColByCwd = new Map();
    for (const g of groups) {
      const col = colForGroup(g);
      cols[col].push(g);
      newColByCwd.set(g.cwd, col);
    }
    _lastColByCwd = newColByCwd;
    const colMeta = [
      { id: 'waiting', icon: '◐', label: 'Waiting' },
      { id: 'working', icon: '●', label: 'Working' },
      { id: 'idle',    icon: '○', label: 'Idle' },
    ];

    let html = '';
    if (items.length) {
      html += '<div class="kanban">';
      for (const cm of colMeta) {
        const colGroups = cols[cm.id];
        html += '<div class="kanban-col" data-col="' + cm.id + '">';
        html +=   '<div class="kanban-hd"><span class="col-icon">' + cm.icon + '</span> ' + cm.label + ' <span class="col-count">' + colGroups.length + '</span></div>';
        html +=   '<div class="kanban-body" data-col-body="' + cm.id + '">';
        if (!colGroups.length) {
          html += '<div class="col-empty">—</div>';
        } else {
          html += colGroups.map(renderGroup).join('');
        }
        html +=   '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Local CC sessions — bare claude processes the user started in a terminal,
    // not yet under any ccv. Offer a one-click "Takeover" that kills the bare
    // process and relaunches ccv -r <session-id> so the next prompt is recorded.
    if (localCc && localCc.length) {
      html += '<div class="section-hd" style="margin-top:16px"><span class="dot amber"></span>Local CC sessions (' + localCc.length + ') <span style="text-transform:none;font-weight:400;letter-spacing:0;color:var(--mute);margin-left:6px">— 本地裸跑的 claude,未被 ccv 接管</span></div>';
      html += localCc.map(s => {
        const cwd = s.cwd || '';
        const name = escape(cwd ? cwd.split('/').pop() || cwd : '?');
        const path = escape(cwd);
        const sidShort = (s.sessionId || '').slice(0, 8);
        const lastAgo = s.lastEntryAt ? fmtAge(s.lastEntryAt) + ' ago' : '';
        const upAge = s.startedAt ? fmtAge(s.startedAt) : '';
        return ''
          + '<div class="local-cc-card" data-pid="'+s.pid+'">'
          +   '<div class="local-cc-id">'
          +     '<span class="name">'+name+'</span>'
          +     '<span class="bare-tag" title="本地裸跑,未被 ccv 接管">未接管</span>'
          +     (sidShort ? '<span class="session-tag" title="session id '+escape(s.sessionId||'')+'">'+sidShort+'</span>' : '')
          +   '</div>'
          +   '<div class="local-cc-path" title="'+path+'">'+path+'</div>'
          +   '<div class="local-cc-meta">'
          +     '<span class="tag">pid '+s.pid+'</span>'
          +     (upAge ? '<span class="tag">up '+upAge+'</span>' : '')
          +     (lastAgo ? '<span class="tag">last msg '+lastAgo+'</span>' : '')
          +   '</div>'
          +   '<div class="local-cc-actions">'
          +     '<button class="btn primary" data-act="takeover" data-pid="'+s.pid+'" data-session="'+escape(s.sessionId||'')+'" data-cwd="'+path+'" data-name="'+name+'" title="终止本地 claude → 在新 Terminal 里启动 ccv -r 接上 session">接管 ▶</button>'
          +     '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+name+'">Shell</button>'
          +   '</div>'
          + '</div>';
      }).join('');
    }

    if (history && history.length) {
      history.sort((a,b) => new Date(b.lastUsed) - new Date(a.lastUsed));
      html += '<div class="section-hd" style="margin-top:16px"><span class="dot gray"></span>Recent (' + history.length + ')</div>';
      html += history.map(h => {
        const name = escape(h.projectName || '?');
        const path = escape(h.cwd || '');
        const ago = h.lastUsed ? fmtAge(h.lastUsed) + ' ago' : '';
        const logs = h.logCount ? h.logCount + ' logs' : '';
        return ''
          + '<div class="card idle">'
          +   '<div class="card-head"><span class="name">'+name+'</span></div>'
          +   '<div class="card-path" title="'+path+'">'+path+'</div>'
          +   '<div class="card-meta">'
          +     (ago ? '<span class="tag">' + ago + '</span>' : '')
          +     (logs ? '<span class="tag">' + logs + '</span>' : '')
          +   '</div>'
          +   '<div class="card-actions">'
          +     '<button class="btn primary" data-act="launch" data-cwd="'+path+'">Launch</button>'
          +     '<button class="btn" data-act="openterm" data-cwd="'+path+'" data-name="'+name+'">Shell</button>'
          +     '<button class="btn danger" data-act="forget" data-wsid="'+(h.wsId||'')+'">Forget</button>'
          +   '</div>'
          + '</div>';
      }).join('');
    }
    // Preserve open details state across re-renders
    const openPids = new Set();
    listEl.querySelectorAll('details[open]').forEach(d => {
      const card = d.closest('[data-pid]');
      if (card) openPids.add(card.dataset.pid);
    });
    listEl.innerHTML = html;
    // Restore open state and render QR for previously open details
    if (openPids.size) {
      listEl.querySelectorAll('[data-pid]').forEach(card => {
        if (!openPids.has(card.dataset.pid)) return;
        const d = card.querySelector('details');
        if (!d) return;
        d.open = true;
        d.querySelectorAll('.qr[data-qr]').forEach(el => {
          if (el.dataset.qrDone) return;
          try { new QRCode(el, { text: el.dataset.qr, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' }); el.dataset.qrDone = '1'; } catch(e) {}
        });
      });
    }
    // Re-apply current tag filter against the new DOM (T8)
    applyTagFilter();
    // Re-apply per-pid tab state + re-render cached tab content (T11)
    rehydrateTabs();
  }

  // Render QR codes when <summary> is clicked (toggle event doesn't bubble, so use click on summary)
  listEl.addEventListener('click', (ev) => {
    const summary = ev.target.closest('summary');
    if (!summary) return;
    const details = summary.parentElement;
    // details.open is still the OLD state at click time; after click it flips.
    // So if it's currently closed, it's about to open.
    if (details.open) return; // closing
    requestAnimationFrame(() => {
      details.querySelectorAll('.qr[data-qr]').forEach(el => {
        if (el.dataset.qrDone) return;
        try { new QRCode(el, { text: el.dataset.qr, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' }); el.dataset.qrDone = '1'; } catch(e) {}
      });
    });
  });

  listEl.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    ev.preventDefault();
    const act = t.dataset.act;
    if (act === 'open') {
      openCcvInline(t.dataset.href, t.dataset.name || ('ccv :' + (t.dataset.port||'')), t.dataset.port || '', t.dataset.path || '');
    } else if (act === 'open-newtab') {
      // Reuse the per-instance tab on repeat clicks: a stable window name
      // (keyed by port) makes browsers focus the existing tab instead of
      // spawning a fresh one that has to reload from scratch.
      const winName = t.dataset.port ? 'ccv-' + t.dataset.port : '_blank';
      const w = window.open(t.dataset.href, winName);
      if (w) { try { w.focus(); } catch {} }
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(t.dataset.text || t.textContent); t.style.color='var(--ok)'; setTimeout(()=>t.style.color='', 800); } catch {}
    } else if (act === 'stop') {
      if (!confirm('Stop ccv "'+t.dataset.name+'" (pid '+t.dataset.pid+')?')) return;
      try { await api('/api/launcher/kill', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pid: parseInt(t.dataset.pid,10) }) }); refresh(); }
      catch (e) { alert('Stop failed: ' + e.message); }
    } else if (act === 'restart') {
      openRestartDlg({
        pid: parseInt(t.dataset.pid, 10),
        cwd: t.dataset.cwd,
        name: t.dataset.name,
        current: t.dataset.current || '',
      });
    } else if (act === 'launch') {
      try { await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd: t.dataset.cwd }) }); refresh(); }
      catch (e) { alert('Launch failed: ' + e.message); }
    } else if (act === 'alias') {
      const cwd = t.dataset.cwd;
      const current = t.dataset.current || '';
      const next = window.prompt('设置别名（≤32 字符，留空清除；只在 launcher 内部生效，跟 ccv 自己的别名不同步）', current);
      if (next === null) return; // cancel
      try {
        await api('/api/launcher/prefs/alias', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, alias: next.trim() }) });
        refresh();
      } catch (e) { alert('保存别名失败: ' + e.message); }
    } else if (act === 'newhere') {
      const prev = t.textContent;
      t.disabled = true; t.textContent = 'Launching…';
      try {
        await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd: t.dataset.cwd, force: true }) });
        refresh();
      } catch (e) { alert('Launch failed: ' + e.message); }
      finally { t.disabled = false; t.textContent = prev; }
    } else if (act === 'forget') {
      if (!confirm('Remove this project from history?')) return;
      try { await api('/api/launcher/forget', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ wsId: t.dataset.wsid }) }); refresh(); }
      catch (e) { alert('Forget failed: ' + e.message); }
    } else if (act === 'console') {
      openConsole(t.dataset.port, t.dataset.token, t.dataset.name, t.dataset.path, t.dataset.pub, t.dataset.lan);
    } else if (act === 'openterm') {
      openShell(t.dataset.cwd, t.dataset.name || t.dataset.cwd);
    } else if (act === 'takeover') {
      const pid = parseInt(t.dataset.pid, 10);
      const sessionId = t.dataset.session;
      const cwd = t.dataset.cwd;
      const name = t.dataset.name || cwd;
      if (!confirm('接管本地 cc session?\\n\\n会做这些事:\\n  1. SIGTERM kill pid ' + pid + '（你那个 terminal 里的 claude 会退出）\\n  2. 打开新的 Terminal 窗口在 ' + name + '\\n  3. 跑 ccv -r ' + (sessionId||'').slice(0,8) + '… 接上原 session\\n\\n确定继续?')) return;
      const prev = t.textContent;
      t.disabled = true; t.textContent = '接管中…';
      try {
        await api('/api/launcher/takeover-cc-session', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pid, sessionId, cwd }) });
        // Give Terminal.app + ccv a beat to register before refreshing
        setTimeout(refresh, 1500);
      } catch (e) {
        alert('接管失败: ' + e.message);
        t.disabled = false; t.textContent = prev;
      }
    } else if (act === 'tag-add') {
      const cwd = t.dataset.cwd || '';
      if (!cwd) return;
      const existing = (_tagsByCwd[cwd] || []).slice();
      const hint = _allTags.length ? ' (常用: ' + _allTags.slice(0, 8).join(', ') + ')' : '';
      const next = window.prompt('添加标签 (≤24 字符，可用 key:value 形式如 env:prod)' + hint, '');
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed) return;
      if (existing.includes(trimmed)) return;
      try {
        const data = await api('/api/launcher/prefs/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, tags: existing.concat(trimmed) }) });
        _tagsByCwd[cwd] = data.tags || [];
        if (Array.isArray(data.allTags)) _allTags = data.allTags;
        if (_lastListData.items.length) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
      } catch (e) { alert('添加标签失败: ' + e.message); }
    } else if (act === 'tag-rm') {
      const cwd = t.dataset.cwd || '';
      const tag = t.dataset.tag || '';
      if (!cwd || !tag) return;
      const existing = (_tagsByCwd[cwd] || []).filter(x => x !== tag);
      try {
        const data = await api('/api/launcher/prefs/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, tags: existing }) });
        _tagsByCwd[cwd] = data.tags || [];
        if (Array.isArray(data.allTags)) _allTags = data.allTags;
        if (_lastListData.items.length) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
      } catch (e) { alert('删除标签失败: ' + e.message); }
    }
  });

  // ---- M2: Git tab actions (commit / push / open PR) ----
  // Three buttons inside the Git tab — each opens a tiny inline dialog (no
  // <dialog> markup; prompt() / textarea modal is enough for now). Refresh
  // the tab after each successful op so the file list / ahead counter update.
  function reloadGitTab(pid) {
    const st = _tabState.get(pid); if (st) st.cache.git = null;
    loadTabData(pid, 'git');
  }
  async function gitCommitFlow(pid) {
    const container = document.querySelector('[data-tabs-for="' + pid + '"]');
    const aliasOrName = (container && container.closest('.group')) ? (container.closest('.group').querySelector('.group-name')?.textContent || '') : '';
    const template = aliasOrName ? aliasOrName + ': ' : '';
    const message = window.prompt('Commit message (worktree branch):', template);
    if (message == null) return;
    if (!message.trim()) { alert('Commit message required'); return; }
    try {
      const r = await api('/api/launcher/instances/' + pid + '/git-commit', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ message }),
      });
      if (r.nothingToCommit) { alert('Nothing to commit (working tree clean)'); }
      else { alert('Committed ' + (r.sha || '').slice(0,8)); }
      reloadGitTab(pid);
    } catch (e) { alert('Commit failed: ' + e.message); }
  }
  async function gitPushFlow(pid) {
    if (!confirm('Push worktree branch to origin (--force-with-lease only when retrying)?')) return;
    try {
      const r = await api('/api/launcher/instances/' + pid + '/git-push', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ force: false }),
      });
      alert('Pushed:\\n' + (r.output || '').slice(0, 1200));
      reloadGitTab(pid);
    } catch (e) {
      if (/non-fast-forward|rejected/i.test(e.message) && confirm('Push rejected (non-fast-forward). Retry with --force-with-lease?')) {
        try {
          const r2 = await api('/api/launcher/instances/' + pid + '/git-push', {
            method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ force: true }),
          });
          alert('Force-pushed:\\n' + (r2.output || '').slice(0, 1200));
          reloadGitTab(pid);
        } catch (e2) { alert('Force push failed: ' + e2.message); }
      } else {
        alert('Push failed: ' + e.message);
      }
    }
  }
  async function gitOpenPrFlow(pid) {
    const container = document.querySelector('[data-tabs-for="' + pid + '"]');
    const aliasOrName = (container && container.closest('.group')) ? (container.closest('.group').querySelector('.group-name')?.textContent || '') : '';
    const title = window.prompt('PR title:', aliasOrName ? aliasOrName + ': ' : '');
    if (title == null || !title.trim()) return;
    const body = window.prompt('PR body (markdown ok; empty = blank):', '') || '';
    const base = window.prompt('Base branch (blank = auto-detect):', '') || '';
    try {
      const r = await api('/api/launcher/instances/' + pid + '/open-pr', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title: title.trim(), body, base: base.trim() }),
      });
      if (r.ok === false && r.error) { alert('Open PR failed: ' + r.error); return; }
      if (r.url) { alert('PR created:\\n' + r.url); try { window.open(r.url, '_blank', 'noopener'); } catch {} }
      else { alert('PR created (no URL returned)'); }
    } catch (e) { alert('Open PR failed: ' + e.message); }
  }
  listEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act !== 'git-commit' && act !== 'git-push' && act !== 'git-pr') return;
    ev.preventDefault();
    const pid = parseInt(t.dataset.pid, 10);
    if (!Number.isFinite(pid)) return;
    if (act === 'git-commit') gitCommitFlow(pid);
    else if (act === 'git-push') gitPushFlow(pid);
    else if (act === 'git-pr') gitOpenPrFlow(pid);
  });

  // ---- M4: Memory tab — open + edit + save CLAUDE.md / rules ----
  async function memOpenRow(memRow) {
    const body = memRow.querySelector('.mr-body');
    if (!body) return;
    if (!body.hidden) {
      // toggle close
      body.hidden = true; body.innerHTML = '';
      return;
    }
    body.hidden = false;
    body.innerHTML = '<div class="tab-loading">loading…</div>';
    const path = memRow.dataset.memPath;
    try {
      const r = await api('/api/launcher/file?path=' + encodeURIComponent(path));
      body.innerHTML = ''
        + '<textarea spellcheck="false" data-mem-edit></textarea>'
        + '<div class="mr-actions">'
        +   '<button class="btn primary" data-act="mem-save">Save</button>'
        +   '<button class="btn" data-act="mem-cancel">Cancel</button>'
        +   '<span class="mr-info">' + (r.size || 0) + ' bytes · backup auto-kept (latest 5)</span>'
        + '</div>';
      body.querySelector('textarea').value = r.content || '';
    } catch (e) {
      body.innerHTML = '<div class="tab-error">load failed: ' + escape(e.message) + '</div>';
    }
  }
  async function memSaveRow(memRow) {
    const path = memRow.dataset.memPath;
    const ta = memRow.querySelector('textarea[data-mem-edit]');
    if (!ta) return;
    try {
      const r = await api('/api/launcher/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: ta.value }),
      });
      alert('Saved · ' + (r.size || 0) + ' bytes' + (r.backup ? '\\nbackup: ' + r.backup : ''));
      // Refresh the Memory tab so size/mtime update
      const container = memRow.closest('[data-tabs-for]');
      if (container) {
        const pid = Number(container.dataset.tabsFor);
        const st = _tabState.get(pid);
        if (st) st.cache.memory = null;
        loadTabData(pid, 'memory');
      }
    } catch (e) { alert('Save failed: ' + e.message); }
  }
  listEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act !== 'mem-open' && act !== 'mem-save' && act !== 'mem-cancel') return;
    ev.preventDefault();
    const memRow = t.closest('.mem-row');
    if (!memRow) return;
    if (act === 'mem-open') memOpenRow(memRow);
    else if (act === 'mem-save') memSaveRow(memRow);
    else if (act === 'mem-cancel') { const b = memRow.querySelector('.mr-body'); if (b) { b.hidden = true; b.innerHTML = ''; } }
  });

  // ---- Terminal overlay ----
  const TERM_FONT = "'NerdFont','MesloLGS NF','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace";
  let _fontReady = false;
  // Preload the NerdFont so xterm.js can measure glyphs correctly on first open
  document.fonts.load('14px NerdFont').then(() => { _fontReady = true; }).catch(() => {});

  // Mirrors cc-viewer/src/env.js + TerminalPanel.jsx:243-251 mobile detection.
  // iPadOS 13+ Safari spoofs Mac UA so we use maxTouchPoints to disambiguate;
  // smaller scrollback on iOS keeps memory pressure low (Safari kills
  // backgrounded tabs more aggressively when RAM is tight).
  const _isIPadOS = navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || _isIPadOS;
  const isPad = _isIPadOS || /iPad/i.test(navigator.userAgent);
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || _isIPadOS;

  // Shared xterm config — keeps both openConsole (ccv child WS) and openShell
  // (hub /ws/shell) terminals visually consistent and mobile-friendly.
  // iOS Safari falls back to a non-monospace font more often when given
  // exotic fontFamily lists, so on mobile we prefer the system monospace token.
  function buildTerminalConfig() {
    return {
      cursorBlink: true,
      fontSize: (isMobile && !isPad) ? 11 : 14,
      fontFamily: isMobile
        ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        : TERM_FONT,
      // iOS gets the smallest scrollback — RAM is the binding constraint there.
      scrollback: isPad ? 3000 : isIOS ? 200 : isMobile ? 500 : 3000,
      theme: { background: '#0f1115', foreground: '#e6e8ec', cursor: '#6ea8fe' },
    };
  }

  let _term = null, _termWs = null;
  const termOverlay = document.getElementById('term-overlay');
  const termContainer = document.getElementById('term-container');
  const termType = document.getElementById('term-type');
  const termName = document.getElementById('term-name');
  const termPath = document.getElementById('term-path');
  document.getElementById('term-close').addEventListener('click', closeTerminal);

  function openConsole(port, token, name, path, pubUrl, lanUrl) {
    closeTerminal();
    termType.textContent = 'Console';
    termType.className = 'type-tag console';
    termName.textContent = name || ':' + port;
    termPath.textContent = path || '';
    termOverlay.classList.add('open');

    _term = new Terminal(buildTerminalConfig());
    const fitAddon = new FitAddon.FitAddon();
    _term.loadAddon(fitAddon);
    _term.open(termContainer);
    fitAddon.fit();

    // Build WS URL: prefer same-origin relative path if port matches hub, otherwise cross-origin to child
    let wsUrl;
    const loc = window.location;
    if (pubUrl) {
      // public: wss://<public-host>/ws/terminal (host derived from pubUrl)
      try {
        const u = new URL(pubUrl);
        wsUrl = (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host + '/ws/terminal';
      } catch { /* fallback below */ }
    }
    if (!wsUrl && lanUrl) {
      try {
        const u = new URL(lanUrl);
        wsUrl = 'ws://' + u.host + '/ws/terminal';
      } catch { /* fallback below */ }
    }
    if (!wsUrl) {
      wsUrl = (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.hostname + ':' + port + '/ws/terminal';
    }

    _term.writeln('\\x1b[90mConnecting to ' + wsUrl + '...\\x1b[0m');
    _termWs = new WebSocket(wsUrl);
    _termWs.onopen = () => {
      _term.writeln('\\x1b[32mConnected.\\x1b[0m Press Enter to get a prompt.');
      _termWs.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }));
    };
    _termWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data' && msg.data) _term.write(msg.data);
        else if (msg.type === 'exit') _term.writeln('\\r\\n\\x1b[33m[process exited: ' + (msg.exitCode ?? '?') + ']\\x1b[0m');
        else if (msg.type === 'state' && !msg.running) _term.writeln('\\x1b[90m[no active process — type to spawn shell]\\x1b[0m');
      } catch { _term.write(ev.data); }
    };
    _termWs.onerror = () => _term.writeln('\\r\\n\\x1b[31mWebSocket error\\x1b[0m');
    _termWs.onclose = () => _term.writeln('\\r\\n\\x1b[90m[disconnected]\\x1b[0m');

    _term.onData((data) => {
      if (_termWs && _termWs.readyState === 1) {
        _termWs.send(JSON.stringify({ type: 'input', data }));
      }
    });
    _term.onResize(({ cols, rows }) => {
      if (_termWs && _termWs.readyState === 1) {
        _termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
    ro.observe(termContainer);
    termOverlay._ro = ro;
    if (!_fontReady && !isMobile) document.fonts.ready.then(() => { _fontReady = true; if (_term) { _term.options.fontFamily = TERM_FONT; fitAddon.fit(); } });
  }

  function openShell(cwd, name) {
    closeTerminal();
    termType.textContent = 'Shell';
    termType.className = 'type-tag shell';
    termName.textContent = name || cwd;
    termPath.textContent = cwd || '';
    termOverlay.classList.add('open');

    _term = new Terminal(buildTerminalConfig());
    const fitAddon = new FitAddon.FitAddon();
    _term.loadAddon(fitAddon);
    _term.open(termContainer);
    fitAddon.fit();

    // Connect to hub's own /ws/shell endpoint (same origin). If we have a
    // resumable sessionId from a previous /ws/shell connection (PB3), pass
    // it so the server replays buffered output and reattaches to the live
    // PTY instead of spawning a fresh one. sessionStorage (not localStorage)
    // because the resume is meaningful only within the same tab lifetime —
    // a new tab gets a fresh shell.
    const loc = window.location;
    const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const storedSid = (() => { try { return sessionStorage.getItem('ccvShellSessionId'); } catch { return null; } })();
    const sidParam = storedSid ? '&sessionId=' + encodeURIComponent(storedSid) : '';
    const wsUrl = wsProto + '//' + loc.host + '/ws/shell?cwd=' + encodeURIComponent(cwd) + sidParam;

    _term.writeln('\\x1b[90m$ cd ' + cwd + '\\x1b[0m');
    _termWs = new WebSocket(wsUrl);
    _termWs.onopen = () => {
      _termWs.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }));
    };
    _termWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello' && msg.sessionId) {
          // Server rotates sessionId on every successful (re)attach; persist
          // immediately so a quick disconnect+reconnect picks it up.
          try { sessionStorage.setItem('ccvShellSessionId', msg.sessionId); } catch {}
          if (msg.isReattach) _term.writeln('\\x1b[32m[reattached to existing shell]\\x1b[0m');
        }
        else if (msg.type === 'data' && msg.data) _term.write(msg.data);
        else if (msg.type === 'exit') {
          _term.writeln('\\r\\n\\x1b[33m[shell exited: ' + (msg.exitCode ?? '?') + ']\\x1b[0m');
          // Shell ended for real (not a network drop) — drop the stored id
          // so the next openShell starts fresh instead of trying to resume
          // a dead session.
          try { sessionStorage.removeItem('ccvShellSessionId'); } catch {}
        }
      } catch { _term.write(ev.data); }
    };
    _termWs.onerror = () => _term.writeln('\\r\\n\\x1b[31mWebSocket error\\x1b[0m');
    _termWs.onclose = () => _term.writeln('\\r\\n\\x1b[90m[disconnected]\\x1b[0m');

    _term.onData((data) => {
      if (_termWs && _termWs.readyState === 1) _termWs.send(JSON.stringify({ type: 'input', data }));
    });
    _term.onResize(({ cols, rows }) => {
      if (_termWs && _termWs.readyState === 1) _termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
    ro.observe(termContainer);
    termOverlay._ro = ro;
    if (!_fontReady && !isMobile) document.fonts.ready.then(() => { _fontReady = true; if (_term) { _term.options.fontFamily = TERM_FONT; fitAddon.fit(); } });
  }

  function closeTerminal() {
    termOverlay.classList.remove('open');
    if (_termWs) { try { _termWs.close(); } catch {} _termWs = null; }
    if (_term) { _term.dispose(); _term = null; }
    if (termOverlay._ro) { termOverlay._ro.disconnect(); termOverlay._ro = null; }
    termContainer.innerHTML = '';
    // Explicit close = user dismissed; don't try to resume on next open.
    // Server-side: ws.close fires markOrphan with a 5min TTL, so the PTY
    // sticks around briefly — that's fine, it'll be reaped.
    try { sessionStorage.removeItem('ccvShellSessionId'); } catch {}
  }

  // ESC closes terminal overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && termOverlay.classList.contains('open')) closeTerminal();
  });

  // ---- ccv inline overlay (iframe) ----
  // Open a ccv session inside the launcher tab via an iframe. Lets the user
  // bounce between sessions without losing the launcher state. Closing clears
  // the iframe src to free the WebSocket; reopening reloads from scratch.
  const ccvOverlay = document.getElementById('ccv-overlay');
  const ccvFrame = document.getElementById('ccv-frame');
  const ccvName = document.getElementById('ccv-name');
  const ccvPort = document.getElementById('ccv-port');
  const ccvPath = document.getElementById('ccv-path');
  const ccvFrameStatus = document.getElementById('ccv-frame-status');
  const ccvFrameStatusLoading = ccvFrameStatus.querySelector('[data-state="loading"]');
  const ccvFrameStatusError = ccvFrameStatus.querySelector('[data-state="error"]');
  const ccvFrameErrDetail = document.getElementById('ccv-frame-err-detail');
  let _ccvLastHref = '';
  let _ccvLoadWatchdog = null;
  let _ccvLoadStartedAt = 0;

  function setCcvFrameState(state, detail) {
    if (state === 'ok') {
      ccvFrameStatus.classList.remove('show');
      return;
    }
    ccvFrameStatus.classList.add('show');
    if (state === 'loading') {
      ccvFrameStatusLoading.style.display = 'flex';
      ccvFrameStatusError.style.display = 'none';
    } else { // error
      ccvFrameStatusLoading.style.display = 'none';
      ccvFrameStatusError.style.display = 'flex';
      if (detail) ccvFrameErrDetail.textContent = detail;
    }
  }

  function openCcvInline(href, name, port, path) {
    if (!href || href === '#') return;
    ccvName.textContent = name || '';
    ccvPort.textContent = port ? ':' + port : '';
    ccvPath.textContent = path || '';
    // Always force a reload, even when reopening the same href — the ccv on
    // that port may have restarted (token rotated) since we last loaded it,
    // and a stale src would silently 403 → black screen. Setting src to
    // about:blank first then to the target URL guarantees a fresh load even
    // when href === current src.
    setCcvFrameState('loading');
    _ccvLoadStartedAt = Date.now();
    ccvFrame.src = 'about:blank';
    // Wait for blank to commit before navigating to target — otherwise some
    // browsers coalesce the two navigations and the load event fires for blank.
    requestAnimationFrame(() => {
      ccvFrame.src = href;
      _ccvLastHref = href;
    });
    ccvOverlay.classList.add('open');
    // Watchdog: if ccv doesn't respond in 6s we surface a retry/new-tab UI
    // instead of leaving the user staring at black. ccv's index.html is
    // ~1.6KB + a few module chunks; on localhost this should always finish in
    // well under a second when ccv is healthy.
    if (_ccvLoadWatchdog) clearTimeout(_ccvLoadWatchdog);
    _ccvLoadWatchdog = setTimeout(() => {
      // Only surface error if we haven't seen a successful load
      if (ccvFrameStatus.classList.contains('show')) {
        setCcvFrameState('error', 'Timed out waiting for ccv to respond. The instance may have just been restarted, or the iframe was blocked.');
      }
    }, 6000);
  }
  function closeCcvInline() {
    ccvOverlay.classList.remove('open');
    if (_ccvLoadWatchdog) { clearTimeout(_ccvLoadWatchdog); _ccvLoadWatchdog = null; }
    // Free the iframe so WebSocket / streaming connections drop. Reopening
    // means a fresh load — ccv boots fast enough that this is the right
    // tradeoff vs leaking N hidden iframes.
    ccvFrame.src = 'about:blank';
    _ccvLastHref = '';
    setCcvFrameState('ok');
  }
  ccvFrame.addEventListener('load', () => {
    // load fires for both about:blank and the real navigation; only count the
    // real one (i.e., when src is not about:blank).
    const src = ccvFrame.getAttribute('src') || '';
    if (src === 'about:blank' || src === '') return;
    // Tiny grace so SPA module imports get a chance to start rendering before
    // we reveal the iframe — avoids a brief flash of pre-React DOM.
    setTimeout(() => setCcvFrameState('ok'), 120);
    if (_ccvLoadWatchdog) { clearTimeout(_ccvLoadWatchdog); _ccvLoadWatchdog = null; }
  });
  document.getElementById('ccv-close').addEventListener('click', closeCcvInline);
  document.getElementById('ccv-reload').addEventListener('click', () => {
    if (_ccvLastHref) openCcvInline(_ccvLastHref, ccvName.textContent, (ccvPort.textContent||'').replace(/^:/,''), ccvPath.textContent);
  });
  document.getElementById('ccv-frame-retry').addEventListener('click', () => {
    if (_ccvLastHref) openCcvInline(_ccvLastHref, ccvName.textContent, (ccvPort.textContent||'').replace(/^:/,''), ccvPath.textContent);
  });
  document.getElementById('ccv-frame-newtab').addEventListener('click', () => {
    if (!_ccvLastHref) return;
    const winName = ccvPort.textContent ? 'ccv-' + ccvPort.textContent.replace(/^:/,'') : '_blank';
    const w = window.open(_ccvLastHref, winName);
    if (w) { try { w.focus(); } catch {} }
    closeCcvInline();
  });
  document.getElementById('ccv-newtab').addEventListener('click', () => {
    if (!_ccvLastHref) return;
    const winName = ccvPort.textContent ? 'ccv-' + ccvPort.textContent.replace(/^:/,'') : '_blank';
    const w = window.open(_ccvLastHref, winName);
    if (w) { try { w.focus(); } catch {} }
    closeCcvInline();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ccvOverlay.classList.contains('open')) closeCcvInline();
  });

  async function refresh() {
    try {
      const data = await api('/api/launcher/list');
      render(data.instances || [], data.history || [], data.localCcSessions || []);
      refreshActivity();
    }
    catch (e) { listEl.innerHTML = '<div class="empty err">'+escape(e.message)+'</div>'; }
  }

  // ---- activity poll: per-card status badge + preview + drawer ----
  function eventLineHtml(ev) {
    const parts = [];
    const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour12:false }) : '';
    let body = '';
    if (ev.userPrompt) body += '<div class="event-line user">user · ' + escape(ev.userPrompt) + '</div>';
    if (ev.toolUse)    body += '<div class="event-line tool">🛠 ' + escape(ev.toolUse) + (ev.inProgress ? ' <span class="event-line flag">…streaming</span>' : '') + '</div>';
    if (ev.assistantText && !ev.toolUse) body += '<div class="event-line assistant">claude · ' + escape(ev.assistantText) + '</div>';
    if (!body) body = '<div class="event-line assistant">' + (ev.inProgress ? 'streaming…' : 'request') + '</div>';
    parts.push('<div class="event-row"><span class="event-ts">' + escape(ts) + '</span><div class="event-body">' + body + '</div></div>');
    return parts.join('');
  }

  function renderDrawer(act) {
    const sections = [];
    if (act.pendingAsks && act.pendingAsks.length) {
      const items = act.pendingAsks.map(a => {
        const q = (a.questions && a.questions[0]) || {};
        const label = q.header || q.question || '(question)';
        return '<div class="ask-row">⏳ ' + escape(label) + '</div>';
      }).join('');
      sections.push('<div class="drawer-section"><div class="drawer-h">pending asks (' + act.pendingAsks.length + ')</div>' + items + '</div>');
    }
    if (act.recentEvents && act.recentEvents.length) {
      const rows = act.recentEvents.map(eventLineHtml).join('');
      sections.push('<div class="drawer-section"><div class="drawer-h">recent activity</div>' + rows + '</div>');
    } else {
      sections.push('<div class="drawer-section"><div class="drawer-h">recent activity</div><div class="event-line assistant">no entries</div></div>');
    }
    if (act.logFile) {
      sections.push('<div class="drawer-section"><div class="drawer-h">log file</div><div class="event-line assistant">' + escape(act.logFile) + '</div></div>');
    }
    return sections.join('');
  }

  async function refreshActivity() {
    let data;
    try { data = await api('/api/launcher/activity'); }
    catch (e) { return; }
    const acts = data.activity || [];
    let colsDirty = false;
    for (const act of acts) {
      const row = document.querySelector('[data-act-row="' + act.pid + '"]');
      if (!row) continue;
      const badge = row.querySelector('.badge');
      const preview = row.querySelector('.preview');
      if (badge) {
        const view = STATUS_VIEW[act.status] || { icon: '⚫', short: act.status || 'unknown' };
        badge.className = 'badge ' + (act.status || 'no_session');
        badge.textContent = view.icon + ' ' + view.short;
        // Backend's verbose statusLabel (e.g. "🛠 Bash: ls -la /tmp/foo") is the
        // hover tooltip — single-char icon stays compact, full label still
        // available without leaving the dashboard.
        if (act.statusLabel) badge.title = act.statusLabel;
        else badge.removeAttribute('title');
      }
      if (preview) preview.textContent = act.preview || '';
      const titleEl = document.querySelector('[data-title-for="' + act.pid + '"]');
      if (titleEl) {
        if (act.title) {
          titleEl.textContent = act.title;
          titleEl.title = act.title; // full text on hover
        } else {
          titleEl.textContent = '';
          titleEl.removeAttribute('title');
        }
      }
      const ctxRow = document.querySelector('[data-ctx-for="' + act.pid + '"]');
      if (ctxRow) renderContextRow(ctxRow, act.contextUsage);
      // T6 follow-up: per-instance session cost mini-tag in instance-head
      const costTag = document.querySelector('[data-cost-for="' + act.pid + '"]');
      if (costTag) {
        const costUSD = act.sessionUsage && act.sessionUsage.costUSD;
        if (costUSD != null && costUSD > 0) {
          costTag.hidden = false;
          costTag.textContent = fmtUSD(Number(costUSD));
          const req = act.sessionUsage.requestCount;
          costTag.title = 'session cost' + (req ? ' · ' + req + ' req' : '');
        } else {
          costTag.hidden = true;
          costTag.textContent = '';
          costTag.removeAttribute('title');
        }
      }
      // T11: compactStatus card-level banner. Surface only when the threshold
      // has tripped but backend couldn't auto-inject /compact (ccv has no
      // inject channel), so the user knows to run /compact manually.
      if (act.compactStatus) _compactStatusByPid.set(act.pid, act.compactStatus);
      const compactEl = document.querySelector('[data-compact-for="' + act.pid + '"]');
      if (compactEl) renderCompactAlert(compactEl, act.compactStatus);
      const drawer = document.querySelector('[data-act-drawer="' + act.pid + '"]');
      if (drawer) {
        drawer.dataset.payload = JSON.stringify(act);
        if (drawer.classList.contains('open')) drawer.innerHTML = renderDrawer(act);
      }
      // Track per-pid status; if any group's column needs to change, we
      // re-render once at the end of this tick rather than mutating DOM
      // (preserves details-open state via render()'s existing logic).
      if (act.pid != null) {
        const prev = _statusByPid.get(act.pid);
        if (prev !== act.status) {
          _statusByPid.set(act.pid, act.status);
          colsDirty = true;
        }
      }
    }
    if (colsDirty && _lastListData.items.length) {
      // Recompute column for each cwd; only re-render if assignments differ
      // from what we already painted.
      const cwds = new Map();
      for (const it of _lastListData.items) {
        const key = it.cwd || '';
        if (!cwds.has(key)) cwds.set(key, []);
        cwds.get(key).push(it);
      }
      let needRender = false;
      for (const [cwd, list] of cwds) {
        if (colForGroup({ list }) !== _lastColByCwd.get(cwd)) { needRender = true; break; }
      }
      if (needRender) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
    }
  }

  // ---- T6: per-card context bar (H2) ----
  // Color thresholds match optimization-web.md: 60% warn, 80% hot, 95% bad.
  function ctxClass(pct) {
    if (pct >= 95) return 'bad';
    if (pct >= 80) return 'hot';
    if (pct >= 60) return 'warn';
    return '';
  }
  function renderContextRow(row, ctx) {
    if (!ctx || !ctx.limit) {
      row.hidden = true;
      row.innerHTML = '';
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(ctx.percent) || 0));
    const used = Number(ctx.used || 0);
    const limit = Number(ctx.limit || 0);
    const usedK = used >= 1000 ? (used/1000).toFixed(1) + 'k' : String(used);
    const limitK = limit >= 1000 ? Math.round(limit/1000) + 'k' : String(limit);
    const cls = ctxClass(pct);
    const display = ctx.displayName || ctx.model || '';
    row.hidden = false;
    row.innerHTML =
        '<span class="ctx-model" title="' + escape(display) + '">' + escape(display) + '</span>'
      + '<span class="ctx-bar"><span class="ctx-fill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></span></span>'
      + '<span class="ctx-pct">' + pct.toFixed(0) + '%</span>'
      + '<span>' + usedK + ' / ' + limitK + '</span>';
  }

  // ---- T11: card tabs panel (M1 Run Summary + M3 Recent Edits + Errors) ----
  // Per-pid tab state survives render() re-runs so the active tab + cached
  // payloads aren't lost when refreshActivity triggers a Kanban repaint.
  const _tabState = new Map();
  const _compactStatusByPid = new Map();
  function getTabState(pid) {
    if (!_tabState.has(pid)) _tabState.set(pid, { activeTab: 'urls', cache: {}, fetching: {} });
    return _tabState.get(pid);
  }

  function fmtAbsTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch { return ''; }
  }

  const TAB_LABEL = { urls: 'URLs · QR', summary: 'Summary', edits: 'Edits', errors: 'Errors', threshold: 'Threshold', memory: 'Memory', git: 'Git' };
  const TAB_ENDPOINT = {
    summary: pid => '/api/launcher/instances/' + pid + '/run-summary',
    edits:   pid => '/api/launcher/instances/' + pid + '/recent-edits',
    errors:  pid => '/api/launcher/instances/' + pid + '/errors',
    git:     pid => '/api/launcher/instances/' + pid + '/git-diff',
    memory:  pid => '/api/launcher/instances/' + pid + '/claude-md',
    // 'threshold' has no fetch endpoint — it's a per-cwd form driven by
    // compactStatus from the activity payload and by POSTing to
    // /api/launcher/prefs/compact-threshold on Save.
  };

  function setActiveTab(pid, tab) {
    const st = getTabState(pid);
    st.activeTab = tab;
    const container = document.querySelector('[data-tabs-for="' + pid + '"]');
    if (!container) return;
    container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tabBtn === tab));
    container.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tabPanel !== tab);
    // Threshold tab is a form rendered from cached activity data; render on
    // each activation but don't auto-refresh (avoid overwriting user input).
    if (tab === 'threshold') {
      renderThresholdPanel(pid);
      return;
    }
    // Lazy-load other non-URLs tabs on first activation; subsequent
    // activations show cached content immediately.
    if (tab !== 'urls') {
      const panel = container.querySelector('[data-tab-panel="' + tab + '"]');
      if (st.cache[tab]) {
        if (panel) renderTabPanel(pid, tab, panel, st.cache[tab]);
      } else {
        loadTabData(pid, tab);
      }
    }
  }

  async function loadTabData(pid, tab) {
    const st = getTabState(pid);
    if (st.fetching[tab]) return;
    if (!TAB_ENDPOINT[tab]) return;
    st.fetching[tab] = true;
    const panel = document.querySelector('[data-tab-panel="' + tab + '"][data-pid="' + pid + '"]');
    if (panel && !st.cache[tab]) panel.innerHTML = '<div class="tab-loading">loading…</div>';
    try {
      const data = await api(TAB_ENDPOINT[tab](pid));
      st.cache[tab] = data;
      const stillActive = getTabState(pid).activeTab === tab;
      if (panel && stillActive) renderTabPanel(pid, tab, panel, data);
      updateTabBadges(pid, tab, data);
    } catch (e) {
      if (panel && !st.cache[tab]) panel.innerHTML = '<div class="tab-error">load failed: ' + escape(e.message) + '</div>';
    } finally {
      st.fetching[tab] = false;
    }
  }

  function updateTabBadges(pid, tab, data) {
    const btn = document.querySelector('[data-tabs-for="' + pid + '"] [data-tab-btn="' + tab + '"]');
    if (!btn) return;
    let n = 0;
    if (tab === 'summary') n = data.totalEvents != null ? data.totalEvents : (data.events ? data.events.length : 0);
    else if (tab === 'edits') n = data.totalUniqueTargets != null ? data.totalUniqueTargets : ((data.files || []).length + (data.bash || []).length);
    else if (tab === 'errors') n = data.total != null ? data.total : (data.groups ? data.groups.length : 0);
    else if (tab === 'git') n = (data.files || []).length;
    else if (tab === 'memory') n = (data.files || []).length;
    btn.innerHTML = escape(TAB_LABEL[tab]) + (n ? ' <span class="tab-count">' + n + '</span>' : '');
    if (tab === 'errors') btn.classList.toggle('has-error', n > 0);
  }

  function renderTabPanel(pid, tab, panel, data) {
    if (tab === 'summary')     panel.innerHTML = renderRunSummaryHTML(data);
    else if (tab === 'edits')  panel.innerHTML = renderRecentEditsHTML(data);
    else if (tab === 'errors') panel.innerHTML = renderErrorsHTML(data);
    else if (tab === 'git')    panel.innerHTML = renderGitHTML(pid, data);
    else if (tab === 'memory') panel.innerHTML = renderMemoryHTML(pid, data);
  }

  const EVENT_ICON = {
    prompt:        '✎',
    slash_command: '/',
    auto_compact:  '⇣',
    tool_error:    '⚠',
    subagent:      '⌬',
    hook_event:    '⚙',
  };

  function renderRunSummaryHTML(d) {
    const t = d.totals || {};
    const totalsHtml = ''
      + '<div class="run-totals">'
      +   '<span class="rt-chip">' + (t.prompts || 0) + ' prompts</span>'
      +   '<span class="rt-chip">' + (t.tools || 0) + ' tools</span>'
      +   (t.slash_commands ? '<span class="rt-chip">' + t.slash_commands + ' /cmds</span>' : '')
      +   (t.compacts ? '<span class="rt-chip">' + t.compacts + ' compact</span>' : '')
      +   (t.subagents ? '<span class="rt-chip">' + t.subagents + ' subagent</span>' : '')
      +   (t.errors ? '<span class="rt-chip err">' + t.errors + ' errors</span>' : '')
      +   (t.hooks ? '<span class="rt-chip">' + t.hooks + ' hooks</span>' : '')
      + '</div>';
    const events = (d.events || []).slice().reverse(); // newest first
    if (!events.length) return totalsHtml + '<div class="tab-empty">no events yet</div>';
    const rows = events.map(ev => {
      const icon = EVENT_ICON[ev.type] || '·';
      const lineHint = ev.jsonlLine ? 'jsonl line ' + ev.jsonlLine : '';
      return '<div class="run-event-row t-' + escape(ev.type || '') + '"' + (lineHint ? ' title="' + lineHint + '"' : '') + '>'
        + '<span class="re-ts">' + escape(fmtAbsTime(ev.ts)) + '</span>'
        + '<span class="re-icon">' + escape(icon) + '</span>'
        + '<span class="re-label">' + escape(ev.label || ev.type || '') + '</span>'
        + '</div>';
    }).join('');
    return totalsHtml + rows;
  }

  function renderRecentEditsHTML(d) {
    const files = d.files || [];
    const bash = d.bash || [];
    if (!files.length && !bash.length) return '<div class="tab-empty">no recent edits or commands</div>';
    const renderItem = (it, defaultTool) => ''
      + '<div class="edit-row">'
      +   '<div class="er-line1">'
      +     '<span class="er-tool">' + escape(it.tool || defaultTool || '') + '</span>'
      +     '<span class="er-path" title="' + escape(it.path || '') + '">' + escape(it.path || '') + '</span>'
      +     '<span class="er-meta">×' + (it.count || 0) + (it.lastTs ? ' · ' + fmtAge(it.lastTs) + ' ago' : '') + '</span>'
      +   '</div>'
      +   (it.lastDiffPreview ? '<div class="er-preview">' + escape(it.lastDiffPreview) + '</div>' : '')
      + '</div>';
    let html = '';
    if (files.length) {
      html += '<div class="edits-section"><div class="es-hd">Files (' + files.length + ')</div>';
      html += files.map(f => renderItem(f, 'Edit')).join('');
      html += '</div>';
    }
    if (bash.length) {
      html += '<div class="edits-section"><div class="es-hd">Bash (' + bash.length + ')</div>';
      html += bash.map(b => renderItem(b, 'Bash')).join('');
      html += '</div>';
    }
    return html;
  }

  function renderErrorsHTML(d) {
    const groups = d.groups || [];
    if (!groups.length) return '<div class="tab-empty">no errors</div>';
    return groups.map((g, i) => {
      const samples = (g.samples || []).map(s => ''
        + '<div class="err-sample">'
        +   (s.ts ? '<span class="es-ts">' + escape(fmtAbsTime(s.ts)) + '</span>' : '')
        +   escape(s.fullMessage || '')
        + '</div>'
      ).join('');
      return ''
        + '<div class="err-group" data-err-group="' + i + '">'
        +   '<div class="eg-hd" title="click to toggle samples">'
        +     '<span class="eg-tool">' + escape(g.toolName || '?') + '</span>'
        +     '<span class="eg-pattern">' + escape(g.errorPattern || '') + '</span>'
        +     '<span class="eg-count">×' + (g.count || 0) + (g.lastTs ? ' · ' + fmtAge(g.lastTs) + ' ago' : '') + '</span>'
        +   '</div>'
        +   '<div class="eg-samples">' + samples + '</div>'
        + '</div>';
    }).join('');
  }

  function renderGitHTML(pid, d) {
    const stat = d.stat || { additions: 0, deletions: 0, files: 0 };
    const wt = d.worktree || {};
    const files = d.files || [];
    const ahead = d.ahead || 0;
    const head = ''
      + '<div class="git-summary">'
      +   '<span class="g-branch" title="base: ' + escape(wt.baseRef || '') + '">🌿 ' + escape(wt.branch || '?') + '</span>'
      +   '<span class="g-stat-add">+' + stat.additions + '</span>'
      +   '<span class="g-stat-del">-' + stat.deletions + '</span>'
      +   '<span class="g-stat-files">in ' + stat.files + ' file' + (stat.files === 1 ? '' : 's') + '</span>'
      +   (ahead ? '<span class="g-ahead">· ' + ahead + ' ahead of origin</span>' : '<span class="g-ahead g-muted">· in sync with origin</span>')
      + '</div>';
    const fileRows = files.length
      ? '<div class="git-files">' + files.map(f => ''
          + '<div class="g-file' + (f.untracked ? ' g-untracked' : '') + '">'
          +   '<span class="g-path" title="' + escape(f.path || '') + '">' + escape(f.path || '') + (f.untracked ? ' <span class="g-tag-new">new</span>' : '') + '</span>'
          +   '<span class="g-loc">+' + (f.additions || 0) + ' -' + (f.deletions || 0) + '</span>'
          + '</div>'
        ).join('') + '</div>'
      : '<div class="tab-empty">working tree clean' + (ahead ? ' · ' + ahead + ' commit' + (ahead === 1 ? '' : 's') + ' ready to push' : '') + '</div>';
    const actions = ''
      + '<div class="git-actions">'
      +   '<button class="btn primary" data-act="git-commit" data-pid="' + pid + '"' + (files.length ? '' : ' disabled') + '>Commit</button>'
      +   '<button class="btn" data-act="git-push" data-pid="' + pid + '"' + (ahead || files.length ? '' : ' disabled title="nothing to push"') + '>Push</button>'
      +   '<button class="btn" data-act="git-pr" data-pid="' + pid + '">Open PR</button>'
      + '</div>';
    return head + fileRows + actions;
  }

  // Memory tab: groups CLAUDE.md scan results by scope, each row expandable
  // into an inline editor. Loaded lazily from /api/launcher/instances/:pid/claude-md.
  const SCOPE_LABEL = { project: '本项目', parent: '父目录链', global: '全局', rule: 'Rules' };
  function renderMemoryHTML(pid, d) {
    const files = (d && d.files) || [];
    if (!files.length) return '<div class="tab-empty">no CLAUDE.md found on this cwd / global</div>';
    const groups = { project: [], parent: [], global: [], rule: [] };
    for (const f of files) (groups[f.scope] || (groups[f.scope] = [])).push(f);
    let html = '';
    for (const scope of ['project', 'parent', 'global', 'rule']) {
      const arr = groups[scope] || [];
      if (!arr.length) continue;
      html += '<div class="mem-group">';
      html += '<div class="mg-hd">' + escape(SCOPE_LABEL[scope] || scope) + ' (' + arr.length + ')</div>';
      for (const f of arr) {
        const sizeKB = (f.size / 1024).toFixed(1);
        const ago = f.mtime ? fmtAge(f.mtime) + ' ago' : '';
        html += ''
          + '<div class="mem-row" data-mem-path="' + escape(f.path) + '">'
          +   '<div class="mr-hd" data-act="mem-open">'
          +     '<span class="mr-path" title="' + escape(f.path) + '">' + escape(f.path.replace(/^.*\\//, '')) + '</span>'
          +     '<span class="mr-dir" title="' + escape(f.path) + '">' + escape(dirnameJs(f.path)) + '</span>'
          +     '<span class="mr-meta">' + sizeKB + ' KB · ' + escape(ago) + '</span>'
          +   '</div>'
          +   '<div class="mr-body" hidden></div>'
          + '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  // dirname() shim — no node:path in browser. Splits to last "/".
  function dirnameJs(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  function renderCompactAlert(el, status) {
    if (!status || !status.enabled) { el.hidden = true; el.innerHTML = ''; return; }
    // Only surface the manual-/compact nudge when the threshold tripped AND
    // backend couldn't auto-inject. Other states stay silent.
    if (status.lastResult === 'skipped' && status.reason === 'no_inject_channel') {
      const ago = status.lastTriggeredAt ? ' (' + fmtAge(status.lastTriggeredAt) + ' ago)' : '';
      const threshold = status.auto_compact_at ? fmtTokensK(status.auto_compact_at) : '?';
      el.hidden = false;
      el.innerHTML = ''
        + '<span class="ca-icon">⚠</span>'
        + '<div>context window 超过阈值 <span class="ca-cmd">' + escape(threshold) + ' tok</span>，'
        +   'ccv 暂无 inject 通道无法自动注入。请在该 session 内手动运行 <span class="ca-cmd">/compact</span>'
        +   escape(ago) + '。</div>';
      return;
    }
    el.hidden = true;
    el.innerHTML = '';
  }

  // ---- T11 follow-up: Compact Threshold form (per-cwd config) ----
  // Reads compactStatus from _compactStatusByPid (populated by refreshActivity)
  // and POSTs to /api/launcher/prefs/compact-threshold on Save. Doesn't poll —
  // user input would get clobbered. Form re-renders on each tab activation +
  // after a successful save.
  const DEFAULT_AUTO_COMPACT = 110000;
  const DEFAULT_AUTO_CLEAR = 140000;
  function renderThresholdPanel(pid) {
    const panel = document.querySelector('[data-tab-panel="threshold"][data-pid="' + pid + '"]');
    if (!panel) return;
    const cwd = panel.dataset.cwd || '';
    const cs = _compactStatusByPid.get(Number(pid)) || _compactStatusByPid.get(pid) || {};
    panel.innerHTML = renderThresholdHTML(pid, cwd, cs);
  }
  function renderThresholdHTML(pid, cwd, cs) {
    const enabled = !!cs.enabled;
    const ac = cs.auto_compact_at || DEFAULT_AUTO_COMPACT;
    const cle = cs.auto_clear_at || DEFAULT_AUTO_CLEAR;
    const ago = cs.lastTriggeredAt ? fmtAge(cs.lastTriggeredAt) + ' ago' : 'never';
    const cooldownRemainSec = cs.cooldownUntil && cs.cooldownUntil > Date.now()
      ? Math.ceil((cs.cooldownUntil - Date.now()) / 1000) : 0;
    const noInject = cs.lastResult === 'skipped' && cs.reason === 'no_inject_channel';
    const meta = ''
      + '<div class="th-meta">'
      +   '<div>last trigger: ' + escape(ago) + (cs.lastResult ? ' · result: ' + escape(cs.lastResult) : '') + '</div>'
      +   (cooldownRemainSec > 0 ? '<div>cooling down: ' + cooldownRemainSec + 's</div>' : '')
      +   (noInject ? '<div class="th-warn">⚠ ccv 暂无 inject 通道；context 超阈值时仍需手动 /compact</div>' : '')
      + '</div>';
    return ''
      + '<div class="th-form" data-pid="' + pid + '" data-cwd="' + escape(cwd) + '">'
      +   '<label class="th-row">'
      +     '<input type="checkbox" data-th-field="enabled"' + (enabled ? ' checked' : '') + '>'
      +     '<span>enable auto-threshold monitoring</span>'
      +   '</label>'
      +   '<label class="th-row col">'
      +     '<span>auto_compact_at <span class="th-help">(tokens — trigger /compact when context exceeds)</span></span>'
      +     '<input type="number" data-th-field="auto_compact_at" min="1" step="1000" value="' + ac + '">'
      +   '</label>'
      +   '<label class="th-row col">'
      +     '<span>auto_clear_at <span class="th-help">(tokens — trigger /clear when context exceeds; must be > auto_compact_at)</span></span>'
      +     '<input type="number" data-th-field="auto_clear_at" min="1" step="1000" value="' + cle + '">'
      +   '</label>'
      +   meta
      +   '<div class="th-row" style="justify-content:flex-end">'
      +     '<span class="th-err" data-th-err hidden></span>'
      +     '<button class="btn primary" data-th-save data-pid="' + pid + '">Save</button>'
      +   '</div>'
      + '</div>';
  }
  async function handleSaveThreshold(pid) {
    const form = document.querySelector('.th-form[data-pid="' + pid + '"]');
    if (!form) return;
    const cwd = form.dataset.cwd || '';
    const enabledEl = form.querySelector('[data-th-field="enabled"]');
    const acEl  = form.querySelector('[data-th-field="auto_compact_at"]');
    const cleEl = form.querySelector('[data-th-field="auto_clear_at"]');
    const errEl = form.querySelector('[data-th-err]');
    const showErr = (msg) => { if (errEl) { errEl.hidden = false; errEl.textContent = msg; } };
    const hideErr = () => { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } };
    // Frontend completeness check — backend was observed silently accepting
    // partial bodies in an earlier tester run; this guards against that and
    // gives the user immediate feedback either way.
    if (!cwd) { showErr('cwd missing on form'); return; }
    const enabled = !!(enabledEl && enabledEl.checked);
    const ac = acEl ? parseInt(acEl.value, 10) : NaN;
    const cle = cleEl ? parseInt(cleEl.value, 10) : NaN;
    if (!Number.isFinite(ac) || ac <= 0) { showErr('auto_compact_at must be a positive integer'); return; }
    if (!Number.isFinite(cle) || cle <= 0) { showErr('auto_clear_at must be a positive integer'); return; }
    if (cle <= ac) { showErr('auto_clear_at must be greater than auto_compact_at'); return; }
    hideErr();
    const saveBtn = form.querySelector('[data-th-save]');
    const prevLabel = saveBtn ? saveBtn.textContent : 'Save';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      const data = await api('/api/launcher/prefs/compact-threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, enabled, auto_compact_at: ac, auto_clear_at: cle }),
      });
      // Merge the response into the cached status so the form (and any later
      // tab re-render) reflects the saved values immediately, without waiting
      // for the next activity tick to push them.
      const prev = _compactStatusByPid.get(Number(pid)) || {};
      const merged = Object.assign({}, prev, data && data.threshold ? data.threshold : { enabled, auto_compact_at: ac, auto_clear_at: cle });
      _compactStatusByPid.set(Number(pid), merged);
      renderThresholdPanel(pid);
      // The re-render swaps out the save button; re-query and show a brief
      // success cue on the new instance.
      const newBtn = document.querySelector('.th-form[data-pid="' + pid + '"] [data-th-save]');
      if (newBtn) {
        newBtn.disabled = true;
        newBtn.textContent = 'Saved ✓';
        setTimeout(() => { newBtn.disabled = false; newBtn.textContent = 'Save'; }, 1400);
      }
    } catch (e) {
      showErr('save failed: ' + e.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = prevLabel; }
    }
  }

  // Re-apply persisted tab state after a full re-render (called from render()
  // after innerHTML write + details-open restoration).
  function rehydrateTabs() {
    listEl.querySelectorAll('[data-tabs-for]').forEach(container => {
      const pid = Number(container.dataset.tabsFor);
      const st = _tabState.get(pid);
      if (!st) return;
      if (st.activeTab && st.activeTab !== 'urls') {
        container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tabBtn === st.activeTab));
        container.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tabPanel !== st.activeTab);
      }
      for (const t of ['summary', 'edits', 'errors', 'git', 'memory']) {
        if (!st.cache[t]) continue;
        const panel = container.querySelector('[data-tab-panel="' + t + '"]');
        if (panel) renderTabPanel(pid, t, panel, st.cache[t]);
        updateTabBadges(pid, t, st.cache[t]);
      }
      // Threshold panel: no cache, but if it's the active tab we need to
      // re-render the form (the new DOM defaults to the empty placeholder).
      if (st.activeTab === 'threshold') renderThresholdPanel(pid);
    });
  }

  // Tab click + err-group expand + Threshold Save delegation (separate from
  // the action-data delegate so it doesn't slow that path with extra
  // closest() walks).
  listEl.addEventListener('click', (ev) => {
    const tabBtn = ev.target.closest('[data-tab-btn]');
    if (tabBtn) {
      ev.preventDefault();
      const pid = Number(tabBtn.dataset.pid);
      setActiveTab(pid, tabBtn.dataset.tabBtn);
      return;
    }
    const saveBtn = ev.target.closest('[data-th-save]');
    if (saveBtn) {
      ev.preventDefault();
      handleSaveThreshold(saveBtn.dataset.pid);
      return;
    }
    const errHd = ev.target.closest('.err-group .eg-hd');
    if (errHd) {
      ev.preventDefault();
      errHd.parentElement.classList.toggle('open');
    }
  });

  // Auto-refresh active non-URLs tab while its details is open. 5s matches
  // the backend per-instance scan cache, so polling is cheap.
  function refreshOpenTabs() {
    listEl.querySelectorAll('details[open]').forEach(d => {
      const container = d.querySelector('[data-tabs-for]');
      if (!container) return;
      const pid = Number(container.dataset.tabsFor);
      const st = _tabState.get(pid);
      if (!st || st.activeTab === 'urls') return;
      loadTabData(pid, st.activeTab);
    });
  }
  visibilityPoll(refreshOpenTabs, 5000);

  // Drawer toggle (delegate click)
  listEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act="actdrawer"]');
    if (!t) return;
    e.preventDefault();
    const pid = t.dataset.pid;
    const drawer = document.querySelector('[data-act-drawer="' + pid + '"]');
    if (!drawer) return;
    const opening = !drawer.classList.contains('open');
    drawer.classList.toggle('open', opening);
    t.textContent = opening ? '▴' : '▾';
    if (opening) {
      let payload = null;
      try { payload = drawer.dataset.payload ? JSON.parse(drawer.dataset.payload) : null; } catch {}
      if (payload) drawer.innerHTML = renderDrawer(payload);
      else drawer.innerHTML = '<div class="drawer-section"><div class="event-line assistant">loading…</div></div>';
      // Pull fresh state on open
      api('/api/launcher/instances/' + pid + '/activity').then(d => {
        drawer.dataset.payload = JSON.stringify(d);
        if (drawer.classList.contains('open')) drawer.innerHTML = renderDrawer(d);
      }).catch(() => { /* keep stale view */ });
    }
  });

  // 3s poll while page visible
  let _activityTimer = null;
  function startActivityPolling() {
    if (_activityTimer) return;
    _activityTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshActivity();
    }, 3000);
  }
  startActivityPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshActivity();
  });

  // dir browser
  let _curDir = '';
  async function loadDir(path) {
    errEl.hidden = true;
    try {
      const q = path ? '?path=' + encodeURIComponent(path) : '';
      const data = await api('/api/launcher/browse-dir' + q);
      _curDir = data.current; cwdInput.value = data.current;
      const rows = [];
      if (data.parent) rows.push('<div class="row up" data-dir="'+escape(data.parent)+'">.. ('+escape(data.parent)+')</div>');
      for (const d of (data.dirs||[])) {
        rows.push('<div class="row dir" data-dir="'+escape(d.path)+'">'+escape(d.name)+(d.hasGit?'  <span style="color:var(--accent);font-size:10px">git</span>':'')+'</div>');
      }
      treeEl.innerHTML = rows.join('') || '<div style="padding:10px">empty</div>';
    } catch (e) {
      errEl.textContent = 'Browse failed: ' + e.message; errEl.hidden = false;
    }
  }
  treeEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-dir]'); if (!t) return;
    loadDir(t.dataset.dir);
  });
  cwdInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); loadDir(cwdInput.value.trim()); }
  });
  document.getElementById('btn-new').onclick = () => {
    errEl.hidden = true;
    loadDir(_curDir || '');
    loadCcuseProfiles();
    // Pre-fill useWorktree from prefs.worktreeDefault so power users who
    // always want a fresh branch get one without an extra click. Falls back
    // to unchecked on prefs load error.
    const wt = document.getElementById('use-worktree');
    if (wt) {
      api('/api/launcher/prefs').then(p => { wt.checked = !!p.worktreeDefault; }).catch(() => { wt.checked = false; });
    }
    dlg.showModal();
  };
  document.getElementById('btn-cancel').onclick = () => dlg.close();
  document.getElementById('btn-launch').onclick = async () => {
    errEl.hidden = true;
    const cwd = cwdInput.value.trim();
    if (!cwd) { errEl.textContent='Pick a directory first'; errEl.hidden=false; return; }
    const btn = document.getElementById('btn-launch');
    const ccuseSelect = document.getElementById('ccuse-select');
    const ccuseProfile = ccuseSelect ? ccuseSelect.value : '';
    const wtEl = document.getElementById('use-worktree');
    const useWorktree = !!(wtEl && wtEl.checked);
    btn.disabled = true; btn.textContent = useWorktree ? 'Creating worktree…' : 'Launching…';
    try {
      await api('/api/launcher/spawn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, ccuseProfile, useWorktree }) });
      dlg.close(); refresh();
    } catch (e) { errEl.textContent = 'Launch failed: ' + e.message; errEl.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Launch'; }
  };

  // Populate ccuse profile dropdown on dialog open. Cached so we don't refetch
  // every dialog show — the profile list rarely changes within a session.
  let _ccuseProfilesLoaded = false;
  async function loadCcuseProfiles() {
    if (_ccuseProfilesLoaded) return;
    try {
      const data = await api('/api/launcher/prefs');
      const select = document.getElementById('ccuse-select');
      if (!select) return;
      const profiles = data.availableProfiles || [];
      const def = data.defaultCcuseProfile || '';
      // preserve current selection if any
      const cur = select.value;
      // wipe existing options except the placeholder
      while (select.options.length > 1) select.remove(1);
      for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p + (p === def ? '  (默认)' : '');
        select.appendChild(opt);
      }
      if (cur) select.value = cur;
      else if (def) select.value = def;
      _ccuseProfilesLoaded = true;
    } catch { /* graceful: dropdown stays minimal */ }
  }

  // ---- Restart-with-profile dialog ----
  // Click ↻ ccuse on a card → list available profiles as buttons; one click
  // restarts the instance with that profile (SIGTERM + respawn at same cwd).
  // Current profile is rendered disabled with a "current" badge so the user
  // doesn't fire a no-op restart by accident.
  const restartDlg = document.getElementById('restart-dlg');
  const restartTarget = document.getElementById('restart-target');
  const restartList = document.getElementById('restart-profiles');
  const restartErr = document.getElementById('restart-err');
  let _restartCtx = null;
  async function openRestartDlg(ctx) {
    _restartCtx = ctx;
    restartErr.hidden = true;
    restartTarget.textContent = (ctx.name || ('pid ' + ctx.pid)) + '  ·  ' + (ctx.cwd || '');
    restartList.innerHTML = '<div style="color:var(--mute);font-size:12px">loading profiles…</div>';
    restartDlg.showModal();
    try {
      const data = await api('/api/launcher/prefs');
      const profiles = data.availableProfiles || [];
      const def = data.defaultCcuseProfile || '';
      const cur = ctx.current || '';
      const rows = [];
      // "default (no ccuse switch)" option matches the spawn dialog's empty value
      const isDefaultCurrent = cur === '';
      rows.push(renderProfileBtn('', '— 不切 (launcher 默认)', def === '', isDefaultCurrent));
      for (const p of profiles) {
        rows.push(renderProfileBtn(p, p, p === def, p === cur));
      }
      restartList.innerHTML = rows.join('') || '<div style="color:var(--mute);font-size:12px">no ccuse profiles found (检查 ~/.zshrc 的 ccuse 函数)</div>';
    } catch (e) {
      restartList.innerHTML = '';
      restartErr.textContent = 'Failed to load profiles: ' + e.message;
      restartErr.hidden = false;
    }
  }
  function renderProfileBtn(value, label, isDefault, isCurrent) {
    const tag = (isDefault ? ' <span style="color:var(--mute);font-size:10px">默认</span>' : '')
              + (isCurrent ? ' <span style="color:var(--accent);font-size:10px">· 当前</span>' : '');
    const disabled = isCurrent ? 'disabled style="opacity:.5;cursor:default"' : '';
    return '<button class="btn" data-restart-profile="' + escape(value) + '" ' + disabled + ' style="text-align:left;justify-content:flex-start;padding:8px 12px">'
      + escape(label) + tag
      + '</button>';
  }
  document.getElementById('restart-cancel').onclick = () => restartDlg.close();
  restartList.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-restart-profile]');
    if (!btn || btn.disabled || !_restartCtx) return;
    const profile = btn.dataset.restartProfile;
    const label = profile || '默认';
    restartErr.hidden = true;
    // Mark in-flight
    [...restartList.querySelectorAll('button')].forEach(b => b.disabled = true);
    btn.textContent = '⏳ restarting with ' + label + '…';
    try {
      const r = await api('/api/launcher/restart', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pid: _restartCtx.pid, ccuseProfile: profile }),
      });
      restartDlg.close();
      refresh();
      // Brief toast via title for the new card; full UX is just the card flipping over.
    } catch (e) {
      restartErr.textContent = 'Restart failed: ' + e.message;
      restartErr.hidden = false;
      [...restartList.querySelectorAll('button')].forEach(b => b.disabled = false);
    }
  });

  // Page Visibility-aware poller: pauses when tab is hidden (no point polling
  // a backgrounded iOS Safari tab whose connections may already be suspended)
  // and fires once immediately on visibilitychange→visible so the user sees
  // fresh data the moment they return.
  function visibilityPoll(fn, intervalMs) {
    let timer = null;
    function start() { if (timer == null) timer = setInterval(fn, intervalMs); }
    function stop() { if (timer != null) { clearInterval(timer); timer = null; } }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else { fn(); start(); }
    });
    if (!document.hidden) start();
  }

  refresh();
  // 30s polling: new/kill flows refresh immediately on user action, so
  // background polling only catches out-of-band changes (e.g. another tab
  // spawned, hub auto-restarted). Public bandwidth concern beats latency here.
  visibilityPoll(refresh, 30000);

  // ---- T6: top bar stats (H1 cost + H3 5h quota) ----
  const COST_RANGES = ['today', 'week', 'month'];
  const _byRange = { today: null, week: null, month: null };
  let _activeRange = 'today';
  function fmtUSD(n) {
    if (n == null || isNaN(n)) return '—';
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1)    return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }
  function fmtMinutes(min) {
    if (min == null || min <= 0) return '';
    const total = Math.round(min);
    const h = Math.floor(total/60), m = total % 60;
    if (h >= 24) return Math.floor(h/24) + 'd';
    if (h > 0)   return h + 'h' + (m ? ' ' + m + 'm' : '');
    return m + 'm';
  }
  function fmtTokensK(n) {
    if (n == null) return '—';
    if (n >= 1000) return (n/1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }

  function paintCostBlock() {
    const stat = document.getElementById('stat-cost');
    if (!stat) return;
    let anyData = false;
    let anyStale = false;
    for (const r of COST_RANGES) {
      const slot = stat.querySelector('.cost-slot[data-range="' + r + '"] .cost-val');
      if (!slot) continue;
      const data = _byRange[r];
      if (!data) {
        slot.textContent = '—';
        continue;
      }
      // pending=true → backend cold-miss; aggregation in flight. Show "…"
      // instead of a misleading $0 — the next 10s poll picks up the real
      // result once the background scan completes.
      if (data.pending) {
        slot.textContent = '…';
        continue;
      }
      anyData = true;
      slot.textContent = fmtUSD(Number(data.totalUSD || 0));
      if (data.stale) anyStale = true;
    }
    stat.classList.toggle('is-loading', !anyData);
    stat.classList.toggle('is-stale', anyStale);
  }

  function showBreakdown(range) {
    const data = _byRange[range];
    const list = document.getElementById('cp-list');
    document.getElementById('cp-range').textContent = range;
    if (!list) return;
    if (!data) {
      list.innerHTML = '<div class="cp-empty">loading…</div>';
      return;
    }
    if (data.pending) {
      list.innerHTML = '<div class="cp-empty">scanning ' + escape(range) + ' (first load can take a few seconds)…</div>';
      return;
    }
    const breakdown = data.byModelUSD || {};
    const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      list.innerHTML = '<div class="cp-empty">No usage in this range yet.</div>';
      return;
    }
    const rows = entries.map(([m, v]) =>
      '<div class="cp-row"><span class="cp-model" title="' + escape(m) + '">' + escape(m) + '</span><span class="cp-val">' + fmtUSD(v) + '</span></div>'
    ).join('');
    const total = Number(data.totalUSD || 0);
    const totalRow = '<div class="cp-row cp-total"><span class="cp-model">Total · ' + (data.requestCount || 0) + ' req</span><span class="cp-val">' + fmtUSD(total) + '</span></div>';
    list.innerHTML = rows + totalRow;
  }

  // Fetch all three ranges in parallel; backend caches each for 60s so polling
  // every 10s is cheap. Failures on individual ranges leave that slot showing
  // its previous value (or "—" on first miss).
  async function refreshUsage() {
    const results = await Promise.allSettled(
      COST_RANGES.map(r => api('/api/launcher/usage/summary?range=' + r))
    );
    COST_RANGES.forEach((r, i) => {
      if (results[i].status === 'fulfilled') _byRange[r] = results[i].value;
    });
    paintCostBlock();
    showBreakdown(_activeRange);
  }

  async function refreshQuota() {
    const el = document.getElementById('stat-quota');
    if (!el) return;
    const valEl = document.getElementById('stat-quota-val');
    const fillEl = document.getElementById('stat-quota-fill');
    const srcTag = document.getElementById('stat-quota-src');
    try {
      const q = await api('/api/launcher/quota/5h');
      el.classList.remove('is-loading');
      el.classList.toggle('is-stale', !!q.stale);
      el.classList.remove('unavailable');

      if (q.source === 'unavailable') {
        el.classList.add('unavailable');
        valEl.textContent = '数据暂不可用';
        fillEl.style.width = '0%';
        fillEl.className = 'quota-fill';
        srcTag.hidden = true;
        el.title = '5h quota 数据暂不可用\\n' + (q.reason || 'install ccline or wait for usage data');
        return;
      }

      // Color thresholds (T6 spec): <50 green, 50-79 yellow, ≥80 red.
      const pct = Math.max(0, Math.min(100, Number(q.percent || 0)));
      fillEl.style.width = pct.toFixed(1) + '%';
      fillEl.className = 'quota-fill' + (pct >= 80 ? ' bad' : pct >= 50 ? ' warn' : '');

      let valText;
      if (q.used != null && q.limit != null) {
        valText = pct.toFixed(0) + '%  ' + fmtTokensK(q.used) + '/' + fmtTokensK(q.limit);
      } else {
        valText = pct.toFixed(0) + '%';
      }
      valEl.textContent = valText;

      if (q.source === 'jsonl_compute') {
        srcTag.hidden = false;
        srcTag.className = 'src-tag computed';
        srcTag.textContent = '⚠';
        srcTag.title = '推算（基于本地 jsonl，可能不精确）';
      } else {
        srcTag.hidden = true;
        srcTag.removeAttribute('title');
      }

      // Always render the full field set so the user sees the schema; missing
      // values (common for ccline_cache, which omits plan/burn/projection)
      // fall back to "—" instead of being silently skipped.
      const dash = '—';
      const tip = ['source: ' + (q.source || dash)];
      tip.push('plan: ' + (q.plan_name || dash));
      tip.push('burn: ' + (q.burn_rate ? Math.round(q.burn_rate) + ' tok/min' : dash));
      tip.push('to limit: ' + (q.projection_minutes ? fmtMinutes(q.projection_minutes) : dash));
      if (q.reset_at) {
        const remain = (new Date(q.reset_at).getTime() - Date.now()) / 60000;
        tip.push('reset in: ' + (remain > 0 ? fmtMinutes(remain) : dash));
      } else {
        tip.push('reset in: ' + dash);
      }
      el.title = tip.join('\\n');
    } catch {
      el.classList.add('is-loading');
    }
  }

  function refreshTopStats() { refreshUsage(); refreshQuota(); }

  // Hover any slot → preview that range's breakdown in the popover. On
  // mouseleave, fall back to the active range (matters on narrow screens
  // where only one slot is visible).
  const costMultiEl = document.getElementById('cost-multi');
  const statCostEl = document.getElementById('stat-cost');
  if (costMultiEl) {
    costMultiEl.addEventListener('mouseover', (e) => {
      const slot = e.target.closest('.cost-slot');
      if (!slot) return;
      showBreakdown(slot.dataset.range);
    });
  }
  if (statCostEl) {
    statCostEl.addEventListener('mouseleave', () => showBreakdown(_activeRange));
  }
  // Narrow-screen tap-cycle: when only one slot is visible, tapping the
  // multi-row advances _activeRange. body[data-active-range] drives the CSS.
  const NARROW_MQ = window.matchMedia('(max-width: 640px)');
  function setActiveRange(r) {
    _activeRange = r;
    document.body.dataset.activeRange = r;
    showBreakdown(r);
  }
  setActiveRange('today');
  if (costMultiEl) {
    costMultiEl.addEventListener('click', () => {
      if (!NARROW_MQ.matches) return; // wide screens: clicks are no-op
      const idx = COST_RANGES.indexOf(_activeRange);
      setActiveRange(COST_RANGES[(idx + 1) % COST_RANGES.length]);
    });
  }

  refreshTopStats();
  visibilityPoll(refreshTopStats, 10000);

  // ---- T8: tags + filter + keyboard shortcuts ----
  async function loadPrefs() {
    try {
      const data = await api('/api/launcher/prefs');
      _tagsByCwd = (data && data.tags) || {};
      _allTags = Array.isArray(data && data.allTags) ? data.allTags : [];
      // Repaint groups so tag chips reflect the loaded state.
      if (_lastListData.items.length) render(_lastListData.items, _lastListData.history, _lastListData.localCc);
    } catch { /* graceful: tags stay empty */ }
  }

  function applyTagFilter() {
    const tokens = _filterText.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    const groups = listEl.querySelectorAll('.group[data-group-cwd]');
    groups.forEach(g => {
      const cwd = g.dataset.groupCwd || '';
      const tags = (_tagsByCwd[cwd] || []).map(t => t.toLowerCase());
      const matches = tokens.length === 0 || tokens.every(tok => tags.some(t => t.includes(tok)));
      if (matches) g.removeAttribute('data-filter-hidden');
      else g.setAttribute('data-filter-hidden', '');
    });
    // Recount visible groups per Kanban column
    document.querySelectorAll('.kanban-col').forEach(col => {
      const body = col.querySelector('.kanban-body');
      if (!body) return;
      const visible = body.querySelectorAll('.group:not([data-filter-hidden])').length;
      const countEl = col.querySelector('.col-count');
      if (countEl) countEl.textContent = visible;
    });
  }

  const tagFilterEl = document.getElementById('tag-filter');
  if (tagFilterEl) {
    tagFilterEl.addEventListener('input', () => {
      _filterText = tagFilterEl.value || '';
      applyTagFilter();
    });
  }

  // j/n: scroll the next waiting instance into view, briefly flash it.
  // Cycles through all visible (filter-respecting) waiting cards. Priority:
  // waiting_ask (structured question) > waiting_tool (stalled tool) >
  // waiting_input (just finished, awaiting next prompt). If the highest tier
  // has candidates we only cycle within it; else fall back to next tier.
  function jumpToNextWaiting() {
    const cards = [...listEl.querySelectorAll('.instance[data-pid]')].filter(el => {
      if (el.offsetParent === null) return false;
      return ['waiting_ask','waiting_tool','waiting_input'].includes(_statusByPid.get(Number(el.dataset.pid)));
    });
    const tiers = ['waiting_ask','waiting_tool','waiting_input'];
    let candidates = [];
    for (const tier of tiers) {
      candidates = cards.filter(el => _statusByPid.get(Number(el.dataset.pid)) === tier);
      if (candidates.length) break;
    }
    if (!candidates.length) return false;
    _jumpIdx = (_jumpIdx + 1) % candidates.length;
    const target = candidates[_jumpIdx];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    // force reflow so the animation restarts on repeat presses
    void target.offsetWidth;
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
    return true;
  }

  const helpDlg = document.getElementById('help-dlg');
  document.getElementById('btn-help').addEventListener('click', () => helpDlg.showModal());
  document.getElementById('help-close').addEventListener('click', () => helpDlg.close());

  // ---- M2: worktrees top-bar counter + cleanup dialog ----
  const wtBtn = document.getElementById('btn-wt');
  const wtCountEl = document.getElementById('btn-wt-count');
  const wtDlg = document.getElementById('wt-dlg');
  const wtListEl = document.getElementById('wt-list');
  async function refreshWorktreeCounter() {
    try {
      const data = await api('/api/launcher/worktrees');
      const n = (data.worktrees || []).length;
      if (wtCountEl) wtCountEl.textContent = String(n);
      if (wtBtn) wtBtn.hidden = n === 0;
    } catch { /* ignore — keep last known count */ }
  }
  async function openWorktreeDlg() {
    if (!wtDlg) return;
    wtListEl.innerHTML = '<div class="tab-empty">loading…</div>';
    wtDlg.showModal();
    try {
      const data = await api('/api/launcher/worktrees');
      const list = data.worktrees || [];
      if (!list.length) { wtListEl.innerHTML = '<div class="tab-empty">no worktrees</div>'; return; }
      wtListEl.innerHTML = list.map((w, i) => {
        const statusCls = w.alive ? 'alive' : (w.hasUncommitted || w.ahead ? 'dirty' : '');
        const statusTxt = w.alive ? 'alive (pid ' + w.pid + ')' : (w.exists ? 'orphan' : 'missing');
        const dirty = w.hasUncommitted ? '✎' : '';
        const ahead = w.ahead ? ' +' + w.ahead : '';
        return ''
          + '<label class="wt-row">'
          +   '<input type="checkbox" data-wt-path="' + escape(w.path) + '"' + (w.alive ? ' disabled title="stop the instance first"' : '') + '>'
          +   '<span class="wt-branch">' + escape(w.branch || '?') + '</span>'
          +   '<span class="wt-path" title="' + escape(w.path) + '">' + escape(w.path) + '</span>'
          +   '<span class="wt-status ' + statusCls + '">' + escape(statusTxt + ' ' + dirty + ahead) + '</span>'
          + '</label>';
      }).join('');
    } catch (e) {
      wtListEl.innerHTML = '<div class="tab-error">load failed: ' + escape(e.message) + '</div>';
    }
  }
  if (wtBtn) wtBtn.addEventListener('click', openWorktreeDlg);
  if (wtDlg) {
    document.getElementById('wt-close').addEventListener('click', () => wtDlg.close());
    document.getElementById('wt-cleanup').addEventListener('click', async () => {
      const boxes = wtListEl.querySelectorAll('input[type=checkbox][data-wt-path]:checked');
      const paths = Array.from(boxes).map(b => b.dataset.wtPath);
      if (!paths.length) { alert('select at least one worktree'); return; }
      const force = !!document.getElementById('wt-force').checked;
      if (force && !confirm('Force delete ' + paths.length + ' worktree(s)? Uncommitted / unpushed work will be lost.')) return;
      try {
        const r = await api('/api/launcher/worktrees/cleanup', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ paths, force }),
        });
        const msg = ['removed ' + (r.removed || []).length + ' worktree(s)'];
        if ((r.rejected || []).length) msg.push('rejected:\\n' + r.rejected.map(x => '  ' + x.path + ' — ' + x.reason).join('\\n'));
        if (r.needsConfirm) msg.push('\\ntip: check "force" to override the safety gate');
        alert(msg.join('\\n'));
        await openWorktreeDlg();
        refreshWorktreeCounter();
        refresh();
      } catch (e) { alert('Cleanup failed: ' + e.message); }
    });
  }
  visibilityPoll(refreshWorktreeCounter, 10000);
  refreshWorktreeCounter();

  // ---- M4: global Memory drawer (aggregated CLAUDE.md across all instances) ----
  const memDrawer = document.getElementById('mem-drawer');
  const memDrawerBody = document.getElementById('mem-drawer-body');
  const memBtn = document.getElementById('btn-mem');
  document.getElementById('mem-drawer-close').addEventListener('click', () => memDrawer.classList.remove('open'));
  if (memBtn) memBtn.addEventListener('click', async () => {
    if (memDrawer.classList.contains('open')) { memDrawer.classList.remove('open'); return; }
    memDrawer.classList.add('open');
    memDrawerBody.textContent = 'loading…';
    try {
      const data = await api('/api/launcher/claude-md/all');
      const files = data.files || [];
      if (!files.length) { memDrawerBody.textContent = 'no CLAUDE.md across running instances'; return; }
      const grouped = { project: [], parent: [], global: [], rule: [] };
      for (const f of files) (grouped[f.scope] || (grouped[f.scope] = [])).push(f);
      let html = '';
      for (const scope of ['project', 'parent', 'global', 'rule']) {
        for (const f of grouped[scope] || []) {
          const pids = (f.pids || []).slice(0, 3).join(',') + ((f.pids || []).length > 3 ? '+' : '');
          html += '<div class="md-row">'
            + '<span class="md-scope">' + escape(scope) + '</span>'
            + '<span class="md-path" title="' + escape(f.path) + '">' + escape(f.path) + '</span>'
            + '<span class="md-pids">pids:' + escape(pids) + '</span>'
            + '</div>';
        }
      }
      memDrawerBody.innerHTML = html || '<div>(empty)</div>';
    } catch (e) {
      memDrawerBody.textContent = 'failed: ' + e.message;
    }
  });
  // Close drawer on outside click. ignore clicks on the toggle itself.
  document.addEventListener('click', (ev) => {
    if (!memDrawer.classList.contains('open')) return;
    if (memDrawer.contains(ev.target)) return;
    if (memBtn && memBtn.contains(ev.target)) return;
    memDrawer.classList.remove('open');
  });

  // Single global keydown listener — bails out when typing or when a
  // modal/overlay owns the keyboard. Other ESC handlers (term-overlay /
  // ccv-overlay) stay independent so they keep working when this one no-ops.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && helpDlg.open) {
      helpDlg.close();
      ev.preventDefault();
      return;
    }
    const tag = (ev.target && ev.target.tagName || '').toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea' || (ev.target && ev.target.isContentEditable);
    if (isTyping) return;
    if (dlg.open || helpDlg.open) return;
    if (termOverlay.classList.contains('open') || ccvOverlay.classList.contains('open')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    if (ev.key === 'j' || ev.key === 'n') {
      ev.preventDefault();
      jumpToNextWaiting();
    } else if (ev.key === '/') {
      ev.preventDefault();
      if (tagFilterEl) { tagFilterEl.focus(); tagFilterEl.select(); }
    } else if (ev.key === '?') {
      ev.preventDefault();
      helpDlg.showModal();
    }
  });

  loadPrefs();
  // tags only change via user mutation in this UI; no polling needed.

  // ---- Pair notification polling ----
  const pairZone = document.getElementById('pair-zone');
  async function refreshPairs() {
    try {
      const data = await api('/api/launcher/pair-list');
      if (!data.pending || !data.pending.length) { pairZone.innerHTML = ''; return; }
      pairZone.innerHTML = data.pending.map(p => ''
        + '<div class="pair-banner">'
        +   '<div class="pair-info">'
        +     '<span class="pair-code">' + escape(p.code) + '</span> '
        +     '<span class="pair-device">' + escape(p.device) + ' &middot; ' + escape(p.ip) + ' &middot; ' + p.age + 's ago</span>'
        +   '</div>'
        +   '<div class="pair-actions">'
        +     '<button class="approve" data-pair-code="'+escape(p.code)+'">Approve</button>'
        +     '<button class="reject" data-pair-reject="'+escape(p.code)+'">Reject</button>'
        +   '</div>'
        + '</div>'
      ).join('');
    } catch {}
  }
  pairZone.addEventListener('click', async (ev) => {
    const approveBtn = ev.target.closest('[data-pair-code]');
    const rejectBtn = ev.target.closest('[data-pair-reject]');
    if (approveBtn) {
      try {
        await api('/api/launcher/pair-approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: approveBtn.dataset.pairCode }) });
        approveBtn.textContent = 'Approved';
        approveBtn.disabled = true;
        setTimeout(refreshPairs, 1000);
      } catch (e) { alert('Approve failed: ' + e.message); }
    } else if (rejectBtn) {
      try {
        await api('/api/launcher/pair-reject', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: rejectBtn.dataset.pairReject }) });
        refreshPairs();
      } catch {}
    }
  });
  refreshPairs();
  visibilityPoll(refreshPairs, 5000);
})();
</script>
</body>
</html>
`;
