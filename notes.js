// notes.js — web notetaker engine (Railway-friendly).
// The Python CLI in notetaker/ stays the local/offline path (local Whisper);
// this module is the hosted path the live app uses: a hosted Whisper API for
// transcription + the Claude API for Minutes-of-Meeting, with a local
// keyword fallback when no Claude key is present.
const axios = require('axios');

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Hosted Whisper via an OpenAI-compatible "audio/translations" endpoint, which
// outputs English from any source language (incl. Malayalam). Prefer Groq
// (fast, free tier, whisper-large-v3); fall back to OpenAI's whisper-1.
function sttConfig() {
  if (process.env.GROQ_API_KEY) {
    return {
      url: 'https://api.groq.com/openai/v1/audio/translations',
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
      provider: 'groq',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      url: 'https://api.openai.com/v1/audio/translations',
      key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
      provider: 'openai',
    };
  }
  return null;
}

async function transcribeAudio(buffer, filename) {
  const cfg = sttConfig();
  if (!cfg) {
    const err = new Error('No transcription key set. Add GROQ_API_KEY (free tier) ' +
      'or OPENAI_API_KEY on the server, or paste a transcript instead.');
    err.code = 'NO_STT_KEY';
    throw err;
  }
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename || 'recording.m4a');
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.key },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Transcription failed (' + cfg.provider + ' ' + res.status + '): ' + detail.slice(0, 200));
  }
  const data = await res.json();
  return { text: (data.text || '').trim(), provider: cfg.provider, model: cfg.model };
}

// ── Minutes of Meeting ────────────────────────────────────────────────────────
const MOM_SCHEMA_HINT =
  'Return ONLY valid JSON, no markdown fences, with this exact shape:\n' +
  '{\n' +
  '  "summary": "2-4 sentence plain-English overview",\n' +
  '  "decisions": ["decision 1", "decision 2"],\n' +
  '  "action_items": [\n' +
  '     {"owner": "<attendee name or \\"Unassigned\\">", "task": "...", "due": "<date or empty>"}\n' +
  '  ]\n' +
  '}\n';

function parseJsonBlock(text) {
  text = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e !== -1) text = text.slice(s, e + 1);
  return JSON.parse(text);
}

async function claudeMoM(transcript, attendees, apiKey, modelId) {
  const system =
    'You are an expert meeting-minutes assistant. Produce concise, accurate ' +
    'Minutes of Meeting from a transcript. Assign each action item to the most ' +
    'likely owner from the provided attendee list; use "Unassigned" if unclear. ' +
    'Do not invent tasks that are not supported by the transcript.';
  const att = attendees && attendees.length ? attendees.join(', ') : '(not provided — infer names from transcript)';
  const user = 'Attendees: ' + att + '\n\nTranscript (English):\n"""\n' + transcript + '\n"""\n\n' + MOM_SCHEMA_HINT;
  const res = await axios.post(ANTHROPIC_URL, {
    model: modelId, max_tokens: 2000, system, messages: [{ role: 'user', content: user }],
  }, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    timeout: 120000,
  });
  const text = (res.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseJsonBlock(text);
}

const ACTION_RE = /\b(will|to|should|need to|needs to|going to|action|follow[- ]?up|assign|responsible|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|eod|end of))\b/i;

function localMoM(transcript, attendees) {
  const sentences = transcript.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const summary = sentences.slice(0, 4).join(' ') || '(empty transcript)';
  const names = (attendees || []).map(a => a.trim()).filter(Boolean);
  const action_items = [];
  for (const s of sentences) {
    if (ACTION_RE.test(s)) {
      let owner = 'Unassigned';
      for (const n of names) {
        const first = n.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('\\b' + first + '\\b', 'i').test(s)) { owner = n; break; }
      }
      action_items.push({ owner, task: s, due: '' });
    }
  }
  return { summary, decisions: [], action_items: action_items.slice(0, 25), _engine: 'local-fallback' };
}

async function generateMoM(transcript, attendees) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const modelId = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL;
  if (apiKey) {
    try {
      const mom = await claudeMoM(transcript, attendees, apiKey, modelId);
      if (!mom._engine) mom._engine = 'claude:' + modelId;
      return mom;
    } catch (e) {
      const detail = e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      console.error('Claude MoM failed, using local fallback:', detail);
    }
  }
  return localMoM(transcript, attendees);
}

// Group action items per member, matching owner -> roster by full or first name.
function groupByMember(action_items, roster) {
  const grouped = {};
  const names = Object.keys(roster || {});
  for (const item of action_items || []) {
    const owner = (item.owner || 'Unassigned').trim();
    let matched = null;
    for (const n of names) {
      if (n.toLowerCase() === owner.toLowerCase() ||
          n.split(/\s+/)[0].toLowerCase() === owner.split(/\s+/)[0].toLowerCase()) { matched = n; break; }
    }
    const key = matched || owner;
    let task = (item.task || '').trim();
    if (item.due) task += '  (due: ' + item.due + ')';
    (grouped[key] = grouped[key] || []).push(task);
  }
  return grouped;
}

module.exports = { transcribeAudio, generateMoM, localMoM, groupByMember, sttConfig };
