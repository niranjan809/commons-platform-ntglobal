// llm.js — small OpenRouter chat client for the CEO brief and meeting cues.
//
// Uses the same OpenRouter key as speech-to-text (OPENROUTER_API_KEY, or an
// sk-or- key in GROQ_API_KEY). `web: true` turns on OpenRouter's web-search
// plugin, which returns the pages it used as url_citation annotations; callers
// only trust facts that come with one of those citations.
//
// Env: OPENROUTER_LLM_MODEL (default anthropic/claude-haiku-5.5),
//      OPENROUTER_BASE_URL (tests), LLM_TIMEOUT_MS (default 45000).
const { openRouterKey } = require('./notes');

const BASE = () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const MODEL = () => process.env.OPENROUTER_LLM_MODEL || 'anthropic/claude-haiku-5.5';
const TIMEOUT_MS = () => parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);

function available() {
  return !!openRouterKey();
}

// → { text, citations: [{ url, title, content }] }. Throws on HTTP errors.
async function chat({ system, user, web = false, maxResults = 5, maxTokens = 700, model } = {}) {
  const key = openRouterKey();
  if (!key) {
    const e = new Error('no OpenRouter key');
    e.code = 'NO_LLM_KEY';
    throw e;
  }
  const body = {
    model: model || MODEL(),
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
  };
  if (web) body.plugins = [{ id: 'web', max_results: maxResults }];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(BASE() + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'X-Title': 'Commons glasses relay',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 160)}`);
    }
    const data = await res.json();
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const citations = (msg.annotations || [])
      .filter((a) => a && a.type === 'url_citation' && a.url_citation && a.url_citation.url)
      .map((a) => ({
        url: a.url_citation.url,
        title: a.url_citation.title || '',
        content: a.url_citation.content || '',
      }));
    return { text: String(msg.content || '').trim(), citations };
  } finally {
    clearTimeout(timer);
  }
}

// Parse the first JSON value in a model reply (tolerates ```json fences / prose).
function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const s = Math.min(...starts);
  const close = t[s] === '[' ? ']' : '}';
  const e = t.lastIndexOf(close);
  if (e <= s) return null;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    return null;
  }
}

module.exports = { chat, parseJson, available };
