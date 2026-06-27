# Commons — Desktop app

A native desktop app (Windows / macOS / Linux) built with Electron. It loads the
real Commons web app in a native window, so **every feature works** — meadow
movement, chat, Slack/Zoho, the AI notetaker, search, shortcuts, the redesign —
with no duplicated code. It adds native niceties: a real app window with saved
size/position, an app menu, OS-browser hand-off for meeting/Slack links, and
native OS notifications for DMs and proximity huddles.

## Run it (dev)

```bash
cd desktop
npm install
npm start                 # opens the production app in a native window
```

Point it at a different server (e.g. local dev) with an env var:

```bash
# Windows (PowerShell)
$env:COMMONS_URL = "http://localhost:3000"; npm start
# macOS / Linux
COMMONS_URL=http://localhost:3000 npm start
```

Default URL: `https://commons-platform-ntglobal-production.up.railway.app`

## Build installers

```bash
cd desktop
npm install
npm run dist          # current OS  (or dist:win / dist:mac)
```

Output (installers / app images) lands in `desktop/dist/`.

## How it works
- `main.js` opens a `BrowserWindow` and loads `COMMONS_URL`.
- External links (Zoho meeting links, Slack deep links) open in your default
  browser; the same-host Zoho **OAuth popup** opens as a child window so its
  `postMessage` handshake completes.
- Window size/position is remembered between launches.
- Because it loads the shared server, everyone in the desktop app and the web
  app sees the same live room.

## Notes
- It's a thin native shell, not a separate codebase — UI/feature changes ship
  from the web app automatically.
- A from-scratch **mobile-native** app (React Native) would be a separate, much
  larger project (the 2D canvas + realtime UI would be rebuilt). For mobile now,
  the web app is installable as a PWA-style shortcut.
