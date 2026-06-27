# Notetaker setup

The **in-app notetaker** (upload a recording or paste a transcript → AI Minutes of Meeting → optional Slack) is ready and just needs keys.

The **fully-automatic path** (Zoho records a meeting → notes appear by themselves) needs the two Zoho prep steps in Part B **and** a final code wiring step that isn't built yet — once Part B is done, ask and it gets wired on.

## Part A — Make the notetaker work (in-app, ready now)
1. **Claude** (writes the minutes): <https://console.anthropic.com/settings/keys> → **Create Key** → copy (`sk-ant-…`).
2. **Groq** (free; transcribes uploaded recordings, any language → English): <https://console.groq.com/keys> → **Create API Key** → copy (`gsk_…`).
3. In **Railway → Variables**, add and redeploy:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the `sk-ant-…` key |
| `GROQ_API_KEY` | the `gsk_…` key (or use `OPENAI_API_KEY` instead) |

4. Use it: sidebar **📝** → upload a recording **or** paste a transcript → set attendees → **Generate Minutes**. Tick **Send to Slack** to post the summary + DM each owner their action items (needs the Slack setup).

Degrades gracefully: no transcription key → paste a transcript; no Claude key → basic keyword summary; no Slack token → on-screen preview only.

## Part B — Prep for automatic Zoho-recording notes (optional, your side)
These two are Zoho admin actions. After both are done, the auto poll→transcribe→post pipeline can be wired on.
5. <https://meeting.zoho.in> → **Settings → Organization → Recording** → enable **and lock** automatic cloud recording (so every Commons-created meeting records).
6. <https://api-console.zoho.in> → your app → re-authorize with scope `ZohoMeeting.meeting.CREATE,ZohoMeeting.recording.READ`, mint a fresh **refresh token**, then set in Railway:

| Variable | Value |
|---|---|
| `ZOHO_REFRESH_TOKEN` | the new refresh token (with the recording scope) |
| `ZOHO_ORG_ID` | your Zoho org id (zsoid) |

When Part B is complete, the captured meeting keys (already stored, viewable at admin `GET /api/admin/recordings`) can be polled, downloaded, transcribed, and posted automatically.

## Verify
Sidebar **📋 → Check keys** → the Claude and Transcription rows go green when their keys are set.
