// Tests mycroft.js against a local mock of the new Mycroft token API.
const http = require('http');
const assert = require('assert');
// Run: node tests/mycroft.test.js   (no network; uses a local mock of the Mycroft token API)
const path = process.argv[2] || require('path').join(__dirname, '..', 'mycroft.js');

const calls = [];
let mode = 'success';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}'), url: req.url });
    const send = (code, obj, headers = {}) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers)); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer mcg_good' && req.headers.authorization !== 'Bearer mcg_two') return send(401, { message: 'token revoked' });
    switch (mode) {
      case 'success': return send(200, { status: 'success', text: 'DTC did 1,180 trips yesterday.', response_status: 'completed' });
      case 'filler': return send(200, { status: 'success', text: 'Retrieving that data from our records.', response_status: 'completed' });
      case 'approval': return send(200, { status: 'success', text: "I'll send that email to Ahmed. It is waiting for your approval in Mycroft.", response_status: 'completed' });
      case 'timeout': return send(200, { status: 'timeout' });
      case 'busy': return send(200, { status: 'busy' });
      case '429': return send(429, { message: 'slow down' }, { 'Retry-After': '7' });
      case '503': return send(503, { code: 'CAPACITY' }, { 'Retry-After': '4' });
      case '403': return send(403, { message: 'address not registered' });
      case 'slow': return setTimeout(() => send(200, { status: 'success', text: 'late answer.' }), 800);
    }
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const port = mock.address().port;
  Object.assign(process.env, {
    MYCROFT_TEXT_INPUT_URL: `http://127.0.0.1:${port}/api/text_input`,
    MYCROFT_WEARERS: 'ceo, niranjan, broken',
    MYCROFT_TOKEN_CEO: 'mcg_good', MYCROFT_RELAY_KEY_CEO: 'k-ceo-0123456789abcdefghij',
    MYCROFT_TOKEN_NIRANJAN: 'mcg_two', MYCROFT_RELAY_KEY_NIRANJAN: 'k-nir-0123456789abcdefghij',
    MYCROFT_TOKEN_BROKEN: 'mcg_old', MYCROFT_RELAY_KEY_BROKEN: 'k-old-0123456789abcdefghij',
  });
  const m = require(path);
  let pass = 0;
  const ok = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log('PASS', name); });

  const ceo = m.wearerForKey('k-ceo-0123456789abcdefghij');
  const nir = m.wearerForKey('k-nir-0123456789abcdefghij');
  const broken = m.wearerForKey('k-old-0123456789abcdefghij');

  await ok('key lookup', () => { assert.equal(ceo.id, 'ceo'); assert.equal(nir.id, 'niranjan'); assert.equal(m.wearerForKey('nope'), null); assert.equal(m.wearerForKey(undefined), null); });
  await ok('news wearer defaults to first', () => assert.equal(m.newsWearer().id, 'ceo'));

  mode = 'success'; calls.length = 0;
  await ok('success: bearer + body + final', async () => {
    const r = await m.askOnce(ceo, 'How many trips yesterday?');
    assert.deepEqual(r, { status: 'success', final: true, text: 'DTC did 1,180 trips yesterday.' });
    assert.equal(calls[0].auth, 'Bearer mcg_good');
    assert.deepEqual(calls[0].body, { message: 'How many trips yesterday?', wait: true, timeout: 20 });
    assert.equal(calls[0].url, '/api/text_input');
  });
  await ok('per-wearer token used', async () => { calls.length = 0; await m.askOnce(nir, 'hi'); assert.equal(calls[0].auth, 'Bearer mcg_two'); });

  mode = 'filler';
  await ok('filler not final', async () => { const r = await m.askOnce(ceo, 'q'); assert.equal(r.final, false); assert.equal(r.status, 'success'); });
  mode = 'approval';
  await ok('approval reply is final', async () => { const r = await m.askOnce(ceo, 'email Ahmed'); assert.equal(r.final, true); });
  mode = 'timeout';
  await ok('mycroft timeout is final (no auto resend)', async () => { const r = await m.askOnce(ceo, 'q'); assert.deepEqual(r, { status: 'timeout', final: true, text: '' }); });
  mode = 'busy';
  await ok('busy -> retryAfter', async () => { const r = await m.askOnce(ceo, 'q'); assert.equal(r.status, 'busy'); assert.equal(r.retryAfter, 3); });
  mode = '429';
  await ok('429 -> retry with Retry-After', async () => { const r = await m.askOnce(ceo, 'q'); assert.equal(r.status, 'retry'); assert.equal(r.retryAfter, 7); });
  mode = '503';
  await ok('503 -> retry with Retry-After', async () => { const r = await m.askOnce(ceo, 'q'); assert.equal(r.status, 'retry'); assert.equal(r.retryAfter, 4); });

  mode = 'success'; calls.length = 0;
  await ok('401 -> auth, then held without calling Mycroft', async () => {
    const r1 = await m.askOnce(broken, 'q');
    assert.deepEqual(r1, { status: 'auth', final: true, text: '' });
    const r2 = await m.askOnce(broken, 'q');
    assert.equal(r2.status, 'auth');
    assert.equal(calls.length, 1, 'second call must not reach Mycroft');
    const r3 = await m.askOnce(ceo, 'q');
    assert.equal(r3.status, 'success', 'other wearers unaffected');
  });
  mode = '403';
  await ok('403 -> auth', async () => { const r = await m.askOnce(nir, 'q'); assert.equal(r.status, 'auth'); });

  m._reset();
  mode = 'slow'; calls.length = 0;
  await ok('single flight per wearer', async () => {
    const [a, b] = await Promise.all([m.askOnce(ceo, 'q1'), new Promise((r) => setTimeout(r, 50)).then(() => m.askOnce(ceo, 'q2'))]);
    assert.equal(a.status, 'success'); assert.equal(b.status, 'busy'); assert.equal(calls.length, 1);
  });

  calls.length = 0;
  await ok('telemetry/minutes never forwarded', async () => { for (const t of ['PERFLOG stt=1200 ask=3000','IMGLOG e5','IMULOG nod=3','MINUTES Board agreed Q3 budget']) { const r = await m.askOnce(ceo, t); assert.equal(r.final, true); } assert.equal(calls.length, 0); });

  await ok('log has no question or answer text', () => {
    const s = JSON.stringify(m.getLog());
    for (const bad of ['trips', '1,180', 'Ahmed', 'q1', 'late answer', 'stt=1200', 'Board agreed']) assert.ok(!s.includes(bad), 'log leaked: ' + bad);
  });

  m._reset({ MYCROFT_WEARERS: 'x', MYCROFT_TOKEN_X: 'mcg_a', MYCROFT_RELAY_KEY_X: 'short' });
  await ok('short relay key rejected', () => assert.equal(m.wearerForKey('short'), null));
  await ok('no wearer -> auth', async () => assert.equal((await m.askOnce(null, 'q')).status, 'auth'));

  console.log(`\nALL PASS (${pass})`);
  mock.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
