// CEO brief + meeting cues, end to end: boots server.js against a mock Mycroft
// and a mock OpenRouter, then drives the glasses and console routes.
// Run: node tests/brief-cue.test.js
const http = require('http');
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const repo = path.join(__dirname, '..');
const TRANSCRIPT_MARK = 'zebra-kickoff-7731'; // unique words that must never leave the relay
const CEO_KEY = 'k-ceo-0123456789abcdefghij';
const CFO_KEY = 'k-cfo-0123456789abcdefghij';
const OPS_KEY = 'ops-key-0123456789abcd';

// ── mock Mycroft ──
const mycroftCalls = [];
const mycroft = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    const msg = JSON.parse(b || '{}').message || '';
    mycroftCalls.push(msg);
    let text = 'OK.';
    if (/Metric \| yesterday \| last week/.test(msg)) {
      text = 'Trips | 412k | 400k\nCustomer complaints | 312 | 264\nSafety incidents | 0 | 1\nRevenue | n/a | n/a';
    } else if (/Quick lookup/.test(msg)) {
      text = /Careem/i.test(msg) ? 'NO_DATA' : 'Bolt trips in October were 412,000, up 6% on September.';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', text }));
  });
});

// ── mock OpenRouter ──
const llmCalls = [];
const reply = (content, citations = []) => ({
  choices: [{ message: { content, annotations: citations.map((c) => ({ type: 'url_citation', url_citation: c })) } }],
});
const openrouter = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const user = (body.messages || []).map((m) => m.content).join('\n');
    llmCalls.push({ web: !!(body.plugins && body.plugins.length), user });
    let out;
    if (/Find news from the last 48 hours/.test(user)) {
      out = reply(JSON.stringify([
        { title: 'RTA sets new airport taxi tariff from 1 December', why: 'Airport fares change for 1,180 cabs', url: 'https://www.rta.ae/news/tariff', date: '2026-11-24' },
        { title: 'Blog says taxis are changing', why: 'unofficial', url: 'https://example.com/post', date: '2026-11-24' },
        { title: 'Uber cuts fares 40% in Dubai', why: 'INVENTED number', url: 'https://www.gulfnews.com/uber', date: '2026-11-24' },
      ]), [
        { url: 'https://www.rta.ae/news/tariff', title: 'New airport taxi tariff', content: 'RTA announced a new airport taxi tariff from 1 December covering 1,180 cabs.' },
        { url: 'https://example.com/post', title: 'Blog', content: 'taxis are changing' },
        { url: 'https://www.gulfnews.com/uber', title: 'Uber in Dubai', content: 'Uber adjusted some fares in Dubai.' },
      ]);
    } else if (/LAST 2 MINUTES/.test(user)) {
      out = /Careem/.test(user)
        ? reply(JSON.stringify({ cue_worthy: true, topic: 'Careem launch', internal_question: 'Careem data?', web_keywords: 'Careem Dubai launch' }))
        : reply(JSON.stringify({ cue_worthy: true, topic: 'Bolt volumes', internal_question: 'How many Bolt trips in October?', web_keywords: 'Bolt Dubai' }));
    } else if (/Recent news or official information/.test(user)) {
      out = reply('Careem launched bikes on 20 November.', [
        { url: 'https://www.gulfnews.com/careem', title: 'Careem launch', content: 'Careem launched a new service in Dubai on 20 November.' },
      ]);
    } else if (/Write the single most useful fact/.test(user)) {
      out = reply(JSON.stringify({ cue: /Careem/.test(user) ? 'Careem launched a new service in Dubai on 20 November' : 'Bolt trips Oct: 412,000, +6% vs Sep' }));
    } else if (/STATEMENT:/.test(user)) {
      out = reply(JSON.stringify(/INVENTED/.test(user) ? { supported: false, unsupported: ['x'] } : { supported: true, unsupported: [] }));
    } else {
      out = reply('{}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Unit checks first (no server needed).
  const g = require('../grounding');
  const brief = require('../brief');
  assert.deepEqual(g.numbersIn('Bolt 412,000 trips, +6.0%'), ['412000', '6']);
  assert.deepEqual(g.unsupportedNumbers('Trips 412,000 up 9%', 'trips were 412000, up 6%'), ['9']);
  assert.ok(g.isAllowed('https://www.rta.ae/x') && g.isAllowed('https://news.gulfnews.com/a') && !g.isAllowed('https://rta.ae.evil.com/'));
  const rows = brief._t.parseKpiLines('Metric | yesterday | last week\n1. Trips | 412k | 400k\nRevenue | n/a | n/a');
  assert.equal(rows.length, 1); assert.equal(rows[0].now, 412000);
  assert.equal(brief._t.addMin('23:50', 30), '00:20');
  console.log('PASS unit: numbers, allow-list, KPI parsing');

  await new Promise((r) => mycroft.listen(0, r));
  await new Promise((r) => openrouter.listen(0, r));
  const PORT = 4988;
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    MYCROFT_TEXT_INPUT_URL: `http://127.0.0.1:${mycroft.address().port}/api/text_input`,
    MYCROFT_PROXY_URL: '',
    MYCROFT_WEARERS: 'ceo,cfo',
    MYCROFT_TOKEN_CEO: 'mcg_ceo', MYCROFT_RELAY_KEY_CEO: CEO_KEY,
    MYCROFT_TOKEN_CFO: 'mcg_cfo', MYCROFT_RELAY_KEY_CFO: CFO_KEY,
    MYCROFT_LOG_KEY: 'log-key-0123456789',
    OPS_CONSOLE_KEY: OPS_KEY,
    OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${openrouter.address().port}`,
    NEWS_REFRESH_MS: '999999999', BRIEF_BOOT_DELAY_MS: '999999999',
    BRIEF_REVIEW_MIN: '30', CUE_INTERVAL_MS: '5000', CUE_MYCROFT_GAP_MS: '0', CUE_MODE: 'assisted',
  });
  const srv = spawn(process.execPath, ['server.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/users`); break; } catch { await sleep(200); } }

  const base = `http://127.0.0.1:${PORT}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined,
  });
  const ops = { 'X-Ops-Key': OPS_KEY };
  let pass = 1;
  const ok = async (n, f) => { await f(); pass++; console.log('PASS', n); };

  try {
    await ok('console refuses a missing or wrong key', async () => {
      assert.equal((await call('GET', '/api/ops/brief')).status, 403);
      assert.equal((await call('GET', '/api/ops/brief', null, { 'X-Ops-Key': 'wrong-wrong-wrong-wrong' })).status, 403);
    });
    await ok('glasses get no brief before one is published', async () => {
      assert.equal((await call('GET', '/api/mycroft/brief')).status, 401);
      const j = await (await call('GET', '/api/mycroft/brief', null, { 'X-Wearer-Key': CEO_KEY })).json();
      assert.equal(j.status, 'none');
    });
    let draft;
    await ok('decision added before the build lands at the top', async () => {
      assert.equal((await call('POST', '/api/ops/brief', { action: 'decision', title: 'Approve airport fleet top-up' }, ops)).status, 200);
      draft = (await (await call('POST', '/api/ops/brief/rebuild', {}, ops)).json()).draft;
      assert.ok(draft, out.slice(-800));
      assert.match(draft.items[0].title, /^Decide today: Approve airport fleet top-up/);
    });
    await ok('brief rules: off-target KPI is critical, small change goes to "more", n/a is never invented', async () => {
      const titles = draft.items.map((i) => i.title).join(' | ');
      assert.match(titles, /Customer complaints \+18% vs last wk \(312\)/);
      assert.ok(!/Trips/.test(titles), 'trips +3% must not be critical');
      assert.ok(draft.more.some((i) => /^Trips 412k \(\+3% vs last wk\)/.test(i.title)));
      assert.ok(![...draft.items, ...draft.more].some((i) => /Revenue/.test(i.title)), 'n/a revenue must be left out');
      assert.deepEqual(draft.errors, []);
    });
    await ok('outside news only with an allow-listed citation and matching numbers', async () => {
      const ext = draft.items.filter((i) => i.kind === 'external');
      assert.equal(ext.length, 1, JSON.stringify(ext));
      assert.match(ext[0].title, /RTA sets new airport taxi tariff/);
      assert.match(ext[0].source, /^rta\.ae/);
    });
    await ok('approve publishes "reviewed"; glasses see items without internals', async () => {
      const item = draft.items.find((i) => i.kind === 'kpi');
      await call('POST', '/api/ops/brief', { action: 'edit', id: item.id, detail: 'Mostly airport rank waits.' }, ops);
      assert.equal((await call('POST', '/api/ops/brief', { action: 'approve' }, ops)).status, 200);
      const j = await (await call('GET', '/api/mycroft/brief', null, { 'X-Wearer-Key': CEO_KEY })).json();
      assert.equal(j.status, 'reviewed');
      assert.ok(j.items.some((i) => i.detail === 'Mostly airport rank waits.'));
      assert.ok(!('url' in j.items[0]) && !('kind' in j.items[0]));
    });

    // ── cues ──
    const seg = (key, text) => call('POST', '/api/mycroft/cue/segment', { text }, { 'X-Wearer-Key': key });
    await ok('cue from DTC data waits for approval (assisted mode)', async () => {
      await seg(CEO_KEY, `Okay so for the ${TRANSCRIPT_MARK}, how did the Bolt partnership do on volumes in October? We need the number.`);
      let cues = [];
      for (let i = 0; i < 30 && !cues.length; i++) { await sleep(200); cues = (await (await call('GET', '/api/ops/cues', null, ops)).json()).cues; }
      assert.equal(cues.length, 1, out.slice(-800));
      assert.equal(cues[0].status, 'pending'); assert.equal(cues[0].tag, 'DTC');
      assert.equal(cues[0].text, 'Bolt trips Oct: 412,000, +6% vs Sep');
      const n = await (await call('GET', '/api/mycroft/cue/next', null, { 'X-Wearer-Key': CEO_KEY })).json();
      assert.equal(n.cue, null, 'unapproved cue must not reach the glasses');
      assert.ok(!llmCalls.some((c) => c.web && c.user.includes('Bolt partnership')), 'internal hit must not trigger a web search');
    });
    await ok('approved cue is delivered once; an edit with a new number is refused', async () => {
      const [c] = (await (await call('GET', '/api/ops/cues', null, ops)).json()).cues;
      const bad = await call('POST', '/api/ops/cues', { id: c.id, action: 'approve', text: 'Bolt trips Oct: 500,000' }, ops);
      assert.equal(bad.status, 400);
      assert.equal((await call('POST', '/api/ops/cues', { id: c.id, action: 'approve' }, ops)).status, 200);
      const n1 = await (await call('GET', '/api/mycroft/cue/next', null, { 'X-Wearer-Key': CEO_KEY })).json();
      assert.equal(n1.cue.text, 'Bolt trips Oct: 412,000, +6% vs Sep'); assert.equal(n1.cue.tag, 'DTC');
      const n2 = await (await call('GET', '/api/mycroft/cue/next', null, { 'X-Wearer-Key': CEO_KEY })).json();
      assert.equal(n2.cue, null);
      const cfo = await (await call('GET', '/api/mycroft/cue/next', null, { 'X-Wearer-Key': CFO_KEY })).json();
      assert.equal(cfo.cue, null, 'cues are per wearer');
    });
    await ok('no DTC data → web search with keywords only (no transcript words)', async () => {
      await seg(CFO_KEY, `In the ${TRANSCRIPT_MARK} we heard Careem launched something new in Dubai last week, what was it exactly?`);
      let cues = [];
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        cues = (await (await call('GET', '/api/ops/cues', null, ops)).json()).cues.filter((c) => c.wearer === 'cfo');
        if (cues.length) break;
      }
      assert.equal(cues.length, 1, out.slice(-800));
      assert.match(cues[0].tag, /^EXT · gulfnews\.com/);
      const web = llmCalls.filter((c) => c.web && /Recent news or official information/.test(c.user));
      assert.equal(web.length, 1);
      assert.ok(!web[0].user.includes(TRANSCRIPT_MARK) && !/what was it exactly/.test(web[0].user), 'transcript leaked to web search');
    });
    await ok('logs and the console never hold transcript text', async () => {
      const log = JSON.stringify(await (await call('GET', '/api/mycroft/log', null, { 'X-Log-Key': 'log-key-0123456789' })).json());
      assert.ok(!log.includes(TRANSCRIPT_MARK) && !log.includes('Bolt partnership'));
      const con = JSON.stringify(await (await call('GET', '/api/ops/cues', null, ops)).json());
      assert.ok(!con.includes(TRANSCRIPT_MARK));
      assert.ok(!out.includes(TRANSCRIPT_MARK), 'server stdout leaked transcript');
    });
    await ok('stop clears the meeting session', async () => {
      assert.equal((await call('POST', '/api/mycroft/cue/stop', {}, { 'X-Wearer-Key': CFO_KEY })).status, 200);
    });
    console.log(`\nALL PASS (${pass})`);
  } catch (e) {
    console.error('FAIL', e.message);
    console.error(out.slice(-1500));
    process.exitCode = 1;
  } finally {
    srv.kill(); mycroft.close(); openrouter.close();
  }
})();
