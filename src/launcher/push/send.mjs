// Compose VAPID JWT + aes128gcm encryption + HTTP POST to a push service.
//
// One function: sendPush(subscription, payloadObj, opts). Subscription shape
// matches PushSubscription.toJSON() — {endpoint, keys: {p256dh, auth}}.
// Returns {statusCode, body, headers} verbatim from the push service so
// callers can branch on 201/410/404/403 etc. Throws only on transport
// errors (DNS, ECONNREFUSED, etc.).

import { signVapidJwt, getPublicKeyB64u } from './vapid.mjs';
import { encryptPayload } from './encrypt.mjs';
import { log } from '../log.mjs';

const DEFAULT_TTL = 86400;     // 24h max retention by push service
const DEFAULT_URGENCY = 'high'; // status transitions want low latency

function audOriginFromEndpoint(endpoint) {
  // VAPID `aud` claim MUST be scheme + host (+ port if non-default), no
  // path. `new URL().origin` already strips the path and trailing slash.
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}`;
}

// Truncate string fields to keep total payload comfortably under push
// service caps (~4 KB after encryption). Mutates a shallow copy.
function clampPayload(obj) {
  const MAX_BODY = 1024;
  const MAX_TITLE = 200;
  const out = { ...obj };
  if (typeof out.title === 'string' && out.title.length > MAX_TITLE) out.title = out.title.slice(0, MAX_TITLE);
  if (typeof out.body === 'string' && out.body.length > MAX_BODY) out.body = out.body.slice(0, MAX_BODY - 1) + '…';
  return out;
}

export async function sendPush(subscription, payloadObj, opts = {}) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('sendPush: subscription missing endpoint/keys');
  }
  const audOrigin = audOriginFromEndpoint(subscription.endpoint);
  const jwt = signVapidJwt(audOrigin);
  const vapidPub = getPublicKeyB64u();

  const clamped = clampPayload(payloadObj || {});
  const plaintext = Buffer.from(JSON.stringify(clamped), 'utf-8');
  const body = encryptPayload(plaintext, subscription.keys.p256dh, subscription.keys.auth);

  const headers = {
    'Authorization': `vapid t=${jwt}, k=${vapidPub}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    'TTL': String(opts.ttl ?? DEFAULT_TTL),
    'Urgency': String(opts.urgency ?? DEFAULT_URGENCY),
  };
  if (opts.topic) headers['Topic'] = String(opts.topic).slice(0, 32);

  let resp;
  try {
    resp = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  } catch (err) {
    log(`[push:send] transport error endpoint=${audOrigin}: ${err.message}`);
    throw err;
  }
  const respBody = await resp.text();
  const respHeaders = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  if (resp.status >= 400) {
    // Body usually has a useful APNs/FCM error code (BadJwtToken,
    // UnauthorizedRegistration, …). Snip to ~200 chars; the full body is
    // returned to the caller for richer logging if needed.
    log(`[push:send] status=${resp.status} aud=${audOrigin} body=${respBody.slice(0, 200)}`);
  } else {
    log(`[push:send] status=${resp.status} aud=${audOrigin}`);
  }
  return { statusCode: resp.status, body: respBody, headers: respHeaders };
}
