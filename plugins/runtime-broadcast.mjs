// runtime-broadcast.mjs
// On serverStarted, write ~/.claude/cc-viewer/runtime/<pid>.json describing
// this ccv instance so the launcher hub can discover it via fs.watch.
// On serverStopping (and process exit signals) the file is removed.
// All errors are swallowed silently so cc-viewer's main flow is never blocked.

import { mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

const PREFIX = '[ccv-launcher]';
const RUNTIME_DIR = join(homedir(), '.claude', 'cc-viewer', 'runtime');
const RUNTIME_FILE = join(RUNTIME_DIR, `${process.pid}.json`);

let _written = false;
let _exitHooked = false;

function safeMkdir() {
  try { mkdirSync(RUNTIME_DIR, { recursive: true }); } catch { /* ignore */ }
}

function safeUnlink() {
  try { if (existsSync(RUNTIME_FILE)) unlinkSync(RUNTIME_FILE); } catch { /* ignore */ }
}

function readPackageVersion() {
  // server.js sits at /opt/homebrew/lib/node_modules/cc-viewer/server.js;
  // resolve via process.argv[1] (the ccv CLI shim) instead of import.meta
  // so the path works regardless of where this plugin lives.
  try {
    const cliArg = process.argv[1];
    if (!cliArg) return null;
    let cliPath = cliArg;
    try { cliPath = realpathSync(cliArg); } catch { /* fall back to argv */ }
    // climb dirs until we find package.json with name cc-viewer
    let dir = dirname(cliPath);
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg && pkg.name && String(pkg.name).includes('cc-viewer')) {
          return pkg.version || null;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return null;
}

function deriveProjectName(cwd) {
  try {
    const candidate = basename(cwd || '');
    return candidate || 'unknown';
  } catch { return 'unknown'; }
}

function installExitHooks() {
  if (_exitHooked) return;
  _exitHooked = true;
  const cleanup = () => safeUnlink();
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    try {
      process.on(sig, () => {
        cleanup();
        // Re-raise default behavior: exit with conventional signal code.
        process.exit(sig === 'SIGINT' ? 130 : 143);
      });
    } catch { /* ignore */ }
  }
}

export default {
  name: 'runtime-broadcast',
  hooks: {
    serverStarted: async (ctx) => {
      try {
        if (!ctx || typeof ctx !== 'object') return;
        const cwd = process.cwd();
        const isHub = process.env.CCV_HUB === '1';
        const payload = {
          pid: process.pid,
          port: ctx.port,
          host: ctx.host,
          ip: ctx.ip,
          protocol: ctx.protocol,
          token: ctx.token,
          cwd,
          projectName: deriveProjectName(cwd),
          startedAt: new Date().toISOString(),
          version: readPackageVersion(),
          isHub,
          localUrl: ctx.url || null,
        };
        safeMkdir();
        writeFileSync(RUNTIME_FILE, JSON.stringify(payload, null, 2));
        _written = true;
        installExitHooks();
      } catch (err) {
        console.error(`${PREFIX} runtime-broadcast serverStarted error:`, err && err.message);
      }
    },
    serverStopping: async () => {
      try {
        if (_written) safeUnlink();
      } catch (err) {
        console.error(`${PREFIX} runtime-broadcast serverStopping error:`, err && err.message);
      }
    },
  },
};
