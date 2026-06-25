#!/usr/bin/env python3
"""
Commons Platform — open-source meeting notetaker.

Pipeline:
  1. Transcribe a meeting recording with faster-whisper (open-source Whisper).
     Whisper's `translate` task converts ANY source language (incl. Malayalam,
     and mixed Malayalam/English) directly to English.
  2. Turn the English transcript into Minutes of Meeting (summary + decisions +
     action items assigned per attendee) using the Claude API, with a local
     keyword fallback if no API key is configured.
  3. Save the MoM as Markdown, and (with --send) post the summary to a Slack
     channel and DM each member their own action items.

Usage:
  python notetaker.py RECORDING [options]

Examples:
  # Dry run (transcribe + MoM, save file, print what would be sent):
  python notetaker.py meeting.m4a --attendees "Niranjan,Arun,Meera"

  # Real send to Slack (needs SLACK_BOT_TOKEN + members.json with slack ids):
  python notetaker.py meeting.mp4 --members members.json --send --channel "#general"

Common options:
  --model {tiny,base,small,medium,large-v3}   Whisper model (default: medium;
                                              use large-v3 for best Malayalam).
  --task {translate,transcribe}               translate=force English output
                                              (default); transcribe=keep source.
  --also-original                             Also produce a source-language
                                              transcript alongside the English.
  --brain {auto,claude,local}                 MoM engine (default: auto =
                                              Claude if key set, else local).
  --attendees "A,B,C"                         Attendee names (owners for tasks).
  --members members.json                      Roster: name -> slack_id/email.
  --send                                      Actually send to Slack (else dry).
  --channel "#general"                        Slack channel for the summary.
  --out output                                Output directory (default: output).

Env (notetaker/.env or shell):
  ANTHROPIC_API_KEY   enables the Claude MoM brain
  ANTHROPIC_MODEL     override model id (default: claude-sonnet-4-6)
  SLACK_BOT_TOKEN     enables Slack delivery (chat:write, im:write)
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime

# Windows consoles default to cp1252 and crash on Unicode (→, —) in prints.
# Saved files are always UTF-8; this just makes console output safe.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

DEFAULT_MODEL = "medium"
DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
SLACK_POST_URL = "https://slack.com/api/chat.postMessage"


# ── tiny .env loader (no external dependency) ─────────────────────────────────
def load_dotenv(path):
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


# ── step 1: transcription + translation ──────────────────────────────────────
def transcribe(audio_path, model_size, task, language=None):
    """Returns (text, detected_language, language_probability)."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed. Run: pip install -r requirements.txt")

    print(f"[1/3] Loading Whisper model '{model_size}' (CPU/int8)…", flush=True)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    print(f"[1/3] Transcribing (task={task})…", flush=True)
    segments, info = model.transcribe(
        audio_path,
        task=task,            # "translate" => English output from any language
        language=language,    # None => auto-detect
        beam_size=5,
        vad_filter=True,      # skip long silences
    )
    parts = [seg.text.strip() for seg in segments]
    text = " ".join(p for p in parts if p).strip()
    return text, info.language, round(info.language_probability, 3)


# ── step 2: Minutes of Meeting ────────────────────────────────────────────────
MOM_SCHEMA_HINT = (
    "Return ONLY valid JSON, no markdown fences, with this exact shape:\n"
    "{\n"
    '  "summary": "2-4 sentence plain-English overview",\n'
    '  "decisions": ["decision 1", "decision 2"],\n'
    '  "action_items": [\n'
    '     {"owner": "<attendee name or \\"Unassigned\\">", "task": "...", "due": "<date/empty>"}\n'
    "  ]\n"
    "}\n"
)


def claude_mom(transcript, attendees, api_key, model_id):
    system = (
        "You are an expert meeting-minutes assistant. Produce concise, accurate "
        "Minutes of Meeting from a transcript. Assign each action item to the most "
        "likely owner from the provided attendee list; use \"Unassigned\" if unclear. "
        "Do not invent tasks that are not supported by the transcript."
    )
    att = ", ".join(attendees) if attendees else "(not provided — infer names from transcript)"
    user = (
        f"Attendees: {att}\n\n"
        f"Transcript (English):\n\"\"\"\n{transcript}\n\"\"\"\n\n"
        f"{MOM_SCHEMA_HINT}"
    )
    body = {
        "model": model_id,
        "max_tokens": 2000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return _parse_json_block(text)


def _parse_json_block(text):
    text = text.strip()
    # strip ```json fences if present
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]
    return json.loads(text)


_ACTION_RE = re.compile(
    r"\b(will|to|should|need to|needs to|going to|action|follow[- ]?up|"
    r"assign|responsible|by (?:monday|tuesday|wednesday|thursday|friday|"
    r"saturday|sunday|tomorrow|next week|eod|end of))\b",
    re.IGNORECASE,
)


def local_mom(transcript, attendees):
    """Keyword fallback when no Claude key is available."""
    sentences = re.split(r"(?<=[.!?])\s+", transcript)
    sentences = [s.strip() for s in sentences if s.strip()]
    summary = " ".join(sentences[:4]) if sentences else "(empty transcript)"

    action_items = []
    names = [a.strip() for a in attendees] if attendees else []
    for s in sentences:
        if _ACTION_RE.search(s):
            owner = "Unassigned"
            for n in names:
                first = n.split()[0]
                if re.search(r"\b" + re.escape(first) + r"\b", s, re.IGNORECASE):
                    owner = n
                    break
            action_items.append({"owner": owner, "task": s, "due": ""})

    return {
        "summary": summary,
        "decisions": [],
        "action_items": action_items[:25],
        "_engine": "local-fallback",
    }


def build_mom(transcript, attendees, brain, api_key, model_id):
    if brain == "claude" or (brain == "auto" and api_key):
        if not api_key:
            sys.exit("--brain claude requires ANTHROPIC_API_KEY.")
        print(f"[2/3] Generating MoM with Claude ({model_id})…", flush=True)
        try:
            mom = claude_mom(transcript, attendees, api_key, model_id)
            mom.setdefault("_engine", "claude:" + model_id)
            return mom
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:300]
            print(f"  ! Claude API error {e.code}: {detail}\n  ! Falling back to local summarizer.", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"  ! Claude call failed ({e}); falling back to local summarizer.", flush=True)
    print("[2/3] Generating MoM with local keyword summarizer…", flush=True)
    return local_mom(transcript, attendees)


# ── per-member grouping ───────────────────────────────────────────────────────
def group_by_member(action_items, members):
    """member name -> list of task strings. Matches owner to roster by first name."""
    grouped = {}
    roster_names = list(members.keys())
    for item in action_items:
        owner = (item.get("owner") or "Unassigned").strip()
        matched = None
        for name in roster_names:
            if name.lower() == owner.lower() or name.split()[0].lower() == owner.split()[0].lower():
                matched = name
                break
        key = matched or owner
        task = item.get("task", "").strip()
        if item.get("due"):
            task += f"  _(due: {item['due']})_"
        grouped.setdefault(key, []).append(task)
    return grouped


# ── rendering ─────────────────────────────────────────────────────────────────
def render_markdown(mom, meta, grouped):
    lines = []
    lines.append(f"# Minutes of Meeting — {meta['date']}")
    lines.append("")
    lines.append(f"- **Recording:** `{meta['audio']}`")
    lines.append(f"- **Detected language:** {meta['language']} (p={meta['lang_prob']})")
    lines.append(f"- **MoM engine:** {mom.get('_engine', 'unknown')}")
    if meta.get("attendees"):
        lines.append(f"- **Attendees:** {', '.join(meta['attendees'])}")
    lines.append("")
    lines.append("## Summary")
    lines.append(mom.get("summary", "(none)"))
    lines.append("")
    decisions = mom.get("decisions") or []
    if decisions:
        lines.append("## Decisions")
        for d in decisions:
            lines.append(f"- {d}")
        lines.append("")
    lines.append("## Action Items")
    items = mom.get("action_items") or []
    if items:
        lines.append("| Owner | Task | Due |")
        lines.append("|---|---|---|")
        for it in items:
            lines.append(f"| {it.get('owner','Unassigned')} | {it.get('task','')} | {it.get('due','') or '—'} |")
    else:
        lines.append("_No action items detected._")
    lines.append("")
    lines.append("## Per-member tasks")
    for member, tasks in grouped.items():
        lines.append(f"### {member}")
        for t in tasks:
            lines.append(f"- {t}")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


# ── step 3: Slack delivery ────────────────────────────────────────────────────
def slack_post(token, channel, text):
    req = urllib.request.Request(
        SLACK_POST_URL,
        data=json.dumps({"channel": channel, "text": text}).encode("utf-8"),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def deliver(mom, meta, grouped, members, channel, token, send):
    summary_text = (
        f"*Minutes of Meeting — {meta['date']}*\n\n"
        f"{mom.get('summary','')}\n\n"
        f"*Action items:* {len(mom.get('action_items') or [])}"
    )
    print("\n[3/3] Delivery")
    if not send:
        print("  (dry-run — pass --send to actually post to Slack)")
        print(f"  → would post summary to channel: {channel}")
        for member, tasks in grouped.items():
            target = members.get(member, {}).get("slack_id", "<no slack_id in members.json>")
            print(f"  → would DM {member} ({target}) with {len(tasks)} task(s)")
        return

    if not token:
        print("  ! SLACK_BOT_TOKEN not set — cannot send. Skipping.")
        return

    r = slack_post(token, channel, summary_text)
    print(f"  → summary to {channel}: {'ok' if r.get('ok') else 'FAILED: ' + str(r.get('error'))}")
    for member, tasks in grouped.items():
        slack_id = members.get(member, {}).get("slack_id")
        if not slack_id:
            print(f"  → {member}: no slack_id in members.json — skipped DM")
            continue
        dm = "*Your action items from today's meeting:*\n" + "\n".join(f"• {t}" for t in tasks)
        r = slack_post(token, slack_id, dm)
        print(f"  → DM {member}: {'ok' if r.get('ok') else 'FAILED: ' + str(r.get('error'))}")


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, ".env"))

    ap = argparse.ArgumentParser(description="Open-source meeting notetaker (transcribe → MoM → Slack).")
    ap.add_argument("audio", help="Path to meeting recording (audio or video).")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="Whisper model size (default: medium; large-v3 best for Malayalam).")
    ap.add_argument("--task", default="translate", choices=["translate", "transcribe"], help="translate=English output (default).")
    ap.add_argument("--language", default=None, help="Force source language code (e.g. ml). Default: auto-detect.")
    ap.add_argument("--also-original", action="store_true", help="Also produce a source-language transcript.")
    ap.add_argument("--brain", default="auto", choices=["auto", "claude", "local"], help="MoM engine.")
    ap.add_argument("--attendees", default="", help="Comma-separated attendee names.")
    ap.add_argument("--members", default=os.path.join(here, "members.json"), help="Roster JSON (name -> slack_id/email).")
    ap.add_argument("--send", action="store_true", help="Actually send to Slack (default: dry-run).")
    ap.add_argument("--channel", default="#general", help="Slack channel for the summary.")
    ap.add_argument("--out", default=os.path.join(here, "output"), help="Output directory.")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        sys.exit(f"Recording not found: {args.audio}")

    attendees = [a.strip() for a in args.attendees.split(",") if a.strip()]
    members = {}
    if os.path.isfile(args.members):
        with open(args.members, "r", encoding="utf-8") as fh:
            members = json.load(fh)
    # If no explicit attendees, use the roster names.
    if not attendees and members:
        attendees = list(members.keys())

    # 1. transcribe (+ translate)
    text, lang, prob = transcribe(args.audio, args.model, args.task, args.language)
    print(f"  detected language: {lang} (p={prob}); {len(text)} chars of {'English' if args.task=='translate' else lang} text")

    original_text = None
    if args.also_original and args.task == "translate":
        original_text, _, _ = transcribe(args.audio, args.model, "transcribe", args.language)

    if not text:
        sys.exit("Transcription produced no text — check the recording.")

    # 2. MoM
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    model_id = os.environ.get("ANTHROPIC_MODEL", DEFAULT_CLAUDE_MODEL)
    mom = build_mom(text, attendees, args.brain, api_key, model_id)

    # group per member (use roster if present, else owners themselves)
    grouped = group_by_member(mom.get("action_items") or [], members or {})

    meta = {
        "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "audio": os.path.basename(args.audio),
        "language": lang,
        "lang_prob": prob,
        "attendees": attendees,
    }

    # 3. render + save
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    md = render_markdown(mom, meta, grouped)
    md_path = os.path.join(args.out, f"mom-{stamp}.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md)
    # also dump the transcript(s) + structured json for the record
    with open(os.path.join(args.out, f"transcript-{stamp}.en.txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    if original_text:
        with open(os.path.join(args.out, f"transcript-{stamp}.{lang}.txt"), "w", encoding="utf-8") as fh:
            fh.write(original_text)
    with open(os.path.join(args.out, f"mom-{stamp}.json"), "w", encoding="utf-8") as fh:
        json.dump(mom, fh, ensure_ascii=False, indent=2)

    print(f"\nSaved MoM      → {md_path}")
    print(f"Saved JSON     → {os.path.join(args.out, f'mom-{stamp}.json')}")
    print(f"Saved English  → {os.path.join(args.out, f'transcript-{stamp}.en.txt')}")

    # delivery
    token = os.environ.get("SLACK_BOT_TOKEN")
    deliver(mom, meta, grouped, members or {}, args.channel, token, args.send)

    print("\nDone.")


if __name__ == "__main__":
    main()
