# Request to ArchiveBot: a read-only feed of recent #general messages

**From:** hadoku-cardtable, 2026-10-28. **Done:** WolffM/ArchiveBot#37, shipped in ArchiveBot 891263c; the contract is the issue's last comment, and cardtable reads it in `apps/server/src/http/discord.ts`. **Re:** `ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md`.

## What for

The operator wants the front page's wildcard card to show a live snapshot of the cardtable
Discord's general chat — the last few messages and a Join Discord button. ArchiveBot is already in
that server and already signs with `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`, so it is the one place
that can read the channel without cardtable holding a bot token of its own.

## The ask

One signed read route beside the existing four:

```
GET /api/messages/recent?channel=general&limit=5
X-Hadoku-Signature: sha256=<HMAC of the query string>     (same secret, same check)
→ 200 { "messages": [ { "author": "alice", "text": "…", "at": "2026-10-28T18:02:11Z" } ] }
```

- Newest last, at most `limit` (cap it at 10), from the server `/setup` bound to cardtable only.
- Plain text: mentions resolved to display names, attachments and embeds dropped, each message
  cut to ~200 characters. No user ids, avatars or message links.
- Nothing from any channel other than the one configured as general.

cardtable's server would call it at most once a minute and cache the answer, and serve the
snapshot to friend-tier viewers only, behind the existing gate — never to the public.

## Prod only

Like the webhook secret, this runs in prod only; PPE and local dev draw the card without it.
