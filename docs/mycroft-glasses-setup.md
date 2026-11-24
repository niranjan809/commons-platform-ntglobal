# Mycroft glasses relay — setup (token API, Nov 2026)

The Even G2 app calls this server at `/api/mycroft/*`. The server calls Mycroft's
per-wearer token API (`POST https://mycroftlive.mobilityae.com/api/text_input`,
`Authorization: Bearer mcg_…`). The old shared-login endpoint on port 8020 no
longer works.

## One-time setup

1. **Fixed outbound IP via the egress proxy.** Our Railway plan has no static
   outbound IPs, so Mycroft calls go through `ops/mycroft-egress-proxy` on a small
   fixed-IP machine hosted by the Mycroft admin (setup in that folder's README).
   The admin registers that machine's IP with every token. Set on Railway:

   | Variable | Value |
   |---|---|
   | `MYCROFT_PROXY_URL` | `https://<proxy-ip>:8443` |
   | `MYCROFT_PROXY_SECRET` | the proxy's shared secret (from a password manager) |
   | `MYCROFT_PROXY_CA` | the proxy's `proxy-cert.pem` (newlines may be written as `\n`) |

   Unset `MYCROFT_PROXY_URL` to call Mycroft directly (e.g. if Railway static IPs
   are ever enabled instead).
2. **Mycroft admin issues one token per wearer** (admin portal → People → Edit →
   Glasses → Issue token, with the egress proxy's IP as the relay address). Tokens start `mcg_`, last 90 days.
   Receive them through a password manager, not email or chat.
3. **Generate a relay key per wearer** (any long random string, ≥24 chars), e.g.
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
4. **Railway → Variables**:

   | Variable | Example | Notes |
   |---|---|---|
   | `MYCROFT_WEARERS` | `ceo,niranjan` | ids, comma separated |
   | `MYCROFT_TOKEN_CEO` | `mcg_…` | Mycroft token (secret) |
   | `MYCROFT_RELAY_KEY_CEO` | `Xk3…` | key that wearer's app build sends (secret) |
   | `MYCROFT_NEWS_WEARER` | `ceo` | optional; whose Mycroft runs the daily news briefing (default: first wearer) |
   | `MYCROFT_LOG_KEY` | ≥16 chars | optional; enables `GET /api/mycroft/log` with header `X-Log-Key` |

5. **Build that wearer's glasses app** with `VITE_WEARER_KEY=<their relay key>` in
   `even-hub-mycroft/.env.local`, then `npm run build && npm run pack`.

## Behaviour

- Unknown / missing `X-Wearer-Key` → 401 from the relay; Mycroft is never called.
  20 bad keys from one client in 15 min → 429 for that client.
- Mycroft 401/403 → app shows "not authorised"; that wearer's calls pause 10 min
  (`MYCROFT_AUTH_HOLD_MS`) and the server logs `[mycroft] ALERT …`. This stops a bad
  token looping into Mycroft's IP lockout (10 bad tokens / 15 min blocks the relay).
- Mycroft 429/503 → `Retry-After` is passed to the app.
- Mycroft `timeout` → "Still working — ask again"; never resent automatically.
- One question at a time per wearer.
- Logs hold status codes and timings only — no questions, answers or transcripts.
- `PERFLOG/IMGLOG/IMULOG/MINUTES` lines from older app builds are dropped, never sent.
- Client timeout is `MYCROFT_WAIT_S` (20) + 10 s.

## Rotation

Tokens expire after 90 days. When the admin issues a new one, replace
`MYCROFT_TOKEN_<ID>` on Railway within a day, then tell the admin to revoke the old one.
