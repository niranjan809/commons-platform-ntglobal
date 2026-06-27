# Commons — Features

Commons is a virtual team office: a 2D "meadow" where teammates appear as
avatars, see each other's presence and status in real time, bump into each
other for impromptu meetings, chat, and run meeting notes — with Slack and Zoho
Meeting wired in.

## Virtual office & presence
- Real-time multiplayer meadow (Socket.io) — everyone sees each other live; join/leave is broadcast.
- Join with name, role, team, and an animal avatar — or **Zoho SSO** ("Sign in with Zoho").
- Movement via **arrow keys / WASD** and **click-to-move**; the whole meadow fits the screen so your avatar visibly walks around.
- Ghibli-style canvas scenery — pond, trees, flowers, drifting cloud shadows, pollen, warm day-light vignette.

## Status & breaks
- Status: **Available / Busy / Break / Away** (color dot on the avatar and in the member list).
- Breaks: break **type** (lunch / coffee / BRB / focus / call), a "back in" **timer with live countdown** on the avatar, and **auto-return** when time's up.
- **Break note** — optional free-text reason ("lunch with design") shown to teammates in the member list, profile card, and admin log.
- Status and break mirror to the user's **Slack** status.

## Proximity & meetings (Zoho)
- **Proximity detection** — when two avatars get close, a **Zoho Meeting** is auto-created and both users are notified (plus a Slack ping).
- **Quick Meet** — one-click Zoho meeting from the sidebar.
- Zoho **OAuth** login with automatic access-token refresh.

## Chat
- Slack-style channels (**#general / #random / #team**) with history and **search / highlight**.
- **Two-way Slack sync** — messages mirror out to Slack, and Slack messages appear in-app (Slack Events webhook).

## Profiles
- Click any member to open their **profile card**: role, team, status, break note, and Slack / Zoho Meet links.

## AI Notetaker
- From the sidebar: upload a **recording** (any language → English) **or** paste a **transcript**.
- Generates **Minutes of Meeting** with Claude — summary, decisions, and per-person action items.
- Optional **Slack delivery** — posts the summary to a channel and DMs each owner their action items.
- Hosted Whisper transcription (Groq `whisper-large-v3` by default, or OpenAI); a standalone Python CLI variant exists for local/offline use.
- Degrades gracefully: no transcription key → paste a transcript; no Claude key → basic summary; no Slack token → preview only.

## Admin / superuser (password-gated)
- **Attendance log** with CSV export.
- **Live users** list — remove a user, or reset the whole room.
- **Integrations health check** — one-click live ping of Slack, Zoho, Claude, and transcription keys (green/red per service).

## Stack & integrations
- **Backend:** Node + Express + Socket.io.
- **Frontend:** vanilla JavaScript + HTML5 Canvas.
- **Deploy:** Railway.
- **Integrations:** Slack, Zoho Meeting, Claude (Anthropic), Groq / OpenAI Whisper.

## Configuration (environment variables)
| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Slack chat mirror, status sync, notetaker delivery |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` | Zoho Meeting (proximity huddles, Quick Meet) |
| `ANTHROPIC_API_KEY` | AI Notetaker Minutes of Meeting (Claude) |
| `GROQ_API_KEY` *or* `OPENAI_API_KEY` | In-app recording transcription |
| `ADMIN_PASSWORD` | Admin panel + health check (default `commons-admin-2026`) |
| `BASE_URL` | Public app URL / Zoho OAuth redirect URI |

Without these, the app runs in demo mode (no external API calls); the notetaker still works with a pasted transcript.
