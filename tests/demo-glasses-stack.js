// Local demo stack for the glasses simulator: the real server.js (this branch)
// on :4987, against a mock Mycroft and a mock OpenRouter. Speech-to-text returns
// a scripted line per call, so simulator taps (silent audio) drive real flows:
//   1st transcription → "Brief me."            (CEO brief, pre-built)
//   2nd               → "Start topic cues."     (Topic Cues mode, v0.9.5)
//   3rd+              → a conversation line about Bolt volumes (→ an automatic cue)
// Glasses key: dev-wearer-key-0123456789abcdef (the mycroft-g2-e2e launch config).
// Console: http://localhost:4987/ops-console.html  key: ops-demo-key-0123456789
// Run: node tests/demo-glasses-stack.js   (Ctrl+C to stop). Demo values only.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// DEMO_STT_FILE (optional): a JSON array of lines, one per transcription, to
// script a longer run (e.g. the full-feature test in the app repo).
const STT = process.env.DEMO_STT_FILE
  ? JSON.parse(require('fs').readFileSync(process.env.DEMO_STT_FILE, 'utf8'))
  : [
      'Brief me.',
      'Start topic cues.',
      'We need the Bolt partnership volumes for October before the board meeting.',
    ];
let sttCalls = 0;

const mycroft = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    const msg = JSON.parse(b || '{}').message || '';
    let text = 'Paris is the capital of France.';
    if (/most important points from yesterday/.test(msg)) {
      text = '1. Trips 412,000 yesterday, up 3% on last Tuesday\n2. Complaints 312, mostly airport rank waits\n3. One minor collision in Deira, no injuries';
    } else if (/Metric \| yesterday \| last week/.test(msg)) {
      text = 'Trips | 412k | 400k\nFleet on road | 5,210 | 5,190\nCustomer complaints | 312 | 264\nSafety incidents | 1 | 0\nRevenue | n/a | n/a';
    } else if (/Quick lookup/.test(msg)) {
      text = 'Bolt trips in October were 412,000, up 6% on September.';
    } else if (/Tell me more about this/.test(msg)) {
      text = 'Complaints rose mainly at the airport ranks, where waits passed 20 minutes on Sunday.';
    } else if (/minutes of this meeting/i.test(msg)) {
      text = 'The team agreed the airport fleet plan for December. Extra cabs go to Terminal 3 at night.\n' +
        'Decisions:\nAdd 40 cabs to the Terminal 3 night rank\nActions:\nAhmed: confirm the top-up with RTA\nSara: update the driver roster';
    } else if (/^Translate the following into/i.test(msg)) {
      text = 'Good morning everyone (translated)';
    } else if (/as a bar chart|by month/i.test(msg)) {
      text = 'DTC trips by month: August 380,000; September 395,000; October 412,000.';
    } else if (/trips yesterday/i.test(msg)) {
      text = 'DTC completed 412,000 trips yesterday, 3% more than the same day last week.';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', text }));
  });
});

const reply = (content, citations = []) => ({
  choices: [{ message: { content, annotations: citations.map((c) => ({ type: 'url_citation', url_citation: c })) } }],
});
const openrouter = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/audio/transcriptions')) {
      const text = STT[Math.min(sttCalls++, STT.length - 1)];
      console.log('[demo] transcription #' + sttCalls + ':', text);
      return res.end(JSON.stringify({ text }));
    }
    const body = JSON.parse(b || '{}');
    const user = (body.messages || []).map((m) => m.content).join('\n');
    let out = reply('{}');
    if (/Find news from the last 48 hours/.test(user)) {
      out = reply(JSON.stringify([{ title: 'RTA sets new airport taxi tariff from 1 December', why: 'Airport fares change for 1,180 cabs', url: 'https://www.rta.ae/news/tariff', date: '2026-11-24' }]),
        [{ url: 'https://www.rta.ae/news/tariff', title: 'New airport taxi tariff', content: 'RTA announced a new airport taxi tariff from 1 December covering 1,180 cabs.' }]);
    } else if (/LAST 2 MINUTES/.test(user)) {
      out = reply(JSON.stringify({ cue_worthy: true, topic: 'Bolt volumes', internal_question: 'How many Bolt trips in October?', web_keywords: 'Bolt Dubai' }));
    } else if (/Write the single most useful fact/.test(user)) {
      out = reply(JSON.stringify({ cue: 'Bolt trips Oct: 412,000, +6% vs Sep' }));
    } else if (/STATEMENT:/.test(user)) {
      out = reply(JSON.stringify({ supported: true, unsupported: [] }));
    }
    res.end(JSON.stringify(out));
  });
});

(async () => {
  await new Promise((r) => mycroft.listen(0, r));
  await new Promise((r) => openrouter.listen(0, r));
  const env = Object.assign({}, process.env, {
    PORT: '4987',
    MYCROFT_TEXT_INPUT_URL: `http://127.0.0.1:${mycroft.address().port}/api/text_input`,
    MYCROFT_PROXY_URL: '',
    MYCROFT_WEARERS: 'niranjan',
    MYCROFT_TOKEN_NIRANJAN: 'mcg_demo', MYCROFT_RELAY_KEY_NIRANJAN: 'dev-wearer-key-0123456789abcdef',
    MYCROFT_NEWS_WEARER: 'nobody-local-demo',
    OPS_CONSOLE_KEY: 'ops-demo-key-0123456789',
    OPENROUTER_API_KEY: 'sk-or-demo', GROQ_API_KEY: '', OPENAI_API_KEY: '',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${openrouter.address().port}`,
    NEWS_REFRESH_MS: '999999999', BRIEF_BOOT_DELAY_MS: '1000', CUE_INTERVAL_MS: '5000', CUE_MYCROFT_GAP_MS: '0',
    MYCROFT_BRIEF_WEARER: 'niranjan',
  });
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
  process.on('SIGINT', () => { srv.kill(); process.exit(0); });
  console.log('[demo] relay starting on http://localhost:4987 (console: /ops-console.html)');
})();
