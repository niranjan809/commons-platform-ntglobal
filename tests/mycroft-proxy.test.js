// End-to-end: relay (mycroft.js) → egress proxy (ops/mycroft-egress-proxy) →
// HTTPS mock of the Mycroft token API. Needs `openssl` on PATH (for throwaway
// certificates). Run: node tests/mycroft-proxy.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycroft-proxy-test-'));
const f = (n) => path.join(dir, n);

function cert(name, san) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', f(`${name}-key.pem`), '-out', f(`${name}-cert.pem`),
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
}
cert('proxy', 'IP:127.0.0.1');
cert('other', 'IP:127.0.0.1');
cert('target', 'DNS:localhost');

const SECRET = 'test-proxy-secret-0123456789abcdefghij';
const TOKEN = 'mcg_tunnel_secret_token';
const PROXY_PORT = 48443;

// Some antivirus products (e.g. AVG Web Shield) intercept ALL TLS on the test
// machine, even loopback, and re-sign certificates with their own root. Detect
// that and also trust the interceptor's root for this local run only, so the
// tunnel, auth, target lock and pinning logic are still exercised. On a clean
// machine (Railway, CI, the proxy host) INTERCEPT_ROOT stays empty.
let INTERCEPT_ROOT = '';
const tls = require('tls');
function detectInterception() {
  return new Promise((resolve) => {
    const s = tls.createServer({ cert: fs.readFileSync(f('proxy-cert.pem')), key: fs.readFileSync(f('proxy-key.pem')) }, (c) => c.end());
    s.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: s.address().port, rejectUnauthorized: false }, () => {
        const own = new (require('crypto').X509Certificate)(fs.readFileSync(f('proxy-cert.pem'))).fingerprint256;
        let peer = c.getPeerCertificate(true);
        if (peer.fingerprint256 !== own) {
          // The interceptor's root is usually not sent in the chain; export it
          // from the OS store and point TEST_INTERCEPT_ROOT_FILE at it (PEM).
          const file = process.env.TEST_INTERCEPT_ROOT_FILE;
          if (!file) {
            console.error('Local TLS interception detected (issuer: ' + (peer.issuer && peer.issuer.CN) + '). ' +
              'Set TEST_INTERCEPT_ROOT_FILE to that root certificate (PEM), or run on a machine without TLS scanning.');
            process.exit(2);
          }
          INTERCEPT_ROOT = fs.readFileSync(file, 'utf8');
          console.log('note: local TLS interception detected (' + (peer.issuer && peer.issuer.CN) + ') — trusting its root for this run');
        }
        c.destroy(); s.close(); resolve();
      });
      c.on('error', () => { s.close(); resolve(); });
    });
  });
}
const withRoot = (pem) => pem + (INTERCEPT_ROOT ? '\n' + INTERCEPT_ROOT : '');

const seen = [];
const mock = https.createServer({ cert: fs.readFileSync(f('target-cert.pem')), key: fs.readFileSync(f('target-key.pem')) }, (req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(b || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', text: 'Through the tunnel: 1,180 trips.' }));
  });
});

function runAsk(extraEnv) {
  const code = `
    const m = require(${JSON.stringify(path.join(ROOT, 'mycroft.js'))});
    m.askOnce(m.wearerForKey('k-ceo-0123456789abcdefghij'), 'How many trips?')
      .then((r) => { console.log('RESULT' + JSON.stringify({ r, log: m.getLog() })); process.exit(0); });`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      env: Object.assign({}, process.env, {
        NODE_EXTRA_CA_CERTS: f('target-ca.pem'),
        MYCROFT_TEXT_INPUT_URL: `https://localhost:${mock.address().port}/api/text_input`,
        MYCROFT_WEARERS: 'ceo', MYCROFT_TOKEN_CEO: TOKEN, MYCROFT_RELAY_KEY_CEO: 'k-ceo-0123456789abcdefghij',
        MYCROFT_PROXY_URL: `https://127.0.0.1:${PROXY_PORT}`,
        MYCROFT_PROXY_SECRET: SECRET,
        MYCROFT_PROXY_CA: withRoot(fs.readFileSync(f('proxy-cert.pem'), 'utf8')).replace(/\r?\n/g, '\\n'),
        MYCROFT_HTTP_TIMEOUT_MS: '8000',
      }, extraEnv),
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT'));
      resolve(line ? JSON.parse(line.slice(6)) : { r: null, out });
    });
  });
}

(async () => {
  await detectInterception();
  fs.writeFileSync(f('target-ca.pem'), withRoot(fs.readFileSync(f('target-cert.pem'), 'utf8')));
  await new Promise((r) => mock.listen(0, 'localhost', r));
  let proxyLog = '';
  const proxy = spawn(process.execPath, [path.join(ROOT, 'ops', 'mycroft-egress-proxy', 'proxy.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PROXY_PORT), PROXY_SECRET: SECRET,
      TLS_CERT_FILE: f('proxy-cert.pem'), TLS_KEY_FILE: f('proxy-key.pem'),
      ALLOWED_TARGET: `localhost:${mock.address().port}`,
    }),
  });
  proxy.stdout.on('data', (d) => (proxyLog += d));
  proxy.stderr.on('data', (d) => (proxyLog += d));
  for (let i = 0; i < 50 && !proxyLog.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));

  let pass = 0;
  const ok = async (n, fn) => { await fn(); pass++; console.log('PASS', n); };
  try {
    await ok('answer arrives through the tunnel, token reaches Mycroft', async () => {
      const res = await runAsk({}); const { r } = res;
      assert.deepEqual(r, { status: 'success', final: true, text: 'Through the tunnel: 1,180 trips.' }, JSON.stringify(res.log));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
      assert.equal(seen[0].body.message, 'How many trips?');
    });
    await ok('wrong proxy secret is refused before Mycroft', async () => {
      const { r } = await runAsk({ MYCROFT_PROXY_SECRET: 'wrong-secret-wrong-secret-wrong-secret' });
      assert.equal(r.status, 'error'); assert.equal(seen.length, 1);
      assert.ok(proxyLog.includes('"bad_auth"'));
    });
    await ok('proxy refuses any other destination', async () => {
      const { r } = await runAsk({ MYCROFT_TEXT_INPUT_URL: 'https://example.com/api/text_input' });
      assert.equal(r.status, 'error'); assert.ok(proxyLog.includes('"target_refused"'));
    });
    await ok('relay refuses a proxy with the wrong certificate', async () => {
      const { r } = await runAsk({ MYCROFT_PROXY_CA: fs.readFileSync(f('other-cert.pem'), 'utf8') });
      assert.equal(r.status, 'error'); assert.equal(seen.length, 1);
    });
    await ok('proxy rejects plain GET', async () => {
      const status = await new Promise((resolve) => {
        https.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/', ca: withRoot(fs.readFileSync(f('proxy-cert.pem'), 'utf8')) }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
      });
      assert.equal(status, 405);
    });
    await ok('proxy log never contains the token, secret, question or answer', async () => {
      for (const s of [TOKEN, SECRET, 'How many trips', '1,180']) assert.ok(!proxyLog.includes(s), 'leaked: ' + s);
    });
    console.log(`\nALL PASS (${pass})`);
  } catch (e) {
    console.error('FAIL', e.message); console.error(proxyLog.slice(-2000)); process.exitCode = 1;
  } finally {
    proxy.kill(); mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
