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

const MYCROFT_URL = process.env.MYCROFT_TEXT_INPUT_URL || 'https://mycroftlive.mobilityae.com/api/text_input';
const WAIT_TIMEOUT_S = clampInt(process.env.MYCROFT_WAIT_S, 20, 1, 60);
// Guide: client timeout ~10s above `timeout` (first question after a quiet
// period is slower while the person's session starts).
const HTTP_TIMEOUT_MS = clampInt(process.env.MYCROFT_HTTP_TIMEOUT_MS, (WAIT_TIMEOUT_S + 10) * 1000, 2000, 120000);
// After a 401/403 a wearer's token is parked for this long so a bad token can
// never loop into the IP lockout. Fixing the token (redeploy) clears it.
const AUTH_HOLD_MS = clampInt(process.env.MYCROFT_AUTH_HOLD_MS, 10 * 60 * 1000, 0, 24 * 3600 * 1000);

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

  const held = authHeldUntil.get(wid) || 0;
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
    const resp = await fetch(MYCROFT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wearer.token}` },
      body: JSON.stringify({ message, wait: true, timeout: WAIT_TIMEOUT_S }),
      signal: controller.signal,
    });
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
    logEvent({ kind: 'ask', wearer: wid, status: aborted ? 'timeout' : 'error', ms: Date.now() - t0, err: aborted ? '' : String((err && (err.code || err.name)) || 'fetch') });
    return aborted
      ? { status: 'timeout', final: true, text: '' }
      : { status: 'error', final: false, text: '' };
  } finally {
    clearTimeout(timer);
    inFlight.delete(wid);
  }
}

// Test hook: reload wearers / clear state after changing process.env.
function _reset(env) {
  WEARERS = loadWearers(env || process.env);
  inFlight.clear();
  authHeldUntil.clear();
  LOG.length = 0;
}

module.exports = {
  askOnce, wearerForKey, newsWearer, looksLikeFiller, isApproval,
  logEvent, getLog, _reset,
};
