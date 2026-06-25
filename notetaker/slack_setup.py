#!/usr/bin/env python3
"""
Slack helper for the Commons Platform notetaker.

  * Verifies the bot token (auth.test) — proves "taking the token" works and
    shows which workspace + bot identity it belongs to.
  * Creates a Slack channel (conversations.create) for meeting minutes.
  * Optionally posts a test message and lists channels.

Reads SLACK_BOT_TOKEN from notetaker/.env or the environment.

Usage:
  python slack_setup.py                         # just verify the token
  python slack_setup.py --create meeting-notes  # create a public channel
  python slack_setup.py --create mins --private # create a private channel
  python slack_setup.py --create notes --post "Notetaker online ✅"
  python slack_setup.py --list                  # list channels the bot can see

Required Slack scopes:
  auth.test            (any valid token)
  chat:write           (post messages)
  channels:manage      (create PUBLIC channels)   — or
  groups:write         (create PRIVATE channels)
  channels:read/groups:read (for --list)
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

API = "https://slack.com/api/"


def load_dotenv(path):
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def call(method, token, payload):
    """POST a Slack Web API method with a JSON body. Returns parsed JSON."""
    req = urllib.request.Request(
        API + method,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def auth_test(token):
    r = call("auth.test", token, {})
    if not r.get("ok"):
        print(f"  ✗ auth.test failed: {r.get('error')}")
        if r.get("error") in ("invalid_auth", "not_authed", "token_revoked"):
            print("    → the token is missing/invalid/revoked.")
        return None
    print("  ✓ token valid")
    print(f"    workspace : {r.get('team')}  (team {r.get('team_id')})")
    print(f"    bot user  : {r.get('user')}  ({r.get('user_id')})")
    print(f"    url       : {r.get('url')}")
    return r


def find_channel(token, name):
    """Return channel dict by name across public+private, or None."""
    cursor = None
    for _ in range(20):
        payload = {"types": "public_channel,private_channel", "limit": 200, "exclude_archived": True}
        if cursor:
            payload["cursor"] = cursor
        r = call("conversations.list", token, payload)
        if not r.get("ok"):
            return None
        for c in r.get("channels", []):
            if c.get("name") == name:
                return c
        cursor = (r.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    return None


def create_channel(token, name, is_private):
    r = call("conversations.create", token, {"name": name, "is_private": bool(is_private)})
    if r.get("ok"):
        ch = r["channel"]
        print(f"  ✓ created #{ch['name']}  (id {ch['id']}, {'private' if is_private else 'public'})")
        return ch
    err = r.get("error")
    if err == "name_taken":
        existing = find_channel(token, name)
        if existing:
            print(f"  • #{name} already exists (id {existing['id']}) — reusing it")
            return existing
        print(f"  • #{name} name_taken but not visible to the bot (it may be private/archived)")
        return None
    if err == "missing_scope":
        need = "groups:write" if is_private else "channels:manage"
        print(f"  ✗ missing_scope: the bot needs '{need}'.")
        print("    Add it in api.slack.com → your app → OAuth & Permissions → Scopes, then reinstall the app.")
        return None
    print(f"  ✗ conversations.create failed: {err}")
    return None


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, ".env"))

    ap = argparse.ArgumentParser(description="Verify Slack token and create a channel.")
    ap.add_argument("--create", metavar="NAME", help="Channel name to create (lowercase, no spaces).")
    ap.add_argument("--private", action="store_true", help="Create a private channel.")
    ap.add_argument("--post", metavar="TEXT", help="Post a message to the created channel.")
    ap.add_argument("--list", action="store_true", help="List channels the bot can see.")
    args = ap.parse_args()

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        sys.exit("SLACK_BOT_TOKEN not set. Add it to notetaker/.env or the environment.")

    print("[1] Verifying token (auth.test)…")
    if not auth_test(token):
        sys.exit(1)

    channel = None
    if args.create:
        name = args.create.lower().replace(" ", "-")
        print(f"\n[2] Creating channel #{name}…")
        channel = create_channel(token, name, args.private)
        if not channel:
            sys.exit(2)

    if args.post and channel:
        print(f"\n[3] Posting message to #{channel['name']}…")
        r = call("chat.postMessage", token, {"channel": channel["id"], "text": args.post})
        print(f"  {'✓ posted' if r.get('ok') else '✗ ' + str(r.get('error'))}")

    if args.list:
        print("\n[*] Channels visible to the bot:")
        r = call("conversations.list", token, {"types": "public_channel,private_channel", "limit": 100})
        if r.get("ok"):
            for c in sorted(r.get("channels", []), key=lambda c: c.get("name", "")):
                vis = "🔒" if c.get("is_private") else "#"
                print(f"    {vis}{c.get('name')}  (id {c.get('id')})")
        else:
            print(f"  ✗ {r.get('error')}")

    if channel:
        print(f"\nUse it with the notetaker:  python notetaker.py meeting.m4a --send --channel \"#{channel['name']}\"")
    print("\nDone.")


if __name__ == "__main__":
    main()
