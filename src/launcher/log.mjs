// Logging helpers shared across launcher modules.
//
// `log` writes a prefixed line to stderr (captured by launchd's stderr.log);
// use for human-readable status. `jlog` writes one structured JSON record per
// line on stderr; use for events that ops/monitoring should be able to parse
// (ws-shell-spawn, ws-shell-cap-hit, healthz, etc).

export const PREFIX = '[ccv-launcher]';

export function log(...args) {
  console.error(PREFIX, ...args);
}

export function jlog(event, fields = {}) {
  try {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  } catch { /* ignore stringify failures */ }
}
