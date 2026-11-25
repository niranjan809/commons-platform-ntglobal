// grounding.js — the rules that keep the CEO brief and meeting cues honest.
//
// 1. Outside sources must be on an allow-list (SOURCE_ALLOWLIST, comma-separated
//    domains; subdomains match).
// 2. Every number in a cue or brief line must appear in the source text it came
//    from. A model may rephrase, never invent a figure.
// 3. A second model pass checks each claim against the sources (verifyClaims);
//    anything it cannot find is dropped — silence beats a wrong cue.
const llm = require('./llm');

const DEFAULT_ALLOW = [
  'rta.ae', 'wam.ae', 'mediaoffice.ae', 'dubai.ae', 'u.ae', 'dubaitaxi.ae',
  'gulfnews.com', 'thenationalnews.com', 'khaleejtimes.com', 'zawya.com',
  'arabianbusiness.com', 'gulfbusiness.com', 'reuters.com', 'bloomberg.com',
  'careem.com', 'uber.com', 'bolt.eu',
];

function allowList() {
  const env = (process.env.SOURCE_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return env.length ? env : DEFAULT_ALLOW;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isAllowed(url) {
  const h = hostOf(url);
  if (!h) return false;
  return allowList().some((d) => h === d || h.endsWith('.' + d));
}

// Numbers as written, normalised: "1,180" → "1180", "6.5%" → "6.5", "412k" → "412".
// Years and day numbers count too: a date that is not in the source is a claim.
function numbersIn(text) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = m[1].replace(/,/g, '').replace(/\.0+$/, '');
    if (n) out.push(n);
  }
  return out;
}

// Numbers in `claim` that do not appear anywhere in `sourceText`.
function unsupportedNumbers(claim, sourceText) {
  const have = new Set(numbersIn(sourceText));
  return numbersIn(claim).filter((n) => !have.has(n));
}

// Model check: is every factual claim in `text` stated in `sources`?
// → { ok, reason }. Fails closed (any error or doubt = not ok).
async function verifyClaims(text, sources) {
  const bad = unsupportedNumbers(text, sources.join('\n'));
  if (bad.length) return { ok: false, reason: 'number not in source: ' + bad.join(', ') };
  try {
    const r = await llm.chat({
      system:
        'You check short statements against source text. A claim is supported only if the ' +
        'sources state it directly; paraphrase is fine, inference or outside knowledge is not.',
      user:
        'SOURCES:\n' + sources.map((s, i) => `[${i + 1}] ${s}`).join('\n\n') +
        '\n\nSTATEMENT:\n' + text +
        '\n\nReply ONLY JSON: {"supported": true|false, "unsupported": ["claims not in sources"]}',
      maxTokens: 200,
    });
    const j = llm.parseJson(r.text);
    if (j && j.supported === true && (!j.unsupported || !j.unsupported.length)) return { ok: true, reason: '' };
    return { ok: false, reason: 'verifier: ' + ((j && j.unsupported && j.unsupported.join('; ')) || 'not supported') };
  } catch (e) {
    return { ok: false, reason: 'verifier error' };
  }
}

module.exports = { allowList, isAllowed, hostOf, numbersIn, unsupportedNumbers, verifyClaims };
