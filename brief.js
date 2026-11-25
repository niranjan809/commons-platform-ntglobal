// brief.js — CEO "critical happenings" brief for the G2 glasses.
//
// Built twice a day (BRIEF_TIMES, Dubai time), held as a DRAFT for review on
// the ops console, then published BRIEF_REVIEW_MIN minutes later — tagged
// "reviewed" if someone approved it, "unreviewed" otherwise. The glasses read
// the published brief from GET /api/mycroft/brief.
//
// What goes in, and only if a rule fires (everything else goes to "more"):
//   • KPIs from Mycroft (yesterday vs same day last week) — off by ≥ threshold,
//     or any safety incident. Numbers come straight from Mycroft's reply.
//   • New posts on DTC's official Media Zone (from news.js).
//   • Regulator / competitor news found by web search — kept only when it cites
//     an allow-listed source and every number appears in that source.
//   • Decisions added by the CEO's office on the console.
// A source that fails is reported in the brief, never papered over with old data.
//
// Env: BRIEF_TIMES ("07:00,13:00"), BRIEF_REVIEW_MIN (30), BRIEF_THRESHOLD_PCT
//      (10), BRIEF_KPIS (comma list), MYCROFT_BRIEF_WEARER (default: news wearer),
//      BRIEF_BOOT_DELAY_MS (60000; first build after a restart), BRIEF_WEB (1).
const axios = require('axios');
const crypto = require('crypto');
const mycroft = require('./mycroft');
const g2news = require('./news');
const llm = require('./llm');
const grounding = require('./grounding');

const MAX_CRITICAL = 5;
const DEFAULT_KPIS = ['Trips', 'Fleet on road', 'Revenue', 'App bookings', 'Customer complaints', 'Safety incidents'];

const cfg = () => ({
  times: (process.env.BRIEF_TIMES || '07:00,13:00').split(',').map((s) => s.trim()).filter(Boolean),
  reviewMin: Math.max(0, parseInt(process.env.BRIEF_REVIEW_MIN || '30', 10)),
  threshold: Math.max(1, parseFloat(process.env.BRIEF_THRESHOLD_PCT || '10')),
  kpis: (process.env.BRIEF_KPIS || '').split(',').map((s) => s.trim()).filter(Boolean),
  web: process.env.BRIEF_WEB !== '0',
});

// Dubai is UTC+4 all year (no DST).
function dubaiNow(ms = Date.now()) {
  const iso = new Date(ms + 4 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

const newId = () => crypto.randomBytes(5).toString('hex');

// ── KPIs from Mycroft ────────────────────────────────────────────────────────
function parseNum(s) {
  const m = /(-?\d[\d,]*(?:\.\d+)?)\s*([kmb])?/i.exec(String(s || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Number.isFinite(n) ? n * mult : null;
}

// "Metric | yesterday | last week" lines → [{ metric, now, prev, nowText, prevText }]
function parseKpiLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split('|').map((s) => s.trim());
    // Drop a list marker ("1. ", "- ", "• ", "**") from the metric name only.
    parts[0] = parts[0].replace(/^(?:\d+[.)]\s+|[-*•]+\s*)/, '').replace(/\*/g, '').trim();
    if (parts.length < 3 || !parts[0] || /^metric$/i.test(parts[0])) continue;
    const now = parseNum(parts[1]);
    const prev = parseNum(parts[2]);
    if (now == null) continue; // "n/a" — Mycroft has no figure; never guess one
    out.push({ metric: parts[0].slice(0, 40), now, prev, nowText: parts[1].slice(0, 20), prevText: parts[2].slice(0, 20) });
  }
  return out;
}

function kpiItems(rows, threshold) {
  const critical = [];
  const more = [];
  for (const r of rows) {
    const safety = /incident|accident|outage|injur|fatal/i.test(r.metric);
    const pct = r.prev ? ((r.now - r.prev) / Math.abs(r.prev)) * 100 : null;
    const pctTxt = pct == null ? '' : `${pct >= 0 ? '+' : ''}${Math.round(pct)}%`;
    const item = {
      id: newId(),
      kind: 'kpi',
      title:
        safety && r.now > 0
          ? `${r.metric}: ${r.nowText} yesterday`
          : `${pct != null && pct < 0 ? '▼' : '▲'} ${r.metric} ${pctTxt} vs last wk (${r.nowText})`,
      detail: `Yesterday ${r.nowText}; same day last week ${r.prevText}.`,
      source: 'DTC ops (Mycroft)',
    };
    if ((safety && r.now > 0) || (pct != null && Math.abs(pct) >= threshold)) critical.push(item);
    else more.push({ ...item, title: `${r.metric} ${r.nowText}${pctTxt ? ` (${pctTxt} vs last wk)` : ''}` });
  }
  return { critical, more };
}

async function fetchKpis(wearer, kpis) {
  const prompt =
    `For DTC, give yesterday's value and the value for the same weekday last week for each metric: ${kpis.join(', ')}. ` +
    'Reply ONLY with one line per metric in exactly this form: Metric | yesterday | last week. ' +
    'Use plain numbers (k/m allowed). Write n/a when you do not have the figure. No other text.';
  const r = await mycroft.askFinal(wearer, prompt, { maxPolls: 4 });
  if (r.status !== 'success') return { rows: [], error: `ops data unavailable (${r.status})` };
  const rows = parseKpiLines(r.text);
  return rows.length ? { rows, error: '' } : { rows: [], error: 'ops data unavailable (no figures)' };
}

// ── DTC official news (new since the last brief) ─────────────────────────────
const seenNews = new Set();
function dtcNewsItems() {
  const items = (g2news.get().items || []).filter((i) => i && i.detail === 'DTC official' && i.url);
  const fresh = items.filter((i) => !seenNews.has(i.url));
  for (const i of items) seenNews.add(i.url);
  return fresh.map((i) => ({
    id: newId(),
    kind: 'news',
    title: `DTC news: ${i.title}`.slice(0, 90),
    detail: i.title.length > 80 ? i.title : 'New on the DTC Media Zone.',
    source: 'dubaitaxi.ae',
    url: i.url,
  }));
}

// ── Regulator / competitor news (web, cited, allow-listed) ────────────────────
async function pageText(url) {
  try {
    const r = await axios.get(url, { timeout: 10000, maxContentLength: 2e6, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CommonsBrief/1.0)' } });
    return String(r.data || '')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 8000);
  } catch {
    return '';
  }
}

const sameUrl = (a, b) => String(a).replace(/[?#].*$/, '').replace(/\/$/, '') === String(b).replace(/[?#].*$/, '').replace(/\/$/, '');

async function externalItems(today) {
  const r = await llm.chat({
    web: true,
    maxResults: 8,
    maxTokens: 900,
    system: 'You find recent, verifiable news for a taxi company CEO in Dubai. Use only what your sources state.',
    user:
      `Today is ${today}. Find news from the last 48 hours about: (a) RTA or Dubai government announcements on taxis, ` +
      'ride-hailing, tariffs, Salik or road rules; (b) launches, price changes or partnerships in Dubai by Careem, Uber, ' +
      'Bolt or Hala. Reply ONLY a JSON array (max 4) of {"title": "≤70 chars", "why": "≤100 chars, why it matters to DTC", ' +
      '"url": "the source page", "date": "YYYY-MM-DD"}. Use [] if nothing qualifies. Do not include anything without a source.',
  });
  const list = llm.parseJson(r.text);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list.slice(0, 4)) {
    if (!it || !it.url || !it.title) continue;
    const cite = r.citations.find((c) => sameUrl(c.url, it.url));
    if (!cite || !grounding.isAllowed(it.url)) continue; // uncited or not on the allow-list
    if (it.date && Date.parse(it.date) < Date.parse(today) - 3 * 864e5) continue; // stale
    const src = [cite.title, cite.content || (await pageText(it.url))].join(' ');
    const claim = `${it.title}. ${it.why || ''}`;
    if (grounding.unsupportedNumbers(claim, src).length) continue;
    const v = await grounding.verifyClaims(claim, [src.slice(0, 6000)]);
    if (!v.ok) continue;
    out.push({
      id: newId(),
      kind: 'external',
      title: String(it.title).slice(0, 90),
      detail: String(it.why || '').slice(0, 140),
      source: `${grounding.hostOf(it.url)}${it.date ? ' · ' + it.date : ''}`,
      url: it.url,
    });
  }
  return out;
}

// ── Build / review / publish ─────────────────────────────────────────────────
let draft = null;
let published = null;
let building = false;
const manual = []; // decisions added on the console, carried into the next build

async function build(label = 'manual') {
  if (building) return draft;
  building = true;
  const c = cfg();
  const now = Date.now();
  const { date, hhmm } = dubaiNow(now);
  const errors = [];
  try {
    const wearer = mycroft.wearerById(process.env.MYCROFT_BRIEF_WEARER) || mycroft.newsWearer();
    const [kpi, ext] = await Promise.all([
      wearer
        ? fetchKpis(wearer, c.kpis.length ? c.kpis : DEFAULT_KPIS).catch(() => ({ rows: [], error: 'ops data unavailable (error)' }))
        : Promise.resolve({ rows: [], error: 'ops data unavailable (no Mycroft wearer)' }),
      c.web && llm.available() ? externalItems(date).catch(() => null) : Promise.resolve([]),
    ]);
    if (kpi.error) errors.push(`${kpi.error} ${hhmm}`);
    if (ext === null) errors.push(`market and regulator news unavailable ${hhmm}`);
    const k = kpiItems(kpi.rows, c.threshold);
    // At most 2 DTC posts count as critical (after a restart every post is
    // "new"); the rest go to "more".
    const news = dtcNewsItems();
    const critical = [...manual.splice(0), ...k.critical, ...(ext || []), ...news.slice(0, 2)];
    k.more.unshift(...news.slice(2));
    draft = {
      id: newId(),
      label,
      date,
      builtAt: now,
      builtHhmm: hhmm,
      publishAt: now + c.reviewMin * 60000,
      reviewed: false,
      items: critical.slice(0, MAX_CRITICAL),
      more: [...critical.slice(MAX_CRITICAL), ...k.more].slice(0, 10),
      errors,
    };
    mycroft.logEvent({ kind: 'brief', status: 'built', items: draft.items.length, more: draft.more.length, errors: errors.length });
    if (c.reviewMin === 0) publish();
    return draft;
  } finally {
    building = false;
  }
}

function publish() {
  if (!draft) return published;
  published = { ...draft, status: draft.reviewed ? 'reviewed' : 'unreviewed', publishedAt: Date.now() };
  draft = null;
  mycroft.logEvent({ kind: 'brief', status: 'published', reviewed: published.status === 'reviewed' });
  return published;
}

// Console actions on the draft. → { ok, draft, published, error? }
function review(action, body = {}) {
  const res = () => ({ ok: true, draft, published });
  if (action === 'decision') {
    const title = String(body.title || '').trim().slice(0, 90);
    if (!title) return { ok: false, error: 'title required' };
    const item = { id: newId(), kind: 'decision', title: `Decide today: ${title}`, detail: String(body.detail || '').slice(0, 140), source: "CEO's office" };
    if (draft) draft.items.unshift(item);
    else manual.push(item);
    return res();
  }
  if (!draft) return { ok: false, error: 'no draft brief' };
  const all = [...draft.items, ...draft.more];
  const item = all.find((i) => i.id === body.id);
  if (action === 'drop') {
    if (!item) return { ok: false, error: 'no such item' };
    draft.items = draft.items.filter((i) => i.id !== body.id);
    draft.more = draft.more.filter((i) => i.id !== body.id);
    return res();
  }
  if (action === 'edit') {
    if (!item) return { ok: false, error: 'no such item' };
    if (body.title) item.title = String(body.title).slice(0, 90);
    if (body.detail != null) item.detail = String(body.detail).slice(0, 140);
    return res();
  }
  if (action === 'promote') {
    if (!item) return { ok: false, error: 'no such item' };
    draft.more = draft.more.filter((i) => i.id !== body.id);
    if (!draft.items.includes(item)) draft.items.push(item);
    return res();
  }
  if (action === 'approve') {
    draft.reviewed = true;
    publish();
    return res();
  }
  return { ok: false, error: 'unknown action' };
}

// What the glasses get: the published brief only, trimmed for the HUD.
function forGlasses() {
  if (!published) return { status: 'none', items: [], more: [], errors: [] };
  const strip = ({ id, title, detail, source }) => ({ id, title, detail, source });
  return {
    status: published.status,
    date: published.date,
    builtHhmm: published.builtHhmm,
    items: published.items.map(strip),
    more: published.more.map(strip),
    errors: published.errors,
  };
}

const slotsDone = new Set();
function tick() {
  const { date, hhmm } = dubaiNow();
  for (const t of cfg().times) {
    const slot = `${date} ${t}`;
    if (hhmm >= t && !slotsDone.has(slot) && hhmm < addMin(t, 30)) {
      slotsDone.add(slot);
      build(`${t} Dubai`).catch((e) => console.error('[brief] build failed:', e.message));
    }
  }
  if (draft && Date.now() >= draft.publishAt) publish();
}
function addMin(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + min;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// After a restart there is no brief in memory: build one (published straight
// away, tagged unreviewed) so "brief me" works, then follow the schedule.
function start() {
  const delay = parseInt(process.env.BRIEF_BOOT_DELAY_MS || '60000', 10);
  setTimeout(async () => {
    if (!published) {
      await build('after restart').catch((e) => console.error('[brief] first build failed:', e.message));
      if (draft && !published) publish();
    }
    setInterval(tick, 60000);
  }, delay);
}

module.exports = {
  start, build, publish, review, forGlasses,
  getDraft: () => draft, getPublished: () => published,
  _t: { parseKpiLines, kpiItems, parseNum, dubaiNow, addMin, reset: () => { draft = null; published = null; manual.length = 0; seenNews.clear(); slotsDone.clear(); } },
};
