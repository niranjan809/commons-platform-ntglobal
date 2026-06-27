# Slack setup

Enables: outbound chat mirroring, inbound Slack→Commons messages, and notetaker delivery to Slack.

App URL: `https://commons-platform-ntglobal-production.up.railway.app`
Webhook URL: `https://commons-platform-ntglobal-production.up.railway.app/api/slack/events`

## A. Create the app & get the two keys
1. Open <https://api.slack.com/apps> → **Create New App** → **From scratch** → pick your workspace.
2. **OAuth & Permissions** → **Bot Token Scopes**, add:
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `im:write`
3. Top of that page → **Install to Workspace** → **Allow**. Copy the **Bot User OAuth Token** — it starts with `xoxb-…`.
   - If you only see an `xoxe-…` token, **Token Rotation** is on. Turn it off (the app expects a static token) and reinstall, then copy the `xoxb-…` token.
4. **Basic Information** → **App Credentials** → copy the **Signing Secret**.

## B. Add the keys in Railway (do this BEFORE step D)
In **Railway → Variables**, add and let it redeploy:

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | the `xoxb-…` token |
| `SLACK_SIGNING_SECRET` | the signing secret |

## C. Connect the channels
5. In Slack, create/choose **#general**, **#random**, **#team**. In each, type `/invite @YourAppName`.
6. Get each channel's ID: click the channel name → scroll to the bottom of the popup → **Channel ID** (`C0…`). Add to Railway:

| Variable | Value |
|---|---|
| `SLACK_GENERAL_ID` | the #general channel ID |
| `SLACK_RANDOM_ID` | the #random channel ID |
| `SLACK_TEAM_ID` | the #team channel ID |

## D. Turn on inbound (Slack → Commons)
7. <https://api.slack.com/apps> → your app → **Event Subscriptions** → toggle **On**.
8. **Request URL:** `https://commons-platform-ntglobal-production.up.railway.app/api/slack/events` — it should show **Verified ✓** (works because the signing secret is already set).
9. **Subscribe to bot events** → add `message.channels` → **Save Changes** (reinstall if prompted).

## E. Verify
- Sidebar **📋 → Check keys** → Slack row green.
- Or call `POST /api/slack/test` (admin-password gated) to send a real test message.
- Send a chat message in the app → it appears in the matching Slack channel, and Slack replies appear in the app.

## Gotchas
- Set `SLACK_SIGNING_SECRET` in Railway **before** verifying the Request URL (D8), or verification fails (the webhook rejects unsigned/unverifiable requests by design).
- The bot must be **invited** to each channel or posts return `not_in_channel`.
- Status-to-Slack sync is best-effort (setting a teammate's Slack status needs a user token); chat mirroring is the main path.
