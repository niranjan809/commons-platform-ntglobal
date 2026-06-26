// mycroft.js — Even G2 glasses bridge for the Mycroft assistant.
//
// Hosted replacement for the local "companion": the glasses' Even Hub web app
// CANNOT set the Origin header Mycroft requires (and is blocked by CORS), so it
// calls this server instead, which injects Origin and reports whether an answer
// is final vs. a filler ("Retrieving that data…") turn. Transcription reuses the
// commons notetaker's hosted Whisper (notes.transcribeAudio).
//
// Exposed by server.js as:
//   POST /api/mycroft/ask-once   { message }      -> { status, final, text }
//   POST /api/mycroft/transcribe (audio/wav body) -> { text }

const MYCROFT_BASE = process.env.MYCROFT_HTTP_BASE || 'https://mycroft.mobilityae.com:8020';
const MYCROFT_ORIGIN = 'https://mycroftlive.mobilityae.com';
const WAIT_TIMEOUT_S = parseInt(process.env.MYCROFT_WAIT_S || '20', 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.MYCROFT_HTTP_TIMEOUT_MS || '24000', 10);

// The backend answers a fresh data question with a FILLER turn first ("Retrieving
// that data…") then the real answer once computed — and marks even fillers
// response_status:"completed", so the TEXT is the real "not final yet" detector.
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
function looksLikeFiller(text) { return !text || FILLER_RE.test(String(text).trim()); }

// In-memory debug log (last 80 events) so we can inspect what the glasses sent:
// what STT transcribed and what Mycroft answered. Exposed via GET /api/mycroft/log.
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

// One synchronous attempt at the Mycroft backend, Origin injected.
// Returns { status, final, text }; final=true means a non-filler answer.
async function askOnce(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(`${MYCROFT_BASE}/api/text_input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: MYCROFT_ORIGIN },
      body: JSON.stringify({ message, wait: true, timeout: WAIT_TIMEOUT_S }),
      signal: controller.signal,
    });
    const raw = await resp.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) { /* non-JSON */ }
    const status = (data.status || (resp.ok ? 'success' : 'error')).toLowerCase();
    const text = status === 'success' ? extractAnswer(data) : '';
    const final = status === 'success' && !!text && !looksLikeFiller(text);
    logEvent({ kind: 'ask', q: String(message).slice(0, 140), status, final, text: text.slice(0, 200) });
    return { status, final, text };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    logEvent({ kind: 'ask', q: String(message).slice(0, 140), status: aborted ? 'timeout' : 'error', final: false, text: '' });
    return { status: aborted ? 'timeout' : 'error', final: false, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askOnce, looksLikeFiller, logEvent, getLog };
