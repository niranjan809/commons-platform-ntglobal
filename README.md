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
```

Without these, the app runs fully in demo mode (no Slack/Meet API calls).

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
