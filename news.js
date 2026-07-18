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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const POLL_DELAY_MS = 1500;
const MAX_POLLS = 40;

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
async function askUntilFinal(message) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const r = await mycroft.askOnce(message);
    if (r && r.status === 'success' && r.final && r.text) return r.text;
    await sleep(POLL_DELAY_MS);
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
    const items = await fetchBriefing();
    if (valid(items)) {
      cache = { items, updatedAt: Date.now(), source: 'live' };
      console.log('[news] refreshed:', items.length, 'headlines');
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
