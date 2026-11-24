#!/usr/bin/env node
// mycroft-egress-proxy — a tiny fixed-IP tunnel for the G2 glasses relay.
//
// The relay runs on Railway, whose outbound IPs change. Mycroft only accepts a
// glasses token from registered addresses, so the relay sends its Mycroft calls
// through this proxy, and the Mycroft admin registers THIS machine's fixed IP
// with the tokens.
//
// What it does — and nothing else:
//   • Listens with TLS (so the shared secret is never sent in clear).
//   • Accepts only HTTP CONNECT to ALLOWED_TARGET (default
//     mycroftlive.mobilityae.com:443). Every other method or host is refused.
//   • Requires `Proxy-Authorization: Bearer <PROXY_SECRET>`.
//   • Pipes bytes both ways. The relay's TLS session to Mycroft runs INSIDE the
//     tunnel, so this proxy never sees tokens, questions or answers.
//   • Logs one line per connection: time, client IP, outcome, bytes, duration.
//
// No dependencies — Node.js 18+ core modules only.
//
// Environment:
//   PROXY_SECRET     required, ≥32 chars (shared with the relay, never logged)
//   TLS_CERT_FILE    default ./proxy-cert.pem
//   TLS_KEY_FILE     default ./proxy-key.pem
//   PORT             default 8443
//   ALLOWED_TARGET   default mycroftlive.mobilityae.com:443
//   MAX_CONNECTIONS  default 50
//   IDLE_TIMEOUT_MS  default 120000

'use strict';

const fs = require('fs');
const net = require('net');
const https = require('https');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8443', 10);
const SECRET = process.env.PROXY_SECRET || '';
const ALLOWED = (process.env.ALLOWED_TARGET || 'mycroftlive.mobilityae.com:443').toLowerCase();
const MAX_CONN = parseInt(process.env.MAX_CONNECTIONS || '50', 10);
const IDLE_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '120000', 10);
const BAD_AUTH_LIMIT = 20;              // per client IP …
const BAD_AUTH_WINDOW_MS = 15 * 60e3;   // … per 15 minutes

if (SECRET.length < 32) {
  console.error('PROXY_SECRET must be set and at least 32 characters');
  process.exit(1);
}
const [allowedHost, allowedPortStr] = ALLOWED.split(':');
const allowedPort = parseInt(allowedPortStr || '443', 10);
const secretHash = crypto.createHash('sha256').update(SECRET).digest();

function authOk(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  if (!m) return false;
  const h = crypto.createHash('sha256').update(m[1].trim()).digest();
  return crypto.timingSafeEqual(h, secretHash);
}

function log(fields) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString() }, fields)));
}

const badAuth = new Map(); // ip -> { n, until }
function blocked(ip) {
  const r = badAuth.get(ip);
  return !!r && r.until > Date.now() && r.n >= BAD_AUTH_LIMIT;
}
function noteBadAuth(ip) {
  const now = Date.now();
  const r = badAuth.get(ip);
  const rec = r && r.until > now ? r : { n: 0, until: now + BAD_AUTH_WINDOW_MS };
  rec.n += 1;
  badAuth.set(ip, rec);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of badAuth) if (r.until <= now) badAuth.delete(ip);
}, 60e3).unref();

function refuse(socket, code, text) {
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

let active = 0;

const server = https.createServer({
  cert: fs.readFileSync(process.env.TLS_CERT_FILE || './proxy-cert.pem'),
  key: fs.readFileSync(process.env.TLS_KEY_FILE || './proxy-key.pem'),
  minVersion: 'TLSv1.2',
});

// Plain requests (GET, POST, …) are never proxied.
server.on('request', (req, res) => {
  res.writeHead(405, { Connection: 'close', 'Content-Length': 0 });
  res.end();
});

server.on('connect', (req, clientSocket, head) => {
  const ip = clientSocket.remoteAddress || '';
  const t0 = Date.now();
  const target = String(req.url || '').toLowerCase();

  if (blocked(ip)) { log({ ip, result: 'blocked' }); return refuse(clientSocket, 429, 'Too Many Requests'); }
  if (!authOk(req.headers['proxy-authorization'])) {
    noteBadAuth(ip);
    log({ ip, result: 'bad_auth' });
    return refuse(clientSocket, 407, 'Proxy Authentication Required');
  }
  const [host, portStr] = target.split(':');
  if (host !== allowedHost || parseInt(portStr || '0', 10) !== allowedPort) {
    log({ ip, result: 'target_refused', target: target.slice(0, 100) });
    return refuse(clientSocket, 403, 'Forbidden');
  }
  if (active >= MAX_CONN) { log({ ip, result: 'busy' }); return refuse(clientSocket, 503, 'Service Unavailable'); }

  active += 1;
  let up = 0;
  let down = 0;
  let done = false;
  const upstream = net.connect(allowedPort, allowedHost);
  const finish = (result) => {
    if (done) return;
    done = true;
    active -= 1;
    upstream.destroy();
    clientSocket.destroy();
    log({ ip, result, up, down, ms: Date.now() - t0 });
  };

  upstream.setTimeout(IDLE_MS, () => finish('idle_timeout'));
  clientSocket.setTimeout(IDLE_MS, () => finish('idle_timeout'));
  upstream.once('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) { up += head.length; upstream.write(head); }
    clientSocket.on('data', (d) => { up += d.length; });
    upstream.on('data', (d) => { down += d.length; });
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.once('error', () => {
    if (!upstream.connecting && up + down > 0) return finish('upstream_error');
    if (!clientSocket.destroyed) refuse(clientSocket, 502, 'Bad Gateway');
    finish('upstream_unreachable');
  });
  clientSocket.once('error', () => finish('client_error'));
  upstream.once('close', () => finish('closed'));
  clientSocket.once('close', () => finish('closed'));
});

server.on('tlsClientError', () => { /* scanners / bad handshakes: ignore quietly */ });
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

server.listen(PORT, () => log({ result: 'listening', port: PORT, allowed: ALLOWED }));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
