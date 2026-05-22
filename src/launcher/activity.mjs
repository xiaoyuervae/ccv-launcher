// Activity-probe primitives: jsonl tailing, per-peer log-file picking, entry
// parsing, status derivation. These are the building blocks consumed by the
// `getInstanceActivity` composer (kept in plugins/launcher.mjs) which combines
// them with usage / claudemd / prefs data to produce the per-card payload.
//
// Background: each ccv writes its session log under
//   LOG_DIR/<projectName>/<projectName>_<ts>.jsonl
// where every line is one Anthropic API request (with response or partial
// response). We tail the most recent log file for a given instance and derive
// a high-level "what is it doing" from the last few entries.

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.claude', 'cc-viewer');
const ACTIVITY_TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVITY_TAIL_MAX_BYTES = 16 * 1024 * 1024;

// Match ccv's projectName normalization (interceptor.js:314): replace anything
// outside [a-zA-Z0-9_\-\.] with '_'. We need this because runtime-broadcast.mjs
// records the raw basename(cwd) (e.g. "fbi报表") while ccv writes logs under the
// normalized name ("fbi__"); finding the active log file requires matching the
// dir on disk, not the raw basename.
export function ccvProjectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  return basename(cwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

export function findActiveLogFile(projectName, afterMs) {
  if (!projectName) return null;
  const dir = join(LOG_DIR, projectName);
  if (!existsSync(dir)) return null;
  let candidates;
  try {
    candidates = readdirSync(dir)
      .filter(f => /^.+_\d{8}_\d{6}\.jsonl$/.test(f))
      .map(f => {
        const fp = join(dir, f);
        try {
          const st = statSync(fp);
          return { path: fp, mtime: st.mtimeMs, size: st.size };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return null; }
  if (!candidates.length) return null;
  // Most likely the most recently modified file is the one this pid writes to.
  // afterMs (instance startedAt) is a tie-breaker but not a hard filter — log
  // file timestamps are in filename only, mtime tracks last write.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

// Parse "<projectName>_YYYYMMDD_HHMMSS.jsonl" → ms since epoch (local time).
// ccv writes filenames with the timestamp of the first request that lands in
// that file, so this is a stable proxy for "when this session started".
export function parseJsonlFilenameTime(filePath) {
  const m = basename(filePath).match(/_(\d{8})_(\d{6})\.jsonl$/);
  if (!m) return 0;
  const d = m[1], t = m[2];
  const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`;
  // Date.parse without timezone treats as local — which matches ccv's filename.
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Pick the jsonl that represents each peer's currently-active session.
//
// Background: a ccv pid often goes through several jsonl files during its
// lifetime — every /clear or fresh `claude` launch starts a new file. So the
// "first file made after startedAt" assumption is fragile: it pins a peer to
// its earliest session forever, and once the user starts a second session the
// status badge goes stale ("idle 5h ago" while the new session is actively
// writing).
//
// Algorithm:
//   1. Sort peers by startedAt ASC; each peer owns the fname-time window
//      [startedAt - slack, next_peer.startedAt - slack). The newest peer's
//      window extends to +Infinity.
//   2. Walk peers newest-first (so the freshest peer claims its currently
//      active file first).
//   3. For each peer, among unclaimed candidates within its window, pick the
//      one with the HIGHEST mtime — that's the file currently being written
//      to. Falls back to "most recent file before startedAt" (resumed
//      session) or "most recent unclaimed file anywhere" if the window is
//      empty.
const PEER_PICKER_SLACK_MS = 60_000;
export function pickInstanceLogs(projectName, instances) {
  if (!projectName || !instances.length) return new Map();
  const dir = join(LOG_DIR, projectName);
  if (!existsSync(dir)) return new Map();
  let candidates;
  try {
    candidates = readdirSync(dir)
      .filter(f => /^.+_\d{8}_\d{6}\.jsonl$/.test(f))
      .map(f => {
        const fp = join(dir, f);
        try {
          const st = statSync(fp);
          return { path: fp, mtime: st.mtimeMs, size: st.size, fnameMs: parseJsonlFilenameTime(fp) };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return new Map(); }
  if (!candidates.length) return new Map();

  const sortedAsc = [...instances].sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return ta - tb;
  });
  const windows = sortedAsc.map((p, i) => {
    const start = p.startedAt ? new Date(p.startedAt).getTime() : 0;
    const next = i + 1 < sortedAsc.length
      ? (sortedAsc[i + 1].startedAt ? new Date(sortedAsc[i + 1].startedAt).getTime() : Infinity)
      : Infinity;
    return { pid: p.pid, start, next };
  });

  const taken = new Set();
  const result = new Map();
  // Newest peer first so it gets its currently-active file.
  for (let i = windows.length - 1; i >= 0; i--) {
    const { pid, start, next } = windows[i];
    const remaining = candidates.filter(c => !taken.has(c.path));
    if (!remaining.length) break;

    let pick = null;
    if (start > 0) {
      const inWindow = remaining.filter(c =>
        c.fnameMs >= start - PEER_PICKER_SLACK_MS &&
        c.fnameMs < next - PEER_PICKER_SLACK_MS
      );
      if (inWindow.length) {
        // Currently active = most recently written.
        inWindow.sort((a, b) => b.mtime - a.mtime);
        pick = inWindow[0];
      } else {
        // No new file in window → this peer must have resumed an older session.
        const before = remaining.filter(c => c.fnameMs < start - PEER_PICKER_SLACK_MS);
        if (before.length) {
          before.sort((a, b) => b.fnameMs - a.fnameMs);
          pick = before[0];
        }
      }
    }
    if (!pick) {
      const sorted = [...remaining].sort((a, b) => b.mtime - a.mtime);
      pick = sorted[0];
    }
    if (pick) {
      taken.add(pick.path);
      result.set(pid, pick);
    }
  }

  return result;
}

export function findActiveLogFileForInstance(projectName, instance, peers) {
  const peerList = (peers && peers.length) ? peers : [instance];
  const map = pickInstanceLogs(projectName, peerList);
  return map.get(instance.pid) || null;
}

export function tailJsonlEntries(filePath, maxBytes = ACTIVITY_TAIL_BYTES) {
  let st;
  try { st = statSync(filePath); } catch { return { entries: [], size: 0, mtime: 0 }; }
  if (st.size === 0) return { entries: [], size: 0, mtime: st.mtimeMs };
  // Adaptive grow: ccv jsonl entries inflate with conversation history (each
  // request includes the full messages array), so a single record can be 500KB+
  // late in a session. If the first window yields zero parseable entries, try
  // doubling up to ACTIVITY_TAIL_MAX_BYTES before giving up.
  let window = Math.min(maxBytes, st.size);
  const cap = Math.min(ACTIVITY_TAIL_MAX_BYTES, st.size);
  for (;;) {
    const start = st.size - window;
    let fd;
    try {
      fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, start);
      closeSync(fd);
      let text = buf.toString('utf-8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl > -1) text = text.slice(nl + 1);
      }
      const entries = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* truncated tail */ }
      }
      if (entries.length || window >= cap) {
        return { entries, size: st.size, mtime: st.mtimeMs };
      }
      // Nothing parseable in this window — usually means we landed mid-record.
      // Double the window and retry.
      window = Math.min(window * 2, cap);
    } catch (err) {
      try { if (fd != null) closeSync(fd); } catch {}
      return { entries: [], size: st.size, mtime: st.mtimeMs };
    }
  }
}

export function truncate(s, n = 80) {
  if (s == null) return '';
  const str = String(s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function lastUserPrompt(entry) {
  // body.messages is [{role, content: string | [{type, text, ...}]}, ...]
  // Walk back to find the last meaningful user-typed text — skipping
  // system-reminders, tool_result envelopes, slash-cmd wrappers, and the
  // compact-resume preamble (same framing rules as firstUserPrompt).
  const msgs = entry?.body?.messages;
  if (!Array.isArray(msgs)) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') {
      const cleaned = stripUserPromptFraming(c);
      if (cleaned) return cleaned;
      continue;
    }
    if (!Array.isArray(c)) continue;
    // Iterate blocks in REVERSE so the most recent text in this user message
    // wins (e.g. user appended an interrupt/clarification after a tool_use).
    for (let j = c.length - 1; j >= 0; j--) {
      const block = c[j];
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const cleaned = stripUserPromptFraming(block.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// Walk back through tail entries until we find a non-empty user prompt — the
// latest single entry may only have tool_result blocks (during agentic tool
// loops), in which case we want the prompt that kicked off this work.
export function lastUserPromptAcrossEntries(entries) {
  if (!Array.isArray(entries)) return '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = lastUserPrompt(entries[i]);
    if (text) return text;
  }
  return '';
}

export function firstUserPrompt(entry) {
  // First non-system-reminder user message — used as the "what was this
  // conversation originally about" title on the card.
  const msgs = entry?.body?.messages;
  if (!Array.isArray(msgs)) return '';
  for (const m of msgs) {
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') {
      const cleaned = stripUserPromptFraming(c);
      if (cleaned) return cleaned;
      continue;
    }
    if (!Array.isArray(c)) continue;
    // A user msg can have many text blocks: [system-reminder, system-reminder,
    // ..., REAL PROMPT, ...]. Check every text block in order — first one that
    // survives framing strip + skill-metadata filter wins.
    for (const block of c) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const cleaned = stripUserPromptFraming(block.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// Strip CC's framing wrappers around the actual user prompt:
//   <system-reminder>...</system-reminder>           — system-injected context, not user input
//   <command-name>...</command-name>                  — slash command marker
//   <command-message>...</command-message>            — slash command body
//   <command-args>...</command-args>                  — slash command args
//   <local-command-caveat>...</local-command-caveat>  — "DO NOT respond to these messages..." wrapper
//   <local-command-stdout>...</local-command-stdout>  — slash command stdout echo
//   <session>...</session>                            — CC's session-restore wrapper around the original prompt
//   "This session is being continued..."              — compact-resume preamble (auto-generated summary)
// Returns '' if nothing meaningful is left.
export function stripUserPromptFraming(text) {
  if (!text) return '';
  let t = String(text);
  // Drop full-message system-reminder blocks
  if (/^<system-reminder>/.test(t)) return '';
  // Unwrap <session>...</session> — keep inner content (the original prompt)
  const sessionMatch = t.match(/^<session>\s*([\s\S]*?)\s*<\/session>\s*$/);
  if (sessionMatch) t = sessionMatch[1];
  // Drop command framing entirely (these are slash commands, not freeform prompts)
  if (/^<command-(name|message|args)>/.test(t)) return '';
  // Drop local-command wrappers — caveat is pure boilerplate, stdout is slash-cmd echo
  if (/^<local-command-(caveat|stdout)>/.test(t)) return '';
  // Drop the compact-resume preamble. CC inserts this auto-generated summary as a
  // user-role text block when /compact runs; the real first prompt of the resumed
  // session is in a later block.
  if (/^This session is being continued from a previous conversation/.test(t)) return '';
  // Drop CC skill-activation markers — these are injected as user-role text when
  // a skill loads (e.g. "Base directory for this skill: /path/to/skill ...").
  // Not a real user prompt.
  if (/^Base directory for this skill\b/i.test(t)) return '';
  // Drop bare tool_use_result envelopes that CC reformats as user text
  if (/^<tool_use_result\b/.test(t) || /^<\/?tool_use\b/.test(t)) return '';
  return t.trim();
}

// File-level cache of first user prompt — one read per session log file. Cleared
// when file mtime changes (rare for the first line of an append-only jsonl).
const _firstPromptCache = new Map(); // filePath -> { mtime, size, text }
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024; // first jsonl line can be 100s of KB (system-reminders + skills)

export function readFirstUserPrompt(filePath) {
  let st;
  try { st = statSync(filePath); } catch { return ''; }
  if (st.size === 0) return '';
  const cached = _firstPromptCache.get(filePath);
  if (cached && cached.mtime === st.mtimeMs) return cached.text;
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const len = Math.min(st.size, FIRST_LINE_MAX_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    closeSync(fd);
    const nl = buf.indexOf(0x0a);
    const lineBuf = nl >= 0 ? buf.slice(0, nl) : buf;
    let text = '';
    try {
      const obj = JSON.parse(lineBuf.toString('utf-8'));
      text = firstUserPrompt(obj);
    } catch { /* truncated first line — skip */ }
    _firstPromptCache.set(filePath, { mtime: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    try { if (fd != null) closeSync(fd); } catch {}
    return '';
  }
}

// Find the latest tool_use block in the response of the latest entry, and
// pair it with the latest tool_result across entries to decide if a tool is
// still running on the agent's side.
export function inspectToolFlow(entries) {
  if (!entries.length) return { lastToolUse: null, hasMatchingResult: false };
  let lastToolUse = null;
  // Search entries in reverse
  for (let i = entries.length - 1; i >= 0 && !lastToolUse; i--) {
    const e = entries[i];
    const content = e?.response?.body?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b?.type === 'tool_use') {
        lastToolUse = { id: b.id, name: b.name, input: b.input, ts: e.timestamp };
        break;
      }
    }
  }
  if (!lastToolUse) return { lastToolUse: null, hasMatchingResult: false };
  // tool_result lives in the *next* request's body.messages[*].content[*]
  let hasMatchingResult = false;
  for (const e of entries) {
    if (!e?.timestamp || e.timestamp <= lastToolUse.ts) continue;
    const msgs = e?.body?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!Array.isArray(m?.content)) continue;
      for (const block of m.content) {
        if (block?.type === 'tool_result' && block.tool_use_id === lastToolUse.id) {
          hasMatchingResult = true;
          break;
        }
      }
      if (hasMatchingResult) break;
    }
    if (hasMatchingResult) break;
  }
  return { lastToolUse, hasMatchingResult };
}

export function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return name || 'tool';
  if (name === 'Bash') return `Bash: ${truncate(input.command, 60)}`;
  if (name === 'Edit' || name === 'Write') return `${name}: ${truncate(input.file_path, 60)}`;
  if (name === 'Read') return `Read: ${truncate(input.file_path, 60)}`;
  if (name === 'Grep') return `Grep: ${truncate(input.pattern, 60)}`;
  if (name === 'Glob') return `Glob: ${truncate(input.pattern, 60)}`;
  if (name === 'WebFetch') return `WebFetch: ${truncate(input.url, 60)}`;
  if (name === 'WebSearch') return `WebSearch: ${truncate(input.query, 60)}`;
  if (name === 'TodoWrite') return `TodoWrite (${(input.todos || []).length} items)`;
  if (name === 'Task' || name === 'Agent') return `Task: ${truncate(input.description || input.prompt, 60)}`;
  // generic
  const firstStr = Object.values(input).find(v => typeof v === 'string');
  return firstStr ? `${name}: ${truncate(firstStr, 60)}` : name;
}

export function summarizeEntry(e) {
  // Used in drawer "recent events" list
  const ts = e?.timestamp || '';
  const userPrompt = lastUserPrompt(e);
  const respContent = e?.response?.body?.content;
  let assistantText = '';
  let toolUse = null;
  if (Array.isArray(respContent)) {
    for (const b of respContent) {
      if (b?.type === 'text' && !assistantText) assistantText = b.text || '';
      if (b?.type === 'tool_use' && !toolUse) toolUse = b;
    }
  }
  return {
    ts,
    inProgress: !!e?.inProgress,
    durationMs: e?.duration || 0,
    userPrompt: truncate(userPrompt, 120),
    assistantText: truncate(assistantText, 120),
    toolUse: toolUse ? summarizeToolInput(toolUse.name, toolUse.input) : '',
  };
}

export function ageString(ms) {
  if (ms < 0) return 'just now';
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function fetchPendingAsks(instance) {
  // Query the instance's own /api/pending-asks (in-memory state lives there).
  if (!instance?.port || !instance?.token) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const resp = await fetch(`http://127.0.0.1:${instance.port}/api/pending-asks?token=${instance.token}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    const asks = Array.isArray(data?.pendingAsks) ? data.pendingAsks : [];
    // ccv writes pending asks to a shared on-disk store (~/.claude/cc-viewer/ask-store.json),
    // so every running ccv echoes the same disk entries via /api/pending-asks. The owning
    // ccv (the one whose ask-bridge hook captured the AskUserQuestion) marks it source='memory'.
    // Filtering to source='memory' avoids showing the same waiting-for-answer badge on every
    // sibling ccv at the same cwd. Falls back to including untagged entries for older ccv
    // versions that don't set source.
    return asks.filter(a => !a.source || a.source === 'memory');
  } catch { return []; }
}

export function deriveStatus({ entries, pendingAsks, fileMtime }) {
  const now = Date.now();
  if (pendingAsks.length > 0) {
    const first = pendingAsks[0];
    const qHeader = first?.questions?.[0]?.header || first?.questions?.[0]?.question || 'question';
    return {
      status: 'waiting_ask',
      label: `⏳ awaiting answer: ${truncate(qHeader, 40)}${pendingAsks.length > 1 ? ` (+${pendingAsks.length - 1})` : ''}`,
    };
  }
  if (!entries.length) {
    return { status: 'no_session', label: '⚫ no session yet' };
  }
  const latest = entries[entries.length - 1];
  const latestMs = latest?.timestamp ? new Date(latest.timestamp).getTime() : fileMtime;
  const age = now - latestMs;
  // in-flight Claude API call
  if (latest?.inProgress && age < 5 * 60_000) {
    // streaming; if we already see a tool_use in partial response, surface it
    const partialContent = latest?.response?.body?.content;
    if (Array.isArray(partialContent)) {
      const toolUse = partialContent.find(b => b?.type === 'tool_use');
      if (toolUse) return { status: 'tool_running', label: `🛠 ${summarizeToolInput(toolUse.name, toolUse.input)}` };
    }
    return { status: 'thinking', label: '🔵 thinking…' };
  }
  // Tool launched but no result yet → either claude-code is running it, or
  // the run is gated on the user (permission prompt, long-running cmd they're
  // ignoring). Use age to split: < 30s = working, ≥ 30s = waiting (most slow
  // tools that legitimately take >30s do so because they're waiting on
  // human input — permission approval, foreground bash, etc).
  const { lastToolUse, hasMatchingResult } = inspectToolFlow(entries);
  if (lastToolUse && !hasMatchingResult) {
    const toolAge = now - new Date(lastToolUse.ts).getTime();
    if (toolAge < 30_000) {
      return { status: 'tool_running', label: `🛠 ${summarizeToolInput(lastToolUse.name, lastToolUse.input)}` };
    }
    if (toolAge < 30 * 60_000) {
      return { status: 'waiting_tool', label: `⏸ ${summarizeToolInput(lastToolUse.name, lastToolUse.input)} · ${ageString(toolAge)}` };
    }
    // ≥ 30 min unanswered → treat as abandoned, fall through to idle
  }
  // Assistant finished its turn (text response, no pending tool) and is
  // waiting for the next user prompt. Within 10 min = actively waiting;
  // beyond that = user walked away → idle.
  const lastTextTs = findRecentAssistantTextTs(entries);
  if (lastTextTs) {
    const textAge = now - lastTextTs;
    if (textAge < 10 * 60_000) {
      return { status: 'waiting_input', label: `⌨ awaiting prompt · ${ageString(textAge)}` };
    }
  }
  return { status: 'idle', label: `🟢 idle ${ageString(age)}` };
}

// Walk entries backward. Skip entries with empty response.body.content (cache /
// placeholder writes). Return the timestamp of the most recent assistant
// response that contains user-facing text, BUT only if we didn't encounter a
// tool_use first (a later tool_use means the model is still mid-task, not
// waiting on the human).
export function findRecentAssistantTextTs(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const content = entries[i]?.response?.body?.content;
    if (!Array.isArray(content) || !content.length) continue;
    if (content.some(b => b?.type === 'tool_use')) return null;
    if (content.some(b => b?.type === 'text' && (b.text || '').trim())) {
      const ts = entries[i].timestamp;
      return ts ? new Date(ts).getTime() : null;
    }
  }
  return null;
}

// True when the entry is an assistant response containing user-facing text
// AND no still-pending tool_use (i.e. claude finished talking; the next move
// is the user's). Currently unused but kept for symmetry with the walk-back
// variant; safe to remove if a future cleanup confirms nothing imports it.
export function isAssistantTextEnd(entry) {
  const content = entry?.response?.body?.content;
  if (!Array.isArray(content)) return false;
  let hasText = false;
  for (const b of content) {
    if (b?.type === 'tool_use') return false;
    if (b?.type === 'text' && (b.text || '').trim()) hasText = true;
  }
  return hasText;
}
