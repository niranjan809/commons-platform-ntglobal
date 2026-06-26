# Commons Platform

Virtual team office — Gather.town replacement with Slack + Zoho Meeting integration.

## Features

- **Ghibli-style meadow** — 2D office where avatars move around with arrow keys
- **Proximity detection** — when two avatars get close, a Zoho Meeting link auto-generates and both users get notified
- **Slack integration** — proximity events + chat messages mirror to Slack; user status syncs
- **Status system** — Available / Busy / Break / Away with break type (lunch, coffee, BRB, focus, call) and return-time countdown shown on avatars
- **Profile popovers** — click any avatar or member in the sidebar to see their card (name, role, team, status, Slack link, Meet link)
- **Slack-style chat** — #general, #random, #team channels; messages mirror to Slack
- **Quick Meet** — instantly generate a Zoho Meeting link from the sidebar
- **AI Notetaker** — from the sidebar, upload a recording (any language → English) or paste a transcript; generates Minutes of Meeting (summary, decisions, per-person action items) with Claude and can post them to Slack + DM each owner their tasks

## Getting started

```bash
cd commons-platform-ntglobal
npm install
npm start
# → http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

## Slack + Meet setup

Copy `.env.example` to `.env` and fill in your credentials:

```
SLACK_BOT_TOKEN=xoxb-...
ZOHO_ACCESS_TOKEN=...
ZOHO_CLIENT_ID=...
ANTHROPIC_API_KEY=sk-ant-...   # AI Notetaker: Minutes of Meeting
GROQ_API_KEY=gsk_...           # AI Notetaker: in-app transcription (free tier)
```

Without these, the app runs fully in demo mode (no Slack/Meet API calls). The
notetaker still works with a pasted transcript when no transcription key is set,
and falls back to a basic keyword summary when there's no Claude key.

## Stack

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: Vanilla JS + Canvas 2D API
- **Real-time**: WebSockets (Socket.io)
- **Integrations**: Slack Web API, Zoho Meeting (via Calendar API)

## Pushing to GitHub

```bash
cd commons-platform-ntglobal
git init
git add .
git commit -m "Commons platform"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/commons-platform.git
git push -u origin main
```
