# Mycroft glasses relay — setup (token API, Nov 2026)

The Even G2 app calls this server at `/api/mycroft/*`. The server calls Mycroft's
per-wearer token API (`POST https://mycroftlive.mobilityae.com/api/text_input`,
`Authorization: Bearer mcg_…`). The old shared-login endpoint on port 8020 no
longer works.

## One-time setup

1. **Fixed outbound IP via the Mycroft proxy.** Our Railway plan has no static
   outbound IPs, so Mycroft calls go through a CONNECT proxy with a fixed address
   run by the Mycroft admin (`mycroftstaging.mobilityae.com:8443`, IP
   `43.205.60.23`, publicly trusted certificate). Set on Railway as a **sealed**
   variable:

   | Variable | Value |
   |---|---|
   | `MYCROFT_PROXY_URL` | `https://glasses:<secret>@mycroftstaging.mobilityae.com:8443`, exactly as received (it contains the proxy secret; never log it) |

   `MYCROFT_PROXY_SECRET` / `MYCROFT_PROXY_CA` are only for a self-hosted
   `ops/mycroft-egress-proxy` with a self-signed certificate. Unset
   `MYCROFT_PROXY_URL` to call Mycroft directly. Proxy 407 (wrong/old URL) pauses
   all glasses calls for 10 min and logs `[mycroft] ALERT`; 429 → wait 60 s;
   502/503 → retry in 5 s.
2. **Mycroft admin issues one token per wearer** (admin portal → People → Edit →
   Glasses → Issue token, relay address `43.205.60.23`). Tokens start `mcg_`, last 90 days.
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

## CEO brief and meeting cues (Nov 2026)

Both run on the relay and are reviewed on **`/ops-console.html`**. Open it and
enter `OPS_CONSOLE_KEY` (the key is kept only for that browser tab).

### Railway variables

| Variable | Example | Notes |
|---|---|---|
| `OPS_CONSOLE_KEY` | ≥16 chars | Required for the console. Treat it as a secret and seal it |
| `OPENROUTER_API_KEY` | `sk-or-…` | Already set for speech-to-text; also used for topic spotting, web search and claim checks |
| `MYCROFT_BRIEF_WEARER` | `ceo` | Whose Mycroft answers the KPI questions (default: `MYCROFT_NEWS_WEARER`) |
| `MYCROFT_CUE_WEARER` | `cue` | A separate token for cue lookups, so they don't clash with the wearer's own questions or show in their chat. Default: the wearer |
| `BRIEF_TIMES` | `07:00,13:00` | Build times, Dubai |
| `BRIEF_REVIEW_MIN` | `30` | Draft → live after this; `0` = publish at once |
| `BRIEF_THRESHOLD_PCT` | `10` | KPI change vs same day last week that makes an item critical |
| `BRIEF_KPIS` | `Trips,Fleet on road,…` | KPIs asked of Mycroft |
| `CUE_MODE` | `assisted` | `assisted`: every cue needs approval. `auto`: DTC-data cues go straight to the glasses; web cues still need approval |
| `CUE_INTERVAL_MS` | `45000` | How often the topic is checked during a meeting |
| `SOURCE_ALLOWLIST` | `rta.ae,wam.ae,…` | Domains outside facts may come from (default list in `grounding.js`) |
| `OPENROUTER_LLM_MODEL` | `anthropic/claude-haiku-5.5` | Model for topic, drafting and checks |

### Grounding rules (grounding.js)

- Numbers in a cue or brief line must appear in the source it came from.
- A second model pass checks every claim against the sources. If anything is
  unsupported, nothing is shown.
- Outside facts come only from allow-listed domains, through a cited page.
- KPI figures are parsed from Mycroft's reply. "n/a" is left out, never guessed.
- A source that fails is named in the brief ("ops data unavailable 07:00").

### Privacy

- Meeting transcript segments are held in memory for 2 minutes. They are
  dropped on `/cue/stop` or after 10 idle minutes, and never logged.
- Web searches get topic keywords only, with digits removed. They never get
  the transcript or internal figures.
- Logs keep status only.
