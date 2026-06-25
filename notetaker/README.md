# Commons Platform — Meeting Notetaker

Open-source meeting notetaker for the Commons Platform team. It:

1. **Transcribes** a meeting recording using [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (an open-source Whisper implementation, MIT-licensed).
2. **Converts Malayalam → English** — Whisper's `translate` task outputs English directly from any source language, including mixed Malayalam/English speech.
3. **Generates Minutes of Meeting** — a summary, decisions, and action items assigned per attendee (via the Claude API, with a local keyword fallback).
4. **Sends to each member** — posts the summary to a Slack channel and DMs each member their own action items (reuses the Commons Platform Slack bot).

It runs **locally** (heavy ML stays off the live Railway app) and is fully **dry-run by default** — it never messages your team unless you pass `--send`.

## Why faster-whisper?

- Open source (MIT), no cloud dependency for transcription.
- Bundles audio decoding via PyAV, so **no system `ffmpeg` install** is required on Windows.
- Runs on CPU (int8). This machine has no GPU, so expect ~real-time-ish on `medium`; `large-v3` is slower but best for Malayalam accuracy.

## Setup

```powershell
cd "C:\Users\niran\Claude\Projects\cre\commons-platform-ntglobal\notetaker"
pip install -r requirements.txt          # installs faster-whisper

copy .env.example .env                    # then fill in keys (both optional)
copy members.example.json members.json    # then fill in real Slack user IDs
```

`.env`, `members.json`, recordings, and `output/` are git-ignored.

## Usage

```powershell
# Dry run — transcribe + MoM, save files, print what WOULD be sent:
python notetaker.py meeting.m4a --attendees "Niranjan,Arun,Meera"

# Best Malayalam accuracy:
python notetaker.py meeting.m4a --model large-v3

# Real Slack delivery (needs SLACK_BOT_TOKEN + members.json with slack ids):
python notetaker.py meeting.mp4 --members members.json --send --channel "#general"
```

### Key options

| Option | Default | Meaning |
|---|---|---|
| `--model` | `medium` | Whisper size: `tiny/base/small/medium/large-v3`. Use `large-v3` for best Malayalam. |
| `--task` | `translate` | `translate` = force English; `transcribe` = keep source language. |
| `--also-original` | off | Also save a source-language (e.g. Malayalam) transcript. |
| `--brain` | `auto` | `auto` (Claude if key set, else local), `claude`, or `local`. |
| `--attendees` | roster | Comma-separated names; used as the owner set for action items. |
| `--members` | `members.json` | Roster mapping name → `slack_id`/`email`. |
| `--send` | off | Actually post to Slack. **Without it, dry-run only.** |
| `--channel` | `#general` | Slack channel for the summary post. |

## Output

Each run writes to `output/`:

- `mom-<stamp>.md` — the Minutes of Meeting (summary, decisions, action-item table, per-member tasks).
- `mom-<stamp>.json` — structured MoM (machine-readable).
- `transcript-<stamp>.en.txt` — the English transcript.
- `transcript-<stamp>.<lang>.txt` — source-language transcript (only with `--also-original`).

## How the pieces map to the Commons Platform

- **Slack delivery** reuses the same `SLACK_BOT_TOKEN` your live app uses. The bot needs `chat:write` (channel post) and `im:write` (DM members).
- **Member mapping** (`members.json`) mirrors the platform's member roster — each person's Slack user ID is how their tasks reach them.
- Future: add an "Upload recording" button in the web app (`/api/notes/upload`) that calls this tool, so meeting hosts can run it from the office UI.

## Limitations / notes

- Whisper does **not** do speaker diarization here, so task ownership is inferred by the LLM from names mentioned in the transcript + the attendee list (not from "who spoke"). Provide `--attendees` for best assignment.
- The local fallback summarizer (no Claude key) is keyword-based and noticeably weaker — set `ANTHROPIC_API_KEY` for production-quality MoM.
- First run downloads the Whisper model (medium ≈ 1.5 GB, large-v3 ≈ 3 GB) to the Hugging Face cache.
