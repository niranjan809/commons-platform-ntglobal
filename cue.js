// cue.js — live topic cues for the G2 glasses ("topic cue agent").
//
// While a wearer has Topic Cues switched on (its own mode in the app since
// v0.9.5 — not part of meeting notes), the app sends each transcribed segment
// here. Every CUE_INTERVAL_MS the relay:
//   1. spots the topic in the last 2 minutes (model; no answer is written here),
//   2. asks DTC's own data first (Mycroft, as MYCROFT_CUE_WEARER or the wearer),
//   3. searches the web ONLY if Mycroft has nothing — keywords only, allow-listed
//      sources only, nothing from the transcript or internal figures leaves,
//   4. drafts a ≤90-character cue from those sources and checks every claim and
//      number against them (grounding.js). Anything unsupported → no cue.
//   5. CUE_MODE=auto (default): a cue that passed every check goes straight to
//      the glasses — no person in the loop. CUE_MODE=assisted: each cue waits
//      on the ops console for approval first.
// The transcript lives in memory only, for the meeting, and is never logged.
const crypto = require('crypto');
const mycroft = require('./mycroft');
const llm = require('./llm');
const grounding = require('./grounding');

const WINDOW_MS = 2 * 60 * 1000;
const IDLE_PURGE_MS = 10 * 60 * 1000;
const STALE_MS = 3 * 60 * 1000; // an approved cue older than this is no longer relevant
const TOPIC_REPEAT_MS = 5 * 60 * 1000;

const cfg = () => ({
  intervalMs: Math.max(5000, parseInt(process.env.CUE_INTERVAL_MS || '30000', 10)),
  mycroftGapMs: Math.max(0, parseInt(process.env.CUE_MYCROFT_GAP_MS || '45000', 10)),
  mode: process.env.CUE_MODE === 'assisted' ? 'assisted' : 'auto',
});

const sessions = new Map(); // wearerId -> session
const cues = []; // recent cues, all wearers (no transcript text in here)
const newId = () => crypto.randomBytes(5).toString('hex');

function session(wearerId) {
  let s = sessions.get(wearerId);
  if (!s) {
    s = { segments: [], lastAnalysisAt: 0, lastMycroftAt: 0, running: false, topics: new Map(), touchedAt: Date.now() };
    sessions.set(wearerId, s);
  }
  return s;
}

function purgeIdle(now = Date.now()) {
  for (const [id, s] of sessions) if (now - s.touchedAt > IDLE_PURGE_MS) sessions.delete(id);
  while (cues.length > 200) cues.shift();
}

// App → relay: one transcribed meeting segment.
function addSegment(wearer, text, now = Date.now()) {
  purgeIdle(now);
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) return { ok: true, queued: false };
  const s = session(wearer.id);
  s.touchedAt = now;
  s.segments.push({ at: now, text: t });
  s.segments = s.segments.filter((x) => now - x.at <= WINDOW_MS);
  const due = now - s.lastAnalysisAt >= cfg().intervalMs;
  if (due && !s.running && llm.available()) {
    s.lastAnalysisAt = now;
    s.running = true;
    analyse(wearer, s)
      .catch((e) => mycroft.logEvent({ kind: 'cue', wearer: wearer.id, status: 'error', err: String(e.code || e.name || 'error') }))
      .finally(() => { s.running = false; });
  }
  return { ok: true, queued: due };
}

function stop(wearerId) {
  sessions.delete(wearerId); // transcript gone
  for (const c of cues) if (c.wearer === wearerId && c.status !== 'delivered') c.status = 'expired';
}

async function spotTopic(transcript) {
  const r = await llm.chat({
    system:
      'You listen to a live business meeting at Dubai Taxi Company (DTC) and decide whether a one-line fact would help ' +
      'the executive right now. You never answer; you only name what to look up.',
    user:
      `LAST 2 MINUTES OF THE MEETING:\n"""\n${transcript}\n"""\n\n` +
      'Reply ONLY JSON: {"cue_worthy": true|false, "topic": "≤8 words", "internal_question": "one question for DTC\'s ' +
      'internal data, or empty", "web_keywords": "≤8 public keywords for a news search: organisations, places, products; ' +
      'NO names of private people, NO figures, NO confidential details"}. cue_worthy is true only when a specific fact ' +
      '(a KPI, a partner, a regulation, a competitor move) is being discussed or asked about.',
    maxTokens: 220,
  });
  return llm.parseJson(r.text);
}

async function draftCue(topic, sources) {
  const r = await llm.chat({
    system: 'You write one heads-up line for smart glasses. Use ONLY the sources. No outside knowledge.',
    user:
      `TOPIC: ${topic}\nSOURCES:\n${sources.map((s, i) => `[${i + 1}] ${s}`).join('\n\n')}\n\n` +
      'Write the single most useful fact for this topic, ≤90 characters, with its number and period if any. ' +
      'Reply ONLY JSON: {"cue": "…"} or {"cue": ""} if the sources do not answer it.',
    maxTokens: 120,
  });
  const j = llm.parseJson(r.text);
  return (j && typeof j.cue === 'string' && j.cue.trim()) || '';
}

const NO_DATA_RE = /\bNO_DATA\b|\b(no|don'?t have|not have|unable to find|couldn'?t find)\b[^.]{0,40}\b(data|information|records?)\b/i;

async function analyse(wearer, s) {
  const transcript = s.segments.map((x) => x.text).join(' ');
  if (transcript.length < 40) return;
  const spot = await spotTopic(transcript);
  if (!spot || !spot.cue_worthy || !spot.topic) {
    mycroft.logEvent({ kind: 'cue', wearer: wearer.id, status: 'no_topic' });
    return;
  }
  const topicKey = String(spot.topic).toLowerCase();
  const seen = s.topics.get(topicKey);
  if (seen && Date.now() - seen < TOPIC_REPEAT_MS) return; // same topic, already cued
  s.topics.set(topicKey, Date.now());

  let sources = [];
  let tag = '';
  let origin = '';

  // 1. Internal first: DTC data via Mycroft (rate-limited; skipped while the
  //    wearer's own question is in flight — that would return "busy").
  const cueWearer = mycroft.wearerById(process.env.MYCROFT_CUE_WEARER) || wearer;
  const q = String(spot.internal_question || '').trim();
  if (q && Date.now() - s.lastMycroftAt >= cfg().mycroftGapMs) {
    s.lastMycroftAt = Date.now();
    const r = await mycroft.askFinal(
      cueWearer,
      `Quick lookup for a live meeting. ${q} Answer in at most 2 short sentences using DTC data, with numbers and ` +
        'their period. If you have no DTC data on this, reply exactly NO_DATA.',
      { maxPolls: 3 }
    );
    if (r.status === 'success' && r.text && !NO_DATA_RE.test(r.text)) {
      sources = [r.text];
      tag = 'DTC';
      origin = 'internal';
    }
  }

  // 2. External only when internal had nothing. Keywords only; no digits.
  if (!sources.length) {
    const kw = String(spot.web_keywords || spot.topic).replace(/\d/g, '').slice(0, 120);
    const r = await llm.chat({
      web: true,
      maxResults: 5,
      maxTokens: 300,
      system: 'Find one recent public fact. Cite your source.',
      user: `Recent news or official information (Dubai / UAE) about: ${kw}. One or two sentences with the source.`,
    });
    const cite = r.citations.find((c) => grounding.isAllowed(c.url) && (c.content || c.title));
    if (cite) {
      sources = [`${cite.title}. ${cite.content}`.slice(0, 4000)];
      tag = `EXT · ${grounding.hostOf(cite.url)}`;
      origin = 'external';
    }
  }
  if (!sources.length) {
    mycroft.logEvent({ kind: 'cue', wearer: wearer.id, status: 'no_source' });
    return;
  }

  // 3. Draft from sources only, then check every claim and number.
  const text = await draftCue(spot.topic, sources);
  if (!text) {
    mycroft.logEvent({ kind: 'cue', wearer: wearer.id, status: 'no_cue' });
    return;
  }
  const v = await grounding.verifyClaims(text, sources);
  if (!v.ok) {
    mycroft.logEvent({ kind: 'cue', wearer: wearer.id, status: 'rejected_by_check' });
    return;
  }
  const auto = cfg().mode === 'auto'; // already grounded + verified above
  cues.push({
    id: newId(),
    wearer: wearer.id,
    topic: String(spot.topic).slice(0, 60),
    text: text.slice(0, 90),
    tag,
    origin,
    source: sources[0].slice(0, 400), // shown to the reviewer; never the transcript
    createdAt: Date.now(),
    status: auto ? 'approved' : 'pending',
  });
  mycroft.logEvent({ kind: 'cue', wearer: wearer.id, status: auto ? 'approved' : 'pending', origin });
}

// Glasses poll: the oldest approved, undelivered, still-fresh cue.
function next(wearerId, now = Date.now()) {
  for (const c of cues) {
    if (c.wearer !== wearerId || c.status !== 'approved') continue;
    if (now - (c.approvedAt || c.createdAt) > STALE_MS) {
      c.status = 'expired';
      continue;
    }
    c.status = 'delivered';
    c.deliveredAt = now;
    return { id: c.id, text: c.text, tag: c.tag };
  }
  return null;
}

function feedback(wearerId, id, useful) {
  const c = cues.find((x) => x.id === id && x.wearer === wearerId);
  if (!c) return false;
  c.feedback = useful ? 'useful' : 'dismissed';
  mycroft.logEvent({ kind: 'cue', wearer: wearerId, status: 'feedback', useful: !!useful, origin: c.origin });
  return true;
}

// Console.
function listForConsole() {
  return cues.slice(-50).reverse().map(({ id, wearer, topic, text, tag, origin, source, createdAt, status, feedback: fb }) =>
    ({ id, wearer, topic, text, tag, origin, source, createdAt, status, feedback: fb || '' }));
}

function decide(id, action, text) {
  const c = cues.find((x) => x.id === id);
  if (!c || c.status !== 'pending') return { ok: false, error: 'not pending' };
  if (action === 'reject') {
    c.status = 'rejected';
    return { ok: true };
  }
  if (action === 'approve') {
    if (text && String(text).trim()) {
      const edited = String(text).trim().slice(0, 90);
      // An edit must still be backed by the source's numbers.
      const bad = grounding.unsupportedNumbers(edited, c.source);
      if (bad.length) return { ok: false, error: 'number not in source: ' + bad.join(', ') };
      c.text = edited;
    }
    c.status = 'approved';
    c.approvedAt = Date.now();
    return { ok: true };
  }
  return { ok: false, error: 'unknown action' };
}

module.exports = {
  addSegment, stop, next, feedback, listForConsole, decide,
  _t: { sessions, cues, analyse, reset: () => { sessions.clear(); cues.length = 0; } },
};
