// mycroft.js — Even G2 glasses bridge for the Mycroft assistant.
//
// The glasses' Even Hub web app calls this relay; the relay calls Mycroft's
// per-wearer token API (integration guide, API version of 24 Nov 2026):
//
//   POST https://mycroftlive.mobilityae.com/api/text_input
//   Authorization: Bearer mcg_…        (one token per wearer, 90-day expiry)
//   { "message": "…", "wait": true, "timeout": 20 }
//
// Mycroft only accepts a token from the relay's registered static outbound IPs,
// and answers AS the token's owner (their data, their conversation history).
//
// Wearers are configured with environment variables (Railway → Variables):
//
//   MYCROFT_WEARERS=ceo,niranjan            ids, comma separated
//   MYCROFT_TOKEN_CEO=mcg_…                 that wearer's Mycroft token (secret)
//   MYCROFT_RELAY_KEY_CEO=<long random>     the key that wearer's glasses app
//                                           sends as X-Wearer-Key (secret)
//
// The relay key is how the relay knows WHICH wearer is asking before it spends a
// Mycroft token; an unknown key never reaches Mycroft. Mycroft tokens never leave
// the relay.
//
// Rules from the guide that this module enforces:
//   • Questions and answers are never logged — only status codes and timings.
//   • 401/403 stop that wearer's calls (no retry loop: 10 bad tokens in 15 min
//     block the relay's IP for every wearer) and alert the operator.
//   • 429/503 pass Retry-After back so the app waits before retrying.
//   • One question at a time per wearer.
//   • "PERFLOG …" telemetry is never sent to Mycroft.
//
// Exposed by server.js as:
//   POST /api/mycroft/ask-once   { message }      -> { status, final, text, retryAfter? }
//   POST /api/mycroft/transcribe (audio/wav body) -> { text }
//   POST /api/mycroft/perf       { breakdown }    -> { ok }

const crypto = require('crypto');
const https = require('https');
const tls = require('tls');
const net = require('net');

const MYCROFT_URL = process.env.MYCROFT_TEXT_INPUT_URL || 'https://mycroftlive.mobilityae.com/api/text_input';
const WAIT_TIMEOUT_S = clampInt(process.env.MYCROFT_WAIT_S, 20, 1, 60);
// Guide: client timeout ~10s above `timeout` (first question after a quiet
// period is slower while the person's session starts).
const HTTP_TIMEOUT_MS = clampInt(process.env.MYCROFT_HTTP_TIMEOUT_MS, (WAIT_TIMEOUT_S + 10) * 1000, 2000, 120000);
// After a 401/403 a wearer's token is parked for this long so a bad token can
// never loop into the IP lockout. Fixing the token (redeploy) clears it.
const AUTH_HOLD_MS = clampInt(process.env.MYCROFT_AUTH_HOLD_MS, 10 * 60 * 1000, 0, 24 * 3600 * 1000);

// ── Optional fixed-IP egress proxy ──────────────────────────────────────────
// Mycroft only accepts a token from registered addresses and Railway's outbound
// IPs change, so Mycroft calls can go through a CONNECT proxy with a fixed IP
// (ops/mycroft-egress-proxy). The TLS session to Mycroft runs INSIDE the tunnel,
// so the proxy never sees the token, the question or the answer.
//
//   MYCROFT_PROXY_URL     https://user:pass@host:8443  — the Mycroft admin's proxy
//                         (username/password → Proxy-Authorization: Basic), or
//                         https://<ip>:8443 with MYCROFT_PROXY_SECRET for our own
//                         ops/mycroft-egress-proxy. Unset → connect directly.
//                         It contains a secret: never log or print it.
//   MYCROFT_PROXY_SECRET  optional shared secret, sent as Proxy-Authorization: Bearer
//   MYCROFT_PROXY_CA      optional pinned certificate (PEM; literal "\n" accepted)
//                         for a self-signed proxy. A publicly trusted proxy needs none.
//
// Proxy replies to CONNECT (admin guide): 407 wrong/old URL → stop + alert (20
// wrong tries in 15 min block the relay's address for EVERY wearer); 429 → wait a
// minute; 502/503 → retry shortly. The proxy allows 10 new connections a minute
// and closes idle ones after 2 minutes, so one keep-alive agent is reused.
const PROXY_URL = (process.env.MYCROFT_PROXY_URL || '').trim();
const PROXY_SECRET = (process.env.MYCROFT_PROXY_SECRET || '').trim();
const PROXY_CA = (process.env.MYCROFT_PROXY_CA || '').replace(/\\n/g, '\n').trim();
let proxyAgent = null;
let proxyAuthHeld = 0; // epoch ms until which a 407 pauses ALL Mycroft calls

function makeProxyAgent() {
  const p = new URL(PROXY_URL);
  if (p.protocol !== 'https:') throw new Error('MYCROFT_PROXY_URL must be https://');
  let proxyAuth;
  if (p.username) {
    const creds = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
    proxyAuth = `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`;
  } else if (PROXY_SECRET) {
    proxyAuth = `Bearer ${PROXY_SECRET}`;
  } else {
    throw new Error('MYCROFT_PROXY_URL needs user:password@ or MYCROFT_PROXY_SECRET');
  }
  const proxyHost = p.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = parseInt(p.port || '443', 10);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
  agent.createConnection = (opts, cb) => {
    const targetHost = opts.host || opts.hostname;
    const targetPort = opts.port || 443;
    const proxySock = tls.connect({
      host: proxyHost,
      port: proxyPort,
      ca: PROXY_CA || undefined,
      servername: net.isIP(proxyHost) ? undefined : proxyHost,
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      proxySock.destroy();
      cb(err);
    };
    proxySock.setTimeout(15000, () => fail(new Error('proxy connect timeout')));
    proxySock.once('error', fail);
    proxySock.once('secureConnect', () => {
      proxySock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Authorization: ${proxyAuth}\r\n\r\n`
      );
    });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 8192) fail(new Error('proxy response too large'));
        return;
      }
      proxySock.removeListener('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
      const code = parseInt(statusLine.split(' ')[1], 10);
      if (code !== 200) return fail(Object.assign(new Error(`proxy refused CONNECT: ${code}`), { code: `PROXY_${code}` }));
      proxySock.setTimeout(0);
      proxySock.removeListener('error', fail);
      settled = true;
      const secure = tls.connect({ socket: proxySock, servername: targetHost });
      secure.once('secureConnect', () => cb(null, secure));
      secure.once('error', (e) => cb(e));
    };
    proxySock.on('data', onData);
  };
  return agent;
}

if (PROXY_URL) {
  try {
    proxyAgent = makeProxyAgent();
    console.log(`[mycroft] Mycroft calls go through the egress proxy at ${new URL(PROXY_URL).host}`);
  } catch (e) {
    console.error(`[mycroft] ALERT egress proxy misconfigured: ${e.message} — Mycroft calls will fail until fixed`);
    proxyAgent = 'broken';
  }
}

// POST JSON and return a fetch-like { status, ok, headers.get, text() }.
// Direct → global fetch. Through the proxy → https.request over the tunnel.
function postJson(url, headers, body, signal) {
  if (!proxyAgent) {
    return fetch(url, { method: 'POST', headers, body, signal });
  }
  if (proxyAgent === 'broken') return Promise.reject(Object.assign(new Error('proxy misconfigured'), { code: 'PROXY_CONFIG' }));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers), agent: proxyAgent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : (v == null ? null : v); } },
          text: async () => text,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(body);
  });
}

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ── Wearers ─────────────────────────────────────────────────────────────────
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function loadWearers(env = process.env) {
  const ids = String(env.MYCROFT_WEARERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const up = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const token = (env[`MYCROFT_TOKEN_${up}`] || '').trim();
    const key = (env[`MYCROFT_RELAY_KEY_${up}`] || '').trim();
    if (!token || !key) {
      console.warn(`[mycroft] wearer "${id}" skipped: MYCROFT_TOKEN_${up} and MYCROFT_RELAY_KEY_${up} must both be set`);
      continue;
    }
    if (key.length < 24) {
      console.warn(`[mycroft] wearer "${id}" skipped: MYCROFT_RELAY_KEY_${up} must be at least 24 characters`);
      continue;
    }
    out.push({ id, token, keyHash: sha(key) });
  }
  return out;
}

let WEARERS = loadWearers();
if (!WEARERS.length) console.warn('[mycroft] no glasses wearers configured — /api/mycroft/* will refuse every request');

// Find the wearer for a relay key (constant-time compare against every wearer).
function wearerForKey(key) {
  if (!key || typeof key !== 'string') return null;
  const h = sha(key.trim());
  let found = null;
  for (const w of WEARERS) {
    if (crypto.timingSafeEqual(h, w.keyHash)) found = w;
  }
  return found;
}

// The wearer whose Mycroft is used for the shared daily news briefing.
function newsWearer() {
  const want = (process.env.MYCROFT_NEWS_WEARER || '').trim();
  if (want) return WEARERS.find((w) => w.id === want) || null;
  return WEARERS[0] || null;
}

// ── Per-wearer state: single flight + auth hold ─────────────────────────────
const inFlight = new Set();       // wearer ids with a question being answered
const authHeldUntil = new Map();  // wearer id -> epoch ms

// ── Filler detection ────────────────────────────────────────────────────────
// The backend has answered a fresh data question with a FILLER turn first
// ("Retrieving that data…") then the real answer, marking both "completed", so
// the TEXT is the "not final yet" detector.
const FILLER_RE = new RegExp(
  '(\\.\\.\\.|…)\\s*$' +
  '|^\\s*(let me|i\'?ll|i will|i\'?m|one moment|hold on|give me a)\\b' +
  '|\\b(retriev\\w*|checking|pulling|fetching|gathering|looking (that|it) up|getting that|' +
  'working on (it|that)|recall your|pull (it|that|the data)|can take a moment|' +
  'moment to (pull|recall|gather|check)|take a moment to|search for that)\\b' +
  '|\\b(i\'?ll|i will|i\'?m going to|i am going to|i\'?m gonna|let me)\\b[^.]*\\b(pull|get|fetch|grab|' +
  'check|look|retriev\\w*|find|search|compile?|prepare?|gather|work out|run|schedul|set\\s*up|update|' +
  'generate|put together|bring)\\b' +
  '|\\b(still (running|in progress|processing|pending|loading|going)|in the background)\\b' +
  '|\\bcan\'?t (confirm|provide|give|share|tell|complete|finish)\\b[^.]*\\b(until|yet|once|when)\\b',
  'i'
);
// Guide: an email / call request replies that it is waiting for approval in the
// browser. That reply is FINAL — re-asking would queue the action again.
const APPROVAL_RE = /\b(await\w*|waiting|pending|needs?|requires?)\b[^.]*\b(your )?approv\w*/i;

function isApproval(text) { return !!text && APPROVAL_RE.test(String(text)); }
function looksLikeFiller(text) {
  if (!text) return true;
  if (isApproval(text)) return false;
  return FILLER_RE.test(String(text).trim());
}

// ── Status-only log (no questions, no answers — guide rule) ─────────────────
const LOG = [];
function logEvent(e) {
  LOG.push(Object.assign({ ts: new Date().toISOString() }, e));
  while (LOG.length > 80) LOG.shift();
}
function getLog() { return LOG; }

function extractAnswer(data) {
  if (!data || typeof data !== 'object') return '';
  for (const k of ['text', 'response', 'answer', 'reply']) {
    if (typeof data[k] === 'string' && data[k].trim()) return data[k].trim();
  }
  return '';
}

function retryAfterSeconds(resp, fallback) {
  const v = resp && resp.headers && resp.headers.get && resp.headers.get('retry-after');
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 120);
  return fallback;
}

// Telemetry lines older app builds (≤0.9.1) sent through ask-once. None of them
// is a question; MINUTES carries meeting content, which must not be stored.
const PERFLOG_RE = /^\s*(PERFLOG|IMGLOG|IMULOG|MINUTES)\b/i;

// One synchronous attempt at Mycroft for one wearer.
// Returns { status, final, text, retryAfter? } where status is one of:
//   success | timeout | busy | retry | auth | error
//   final=true  → show `text` and stop polling.
//   auth        → token/IP/permission problem: the app must stop, not retry.
//   retry/busy  → wait `retryAfter` seconds (if given) and ask again.
async function askOnce(wearer, message) {
  if (!wearer) return { status: 'auth', final: true, text: '' };
  const wid = wearer.id;

  if (PERFLOG_RE.test(message)) {
    // Never forward telemetry as a question (guide). Older app builds sent it here.
    logEvent({ kind: 'perf', wearer: wid, len: String(message).length });
    return { status: 'success', final: true, text: '' };
  }

  const held = Math.max(authHeldUntil.get(wid) || 0, proxyAuthHeld);
  if (held > Date.now()) {
    logEvent({ kind: 'ask', wearer: wid, status: 'auth', held: true });
    return { status: 'auth', final: true, text: '' };
  }

  if (inFlight.has(wid)) {
    logEvent({ kind: 'ask', wearer: wid, status: 'busy', local: true });
    return { status: 'busy', final: false, text: '', retryAfter: 2 };
  }
  inFlight.add(wid);

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await postJson(
      MYCROFT_URL,
      { 'Content-Type': 'application/json', Authorization: `Bearer ${wearer.token}` },
      JSON.stringify({ message, wait: true, timeout: WAIT_TIMEOUT_S }),
      controller.signal
    );
    const raw = await resp.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) { /* non-JSON */ }
    const ms = Date.now() - t0;
    const http = resp.status;

    if (http === 401 || http === 403) {
      if (AUTH_HOLD_MS > 0) authHeldUntil.set(wid, Date.now() + AUTH_HOLD_MS);
      // Operator alert. data.message is Mycroft's reason (token expired, address
      // not registered, access not granted…) — it is not business data.
      console.error(`[mycroft] ALERT wearer "${wid}" got HTTP ${http} from Mycroft: ${String(data.message || '').slice(0, 200)} — calls for this wearer paused ${Math.round(AUTH_HOLD_MS / 60000)} min`);
      logEvent({ kind: 'ask', wearer: wid, http, status: 'auth', ms });
      return { status: 'auth', final: true, text: '' };
    }
    if (http === 429 || http === 503) {
      const retryAfter = retryAfterSeconds(resp, http === 429 ? 10 : 5);
      logEvent({ kind: 'ask', wearer: wid, http, status: 'retry', code: data.code || '', retryAfter, ms });
      return { status: 'retry', final: false, text: '', retryAfter };
    }
    if (!resp.ok) {
      logEvent({ kind: 'ask', wearer: wid, http, status: 'error', ms });
      return { status: 'error', final: false, text: '' };
    }

    const status = String(data.status || 'error').toLowerCase();
    if (status === 'busy') {
      logEvent({ kind: 'ask', wearer: wid, http, status, ms });
      return { status: 'busy', final: false, text: '', retryAfter: 3 };
    }
    if (status === 'timeout') {
      // Guide: show "still working, ask again" — don't resend on our own.
      logEvent({ kind: 'ask', wearer: wid, http, status, ms });
      return { status: 'timeout', final: true, text: '' };
    }
    if (status !== 'success') {
      logEvent({ kind: 'ask', wearer: wid, http, status: 'error', ms });
      return { status: 'error', final: false, text: '' };
    }
    const text = extractAnswer(data);
    const final = !!text && !looksLikeFiller(text);
    logEvent({ kind: 'ask', wearer: wid, http, status, final, approval: isApproval(text), len: text.length, ms });
    return { status: 'success', final, text };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const code = String((err && err.code) || '');
    // Proxy-level refusals (never include the proxy URL — it holds a secret).
    if (code === 'PROXY_407') {
      if (AUTH_HOLD_MS > 0) proxyAuthHeld = Date.now() + AUTH_HOLD_MS;
      console.error(`[mycroft] ALERT the Mycroft proxy rejected MYCROFT_PROXY_URL (407) — all glasses calls paused ${Math.round(AUTH_HOLD_MS / 60000)} min; check the variable`);
      logEvent({ kind: 'ask', wearer: wid, status: 'auth', proxy: 407, ms: Date.now() - t0 });
      return { status: 'auth', final: true, text: '' };
    }
    if (code === 'PROXY_429' || code === 'PROXY_502' || code === 'PROXY_503') {
      const retryAfter = code === 'PROXY_429' ? 60 : 5;
      logEvent({ kind: 'ask', wearer: wid, status: 'retry', proxy: parseInt(code.slice(6), 10), retryAfter, ms: Date.now() - t0 });
      return { status: 'retry', final: false, text: '', retryAfter };
    }
    if (code === 'PROXY_403') console.error('[mycroft] ALERT the Mycroft proxy refused the destination (403) — check MYCROFT_TEXT_INPUT_URL');
    logEvent({ kind: 'ask', wearer: wid, status: aborted ? 'timeout' : 'error', ms: Date.now() - t0, err: aborted ? '' : String(code || (err && err.name) || 'fetch') });
    return aborted
      ? { status: 'timeout', final: true, text: '' }
      : { status: 'error', final: false, text: '' };
  } finally {
    clearTimeout(timer);
    inFlight.delete(wid);
  }
}

// A configured wearer by id (e.g. MYCROFT_BRIEF_WEARER, MYCROFT_CUE_WEARER).
function wearerById(id) {
  const want = String(id || '').trim();
  return want ? WEARERS.find((w) => w.id === want) || null : null;
}

// Server-side ask that waits past filler turns, for background jobs (CEO brief,
// meeting cues). Every re-ask shows in that wearer's Mycroft chat, so polls are
// capped low; auth and Mycroft timeouts stop at once (never loop a bad token).
async function askFinal(wearer, message, { maxPolls = 4, delayMs = 3000 } = {}) {
  if (!wearer) return { status: 'auth', text: '' };
  let last = { status: 'error', text: '' };
  for (let i = 0; i < maxPolls; i++) {
    const r = await askOnce(wearer, message);
    last = r;
    if (r.status === 'success' && r.final && r.text) return { status: 'success', text: r.text };
    if (r.status === 'auth' || r.status === 'timeout') return { status: r.status, text: '' };
    if (i === maxPolls - 1) break;
    const wait = r.retryAfter ? r.retryAfter * 1000 : delayMs;
    await new Promise((res) => setTimeout(res, Math.max(wait, delayMs)));
  }
  return { status: last.status === 'success' ? 'filler' : last.status, text: '' };
}

// Test hook: reload wearers / clear state after changing process.env.
function _reset(env) {
  WEARERS = loadWearers(env || process.env);
  inFlight.clear();
  authHeldUntil.clear();
  proxyAuthHeld = 0;
  LOG.length = 0;
}

module.exports = {
  askOnce, askFinal, wearerForKey, wearerById, newsWearer, looksLikeFiller, isApproval,
  logEvent, getLog, _reset,
};
