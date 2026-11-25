// Boots the real server.js against a mock Mycroft and hits /api/mycroft/* over HTTP.
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
// Run: node tests/mycroft-routes.test.js   (boots server.js on :4987 against a mock Mycroft)
const repo = process.argv[2] || require('path').join(__dirname, '..');

const calls = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { calls.push(JSON.parse(b || '{}')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'success', text: 'Revenue is 551m.' })); });
});

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const PORT = 4987;
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    MYCROFT_TEXT_INPUT_URL: `http://127.0.0.1:${mock.address().port}/api/text_input`,
    MYCROFT_WEARERS: 'ceo', MYCROFT_TOKEN_CEO: 'mcg_good', MYCROFT_RELAY_KEY_CEO: 'k-ceo-0123456789abcdefghij',
    MYCROFT_LOG_KEY: 'log-key-0123456789',
    NEWS_REFRESH_MS: '999999999',
  });
  const srv = spawn(process.execPath, ['server.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/users`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const base = `http://127.0.0.1:${PORT}/api/mycroft`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
  let pass = 0; const ok = async (n, f) => { await f(); pass++; console.log('PASS', n); };
  try {
    await ok('no key -> 401 auth, Mycroft untouched', async () => {
      const r = await post('/ask-once', { message: 'revenue?' });
      assert.equal(r.status, 401); assert.equal((await r.json()).status, 'auth'); assert.equal(calls.length, 0);
    });
    await ok('wrong key -> 401', async () => { const r = await post('/ask-once', { message: 'x' }, { 'X-Wearer-Key': 'wrong-key-wrong-key-wrong' }); assert.equal(r.status, 401); });
    await ok('right key -> answer', async () => {
      const r = await post('/ask-once', { message: 'revenue?' }, { 'X-Wearer-Key': 'k-ceo-0123456789abcdefghij' });
      assert.deepEqual(await r.json(), { status: 'success', final: true, text: 'Revenue is 551m.' });
      assert.equal(calls.length, 1);
    });
    await ok('CORS preflight allows X-Wearer-Key', async () => {
      const r = await fetch(base + '/ask-once', { method: 'OPTIONS', headers: { Origin: 'http://app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-wearer-key' } });
      assert.ok(/x-wearer-key/i.test(r.headers.get('access-control-allow-headers') || ''), 'allow-headers missing');
    });
    await ok('perf endpoint does not reach Mycroft', async () => {
      const r = await post('/perf', { breakdown: 'stt=900 ask=2100' }, { 'X-Wearer-Key': 'k-ceo-0123456789abcdefghij' });
      assert.equal(r.status, 200); assert.equal(calls.length, 1);
    });
    await ok('log needs header key; old ?key=g2debug refused', async () => {
      assert.equal((await fetch(base + '/log?key=g2debug')).status, 403);
      const r = await fetch(base + '/log', { headers: { 'X-Log-Key': 'log-key-0123456789' } });
      const s = JSON.stringify(await r.json());
      assert.ok(!s.includes('revenue') && !s.includes('551m'), 'log leaked content');
    });
    await ok('bad-key limiter per client IP', async () => {
      for (let i = 0; i < 20; i++) await post('/ask-once', { message: 'x' }, { 'X-Wearer-Key': 'bad-bad-bad-bad-bad-bad-bad', 'X-Forwarded-For': '9.9.9.9' });
      const blocked = await post('/ask-once', { message: 'x' }, { 'X-Wearer-Key': 'k-ceo-0123456789abcdefghij', 'X-Forwarded-For': '9.9.9.9' });
      assert.equal(blocked.status, 429);
      const other = await post('/ask-once', { message: 'x' }, { 'X-Wearer-Key': 'k-ceo-0123456789abcdefghij', 'X-Forwarded-For': '8.8.8.8' });
      assert.equal(other.status, 200, 'other clients unaffected');
    });
    console.log(`\nALL PASS (${pass})`);
  } catch (e) {
    console.error('FAIL', e.message); console.error(out.slice(-1500)); process.exitCode = 1;
  } finally { srv.kill(); mock.close(); }
})();
