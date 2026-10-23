# Discord integration

The operator's words are quoted verbatim. **Design** is ours and may change.

## The ask (2026-10-23, verbatim)

> lets get started working on discord integration. we need to expose a discord icon at the top of the
> page, let's put it between the theme and settings icons (let's make sure that hadoku_site knows about
> this and adjusts the child app templates accordingly so that our top bar is modular enough to allow
> putting stuff up there.
>
> then we'll need to actually set up the discord server.
>
> theres a bunch of discord automation we'll need like posting patch notes and creating tournament
> events, that stuff i'm hoping can be handled by archivebot.

## Three tracks

| # | Track | Owner | State |
| --- | --- | --- | --- |
| 1 | Discord icon in the top bar, between theme picker and gear | hadoku-task (lib), hadoku_site (contract, templates), then cardtable | Request sent: `docs/requests/HADOKU_SITE_HEADER_LINKS.md` |
| 2 | The Discord server itself | operator (create), ArchiveBot (channels/roles/invite) | Layout proposed below; needs the operator to create the guild |
| 3 | Automation: patch notes, tournament events, later linking + room announcements | ArchiveBot | Request sent: `ArchiveBot/docs/requests/CARDTABLE_DISCORD_INTEGRATION.md` (copy in `docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION.md`) |

## 1. Top bar

`AppHeader` (`@wolffm/task-ui-components`) renders the theme picker and gear itself, and its only app
slot (`status`) sits *left* of the picker. The operator's placement needs a new slot, so the change is
upstream: a typed `links` prop rendered between picker and gear, and a `discord` glyph in
`@wolffm/themes` (whose registry is Lucide-only, and Lucide ships no brand marks). Details are in the request.

cardtable's own change, once both packages publish, is one prop in `apps/ui/src/App.tsx`, or nothing
if the templates read links from the catalogue.

## 2. The server

**The operator creates the guild in the Discord client.** Bots cannot create guilds, so this step can't be
automated. Then invite ArchiveBot to it with the permissions it already uses elsewhere (Manage
Events, Manage Channels, Manage Roles, Create Invite, Manage Guild, Send/View; never Administrator).

Proposed layout. This is a design proposal; the operator rules on it.

| Category | Channel | Purpose |
| --- | --- | --- |
| Info | `#announcements` (read-only) | Patch notes, posted by ArchiveBot on deploy |
| Info | `#events` (read-only) | Tournament / draft-night announcements; the scheduled events themselves live in the Events tab |
| Table | `#general` | Chat |
| Table | `#looking-for-game` | "anyone up for a draft?" |
| Table | `#bugs-and-feedback` | Playtest reports. These still go into `docs/planning/playtest-ledger.md` |
| Voice | `Table 1`, `Table 2` | Voice during matches |

Roles: `Player` (everyone), `Admin` (the operator). This is a friend group, so there's no tiering beyond that.

**Friend gate.** The invite only appears on a friend-tier page, so the gate holds at the edge. It's
still a permanent link that can be forwarded. ArchiveBot already binds invites to roles on join
(`index.js:212`), which is enough to see who joined through it.

## 3. Automation (ArchiveBot)

What ArchiveBot already does, verified in its source by the 2026-10-23 survey:

- **Plain-text posts:** `POST /api/messages/send` (≤2000 chars, no embeds, no mentions, 7-day dedupe).
- **Scheduled events:** `/api/events/create` and `/api/events/update` (External events, reminder lead
  time, start announcement, reschedule or cancel by `scheduledEventId`).
- **Auth and reachability:** both are HMAC-signed with a timestamp and idempotency key, served on
  127.0.0.1:3004 and `https://archivebot.hadoku.me`. Secrets come from the vault through
  `hadoku_site/services/pm2/archive-bot-wrapper.mjs`.

So **patch notes and tournament events need no new Discord code.** What is missing:

1. **A cardtable secret.** Without it, cardtable would have to borrow `ARCHIVEBOT_EVENTS_WEBHOOK_SECRET`,
   meet's secret. The spaces precedent is one secret per caller/capability.
2. **Embeds** for patch notes. 2000 chars of plain text is tight for a release.
3. **Guild bootstrap:** ensure-channel, ensure-role and a permanent invite. Without it, track 2 is
   done by hand.
4. **Later:** Discord ↔ hadoku identity linking (`/link <code>`), for tournament sign-ups and pings.

On cardtable's side:

- **Patch-notes source (open question).** cardtable has no curated release notes, and commit
  subjects are engineering prose. Candidates: the operator's ✅ rows in
  `docs/planning/playtest-ledger.md` since the last post, or a hand-written
  `docs/patch-notes/<version>.md` that the land step posts if present. The operator chooses.
- **Tournament events.** Tournament mode (`docs/planning/tournament-mode-plan.md`) has no
  scheduled-start concept yet; today a room locks its seats when the host decides. An event needs a
  start time. So either a "schedule this tournament" action that calls `/api/events/create`, or
  hand-made events in Discord to start with.
- **Caller.** The server's PM2 wrapper (`hadoku_site/services/pm2/cardtable-wrapper.mjs`) gets the new
  secret from the vault, and the server calls loopback 3004. The reference signer is
  `hadoku-meet/worker/src/lib/archivebot.ts` (`signedPost`).
