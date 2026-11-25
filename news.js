// news.js — server-side daily executive news briefing for the Even G2 app.
//
// Instead of every pair of glasses running its own slow Mycroft web-search, the
// server fetches ONE exec briefing on a daily schedule and caches it. The G2 app
// reads GET /api/news and gets an instant, identical, already-current briefing —
// fresh even before that device ran its own refresh.
//
// Exposed by server.js as:
//   GET  /api/news              -> { items:[{title,detail}], updatedAt, source }
//   POST /api/news/refresh?pwd= -> force a refresh (admin), returns the new cache

const mycroft = require('./mycroft');
const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── First-party source: Dubai Taxi Company's own Media Zone ──────────────────
// DTC's official announcements are the highest-signal news for a DTC exec, so we
// scrape the Media Zone directly (Webflow, server-rendered — titles live in the
// post cards' <img alt="…">) and rank them ABOVE the global Mycroft briefing.
const DTC_NEWS_URL = process.env.DTC_NEWS_URL || 'https://www.dubaitaxi.ae/en/media-zone';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchDtcOfficial() {
  try {
    const resp = await axios.get(DTC_NEWS_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CommonsG2/1.0)' },
    });
    const html = String(resp.data || '');
    const re = /href="(\/en\/post\/[^"]+)"[^>]*>\s*<img[^>]*\salt="([^"]+)"/gi;
    const seen = new Set();
    const items = [];
    let m;
    while ((m = re.exec(html)) && items.length < 5) {
      const title = decodeEntities(m[2]);
      const key = m[1].toLowerCase();
      if (title.length < 8 || seen.has(key)) continue;
      seen.add(key);
      items.push({ title, detail: 'DTC official', url: 'https://www.dubaitaxi.ae' + m[1] });
    }
    if (items.length) console.log('[news] DTC official:', items.length, 'headlines');
    return items;
  } catch (e) {
    console.warn('[news] DTC media-zone fetch failed:', e.message);
    return [];
  }
}

// Merge DTC-official (first, up to 3) with the global briefing, deduped.
function mergeHeadlines(dtc, global) {
  const out = [];
  const seen = new Set();
  const add = (h) => {
    if (!h || !h.title) return;
    const k = h.title.toLowerCase().slice(0, 40);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(h);
  };
  (dtc || []).slice(0, 3).forEach(add);
  (global || []).forEach(add);
  return out.slice(0, 7);
}

// Blended exec scope (mirrors the app's NEWS_COMBINED_SCOPE).
const SCOPE =
  'the single most important recent developments a Dubai Taxi Company CEO should know today, ' +
  'across: Dubai and UAE transport policy and RTA, global ride-hailing and autonomous vehicles ' +
  '(robotaxis, Apollo Go, WeRide, Pony.ai, Waymo, Tesla, Uber, Bolt, Careem), and major AI moves ' +
  'relevant to mobility';

const PROMPT =
  'Executive news briefing for the CEO of Dubai Taxi Company. Search the web for the LATEST news about ' +
  SCOPE +
  ". Reply as PLAIN TEXT only: exactly 6 numbered lines, each formatted as '1. Headline (max 10 words) - " +
  "why it matters in one short clause'. No introduction, no markdown, no conclusion.";

const FOLLOWUP =
  'Show the finished six-line executive briefing now, as plain numbered lines ' +
  '("1. Headline - why it matters"). If the search finished, give the six lines.';

const REFRESH_MS = parseInt(process.env.NEWS_REFRESH_MS || String(24 * 60 * 60 * 1000), 10); // daily
const POLL_DELAY_MS = 3000;
const MAX_POLLS = 6;

// Baked seed so GET /api/news returns something before the first refresh lands.
const SEED = [
  { title: 'Dubai launches driverless taxis in Jumeirah & Umm Suqeim', detail: 'first commercial robotaxi zones go live' },
  { title: 'Apollo Go to scale to 1,000 robotaxis in Dubai by 2028', detail: 'DTC provides local operating support' },
  { title: 'WeRide robotaxis join Uber in Dubai', detail: 'driverless rides now bookable via Uber' },
  { title: 'RTA sets AED 5 fare for driverless taxis', detail: 'a public pricing benchmark for autonomous rides' },
  { title: 'Dubai targets 25% of journeys autonomous by 2030', detail: 'self-driving transport strategy milestone' },
  { title: 'Chinese AV firms lead the Gulf robotaxi race', detail: 'Apollo Go, WeRide, Pony.ai scaling across the region' },
];

let cache = { items: SEED, updatedAt: 0, source: 'seed' };
let refreshing = false;

// Parse "1. Headline - detail" lines (tolerates "1)" and –/— dashes).
function parseHeadlines(text) {
  const items = [];
  if (!text) return items;
  const lineRe = /^\s*\d{1,2}[.)]\s+(.+)$/gm;
  let m;
  while ((m = lineRe.exec(text)) && items.length < 10) {
    const body = m[1].replace(/[*_`#|>]/g, '').trim();
    if (body.length < 6) continue;
    const dash = body.search(/\s[-–—]\s/);
    const title = (dash > 0 ? body.slice(0, dash) : body).trim();
    const detail = (dash > 0 ? body.slice(dash + 3) : '').trim();
    if (title) items.push({ title, detail });
  }
  return items;
}

// Reject placeholder rows ("Search pending" etc.) the backend sometimes returns.
function isPlaceholder(title) {
  const t = (title || '').trim();
  if (!t) return true;
  return (
    /^(search(ing)?|results?|gathering|processing|pending|loading|fetching|retrieving|please wait|one moment|working on it)\b/i.test(t) ||
    /\b(pending|in progress)\b/i.test(t)
  );
}
function valid(items) {
  const real = items.filter((h) => !isPlaceholder(h.title));
  const distinct = new Set(real.map((h) => h.title.toLowerCase())).size;
  return distinct >= 2;
}

// Poll askOnce until a non-filler (final) answer, mirroring the app's poll loop.
// Runs as MYCROFT_NEWS_WEARER (default: the first configured wearer). Every
// re-ask shows up in that person's Mycroft conversation, so polls are capped low.
async function askUntilFinal(message) {
  const wearer = mycroft.newsWearer();
  if (!wearer) {
    console.warn('[news] no Mycroft wearer configured — skipping the Mycroft briefing');
    return '';
  }
  for (let i = 0; i < MAX_POLLS; i++) {
    const r = await mycroft.askOnce(wearer, message);
    if (r && r.status === 'success' && r.final && r.text) return r.text;
    // Token/IP problems and Mycroft-side timeouts: stop, never loop (a bad token
    // retried in a loop locks the relay's IP out for every wearer).
    if (r && (r.status === 'auth' || r.status === 'timeout')) return '';
    const wait = r && r.retryAfter ? r.retryAfter * 1000 : POLL_DELAY_MS;
    await sleep(Math.max(wait, POLL_DELAY_MS));
  }
  return '';
}

async function fetchBriefing() {
  let text = await askUntilFinal(PROMPT);
  let items = parseHeadlines(text);
  for (let retry = 0; retry < 3 && !valid(items); retry++) {
    text = await askUntilFinal(FOLLOWUP);
    items = parseHeadlines(text);
  }
  return items;
}

async function refresh() {
  if (refreshing) return cache;
  refreshing = true;
  try {
    // DTC's own Media Zone + the global Mycroft briefing, in parallel; DTC first.
    const [dtc, global] = await Promise.all([
      fetchDtcOfficial().catch(() => []),
      fetchBriefing().catch(() => []),
    ]);
    const items = mergeHeadlines(dtc, global);
    if (valid(items)) {
      cache = { items, updatedAt: Date.now(), source: 'live' };
      console.log('[news] refreshed:', items.length, `headlines (${dtc.length} DTC official)`);
    } else {
      console.warn('[news] refresh got no valid headlines — keeping previous cache');
    }
  } catch (e) {
    console.error('[news] refresh error:', e.message);
  } finally {
    refreshing = false;
  }
  return cache;
}

function get() {
  return { items: cache.items, updatedAt: cache.updatedAt, source: cache.source };
}

// Kick an initial refresh shortly after boot, then repeat daily. The delay keeps
// the news fetch from competing with startup and any first glasses request.
function start() {
  setTimeout(() => {
    refresh();
    setInterval(refresh, REFRESH_MS);
  }, 15000);
}

module.exports = { get, refresh, start };
