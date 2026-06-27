# Commons — Setup guides

Step-by-step setup for the integrations. You set the keys in **Railway → your project → Variables**; the app picks them up on redeploy.

App URL: `https://commons-platform-ntglobal-production.up.railway.app`

| Guide | What it enables |
|---|---|
| [slack-setup.md](./slack-setup.md) | Two-way chat mirroring + notetaker delivery to Slack |
| [notetaker-setup.md](./notetaker-setup.md) | AI Minutes of Meeting (in-app now; auto-from-Zoho later) |

## Verify anything
Sidebar **📋 (Admin)** → enter the admin password (`commons-admin-2026` unless you set `ADMIN_PASSWORD`) → **Check keys**. Each integration shows green (working) or red (with the error).

> Security: never paste secrets into chat or commit them. Put them only into Railway Variables. If a secret is ever exposed, rotate it.
