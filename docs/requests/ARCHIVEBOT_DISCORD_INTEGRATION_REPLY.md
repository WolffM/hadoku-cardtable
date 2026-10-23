# Reply from ArchiveBot: cardtable's Discord server

**To:** hadoku-cardtable, re `docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION.md`
**From:** ArchiveBot, 2026-10-23
**Shipped:** `WolffM/ArchiveBot@3f7b300`, deployed and running

Asks 1–3 are done. Ask 4 is a design note, at the end. Two things still stand between this and a
first post: the operator inviting the bot and running `/setup` (section 3), and the vault secret
(section 4).

## 1. Auth: `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`

Ask 1 offered two shapes: a second accepted secret on the existing routes, or an
`/api/cardtable/*` alias group. ArchiveBot took the first, so the routes are the same four meet
uses: `/api/messages/send` and `/api/events/{create,update,channels}`. Each one accepts either
secret, and **the secret that verifies identifies the caller**.

Signing is unchanged from meet's (`hadoku-meet/worker/src/lib/archivebot.ts` `signedPost` is the
reference):

```
POST http://127.0.0.1:3004/<route>        (or https://archivebot.hadoku.me/<route>)
Content-Type: application/json
X-Hadoku-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed by the secret>
```

Every body carries `timestamp`, epoch **milliseconds** within ±10 minutes. The two write routes
also carry `idempotencyKey`. Anything older is `400 stale_timestamp`.

**Scope.** A cardtable-signed request is pinned to the guild where `/setup cardtable` was run.
ArchiveBot records it then, so there is no guild-id env var to keep in sync.

| `guild_id` in the body | result |
| --- | --- |
| absent | the cardtable guild |
| the cardtable guild | honoured |
| any other guild | `403 guild_not_permitted` |

A `channel_id` from another guild is refused too (`500 channel_not_in_guild`, the check meet's
path already has). Before `/setup` has run, every cardtable request answers
`503 cardtable_guild_not_set_up`.

**Fail-closed.** While the secret is unset, cardtable isn't a candidate caller at all, so its
requests fail the signature check: `401 invalid_signature`, logged as `log.fail`. ArchiveBot logs
`cardtable_caller_disabled` at boot until the key exists. That is the state right now.

## 2. Route shapes

### `POST /api/messages/send`

```jsonc
{
  "idempotencyKey": "cardtable-release-v0.33.0", // 7-day dedupe, unchanged
  "timestamp": 1792792800000,
  "source": "cardtable",                         // optional; lands in logs and the ledger
  "content": "…",                                // optional when embeds is present; ≤2000
  "embeds": [ /* see the schema below */ ],        // optional; cardtable's secret only
  "channel_id": "…",                             // optional; defaults to #announcements
  "guild_id": "…"                                // optional; must be the cardtable guild
}
```

| Status | Body |
| --- | --- |
| 200 | `{ success: true, messageId }`, or `{ success: true, messageId, deduped: true }` for a key already delivered |
| 400 | `invalid_content` · `invalid_embeds` (+ `detail`) · `embeds_not_permitted` · `missing_idempotency_key` · `stale_timestamp` · `invalid_json` |
| 401 | `invalid_signature` |
| 403 | `guild_not_permitted` |
| 500 | `channel_not_found` · `channel_not_in_guild` · `channel_not_sendable` · `missing_send_permission` · `message_send_failed` |
| 503 | `cardtable_guild_not_set_up` · `discord_rate_limited` |

Mentions stay off (`allowedMentions: { parse: [] }`). Discord never pings from embed text anyway.
A send Discord refused (permissions, rate limit, other) mirrors `alert.archivebot.message` to the
ledger. A 4xx refusal doesn't.

**One caution about PPE.** If `cardtable-ppe` also holds this secret and posts its own boot notes,
they land in the same #announcements. A PPE key (`cardtable-ppe-release-…`) is a *different* key,
so the dedupe won't catch it, and players would see each release twice. Only prod should post
release notes, or PPE should post to a channel of its own via `channel_id`.

### Embed schema

Accepted keys only. Anything else, at any depth, is `400 invalid_embeds` with a `detail` that names
the path, e.g. `"embeds[0].image is not accepted"`.

| Key | Rule |
| --- | --- |
| `embeds` | array, 1–10 |
| `title` | non-blank string, ≤256 |
| `description` | non-blank string, ≤4096 |
| `url` | `http:` or `https:` URL, ≤2048 |
| `color` | integer `0`–`16777215` (`0xRRGGBB`) |
| `fields[]` | ≤25; each `{ name ≤256, value ≤1024, inline?: boolean }`, name and value non-blank |
| `footer` | `{ text }` only, text ≤2048 (no `icon_url`) |
| `timestamp` | ISO 8601 string; normalised to `toISOString()` |

Each embed needs at least one of `title`, `description` or `fields`. Discord rejects an embed with
nothing to show. The total of titles, descriptions, field names and values, and footer text across
all embeds must be ≤6000, which is Discord's own cap, checked here so the failure is a 400 you can
read. Refused: `image`, `thumbnail`, `author`, `video`, `provider`, `footer.icon_url`, and anything
else not in the table.

**v0.33.0 as a payload.** The notes body is 583 bytes, well inside one description. This exact
shape is a test in ArchiveBot (`tests/cardtableWebhook.test.js`):

```json
{
  "idempotencyKey": "cardtable-release-v0.33.0",
  "timestamp": 1792792800000,
  "source": "cardtable",
  "embeds": [{
    "title": "v0.33.0 — first versioned release",
    "description": "Card Table now has releases. …\n\n## New\n\n- **A preview table** at `hadoku.me/cardtable-ppe/`. …",
    "url": "https://hadoku.me/cardtable/",
    "color": 3114330,
    "footer": { "text": "Card Table v0.33.0" },
    "timestamp": "2026-10-23T18:00:00Z"
  }]
}
```

Discord renders `##` headings and `-` lists in an embed description, so the release file can go in
as written, minus its `# v0.33.0 — …` line, which becomes the `title`. If notes ever exceed 4096,
split at a `##` heading into a second embed, or into `fields`, rather than truncating.

### `POST /api/events/create`

The same shape as meet's. With the cardtable secret, the guild defaults to the cardtable guild and
the announcement channel to **#events**.

```jsonc
{
  "idempotencyKey": "cardtable-tournament-<id>",
  "timestamp": 1792792800000,
  "name": "Friday draft",                  // ≤100
  "startTime": "2026-10-30T02:00:00Z",     // future
  "endTime":   "2026-10-30T05:00:00Z",     // after start
  "description": "…",                      // optional, truncated at 1000
  "location": "hadoku.me/cardtable",       // optional, ≤100; defaults to name
  "remindBeforeMs": 3600000,               // optional, ≤30 days: an advance reminder post
  "channel_id": "…"                        // optional; defaults to #events
}
```

→ `200 { success, eventId, url, reminderCreated }`. A repeated key returns
`{ success, eventId, deduped: true }`. Keep `eventId`: it's how update finds the event.

### `POST /api/events/update`

`{ idempotencyKey, timestamp, scheduledEventId, cancel: true }` cancels. Otherwise send the full
create field set to reschedule. → `200 { success, eventId, url, reminderActive }`, or
`{ …, cancelled: true }`. Errors include `404 event_not_tracked`, for an id that create never
returned in this guild.

### `POST /api/events/channels`

`{ timestamp, guild_id? }` → `200 { success, channels: [{ id, name, parentName }] }`. These are the
text channels and threads in the cardtable guild that the bot can post in, in sidebar order. Use it
to discover ids. With the setup defaults you shouldn't need any.

## 3. Guild setup: `/setup layout:cardtable`

Ask 3 offered an `/api/guild/*` route group or an admin slash command. It's the slash command, as
you suggested: this is a once-per-guild action, so it gets no HTTP surface and no third secret.

**Step 1: the operator invites the bot.** The guild exists (`1563307288406786078`), but ArchiveBot
isn't in it yet. This link pre-selects that server:

```
https://discord.com/oauth2/authorize?client_id=1313904906150744074&scope=bot+applications.commands&permissions=8858455089&guild_id=1563307288406786078&disable_guild_select=true
```

ArchiveBot now registers its commands on `guildCreate`, so `/setup` appears as soon as the bot
joins. No restart needed.

**Bot permissions (integer `8858455089`).** Never Administrator.

| Permission | Why |
| --- | --- |
| View Channels, Send Messages, Read Message History | posting, and the channel picker's checks |
| Embed Links | embeds; the bot also grants itself this on the read-only channels |
| Manage Channels | creating and moving channels and categories |
| Manage Roles | creating Player/Admin, assigning them, and the read-only overwrites |
| Create Invite | the permanent invite |
| Manage Server | reading the invite list, which the invite→Player binding diffs on every join |
| Manage Events | `/api/events/create` and `/api/events/update` |

**Gateway intents.** These are app-wide and already enabled, since the bot runs with them today.
There's nothing to toggle for this guild:

| Intent | Notes |
| --- | --- |
| `Guilds`, `GuildMessages`, `GuildMessageReactions`, `GuildScheduledEvents` | standard |
| `MessageContent` | privileged, portal-enabled |
| `GuildMembers` | privileged, portal-enabled; `guildMemberAdd` is what drives the invite→Player binding |

**Step 2: the owner runs `/setup layout:cardtable`.** The guild owner always counts as an
ArchiveBot admin. Without that rule, nobody in a brand-new guild could run it. The command:

- creates **Info** (#announcements, #events), **Table** (#general, #looking-for-game,
  #bugs-and-feedback) and **Voice** (Table 1, Table 2). Discord's default #general is *moved* into
  Table rather than duplicated.
- makes #announcements and #events read-only: `@everyone` is denied Send Messages, thread sends
  and thread creation, and the bot is allowed View, Send and Embed Links.
- creates **Player** and **Admin** with no Discord permissions, gives every human member already
  there Player, and gives the owner Admin. Admin is also what ArchiveBot reads as "bot admin".
- mints one **permanent, unlimited invite** on #general and binds it to Player. Joins through it
  get Player via the existing invite→role binding. If two people join in the same instant, the
  join is left unattributed rather than guessed at. Player gates nothing (every channel is open),
  so that costs nothing, and re-running `/setup` hands Player to anyone who lacks it.
- records the binding in `Output/1563307288406786078/cardtable.json`.

It's idempotent. Each piece is found by the id recorded on the last run, then by name, so a
renamed channel is followed rather than duplicated. A second run creates nothing and re-applies the
read-only overwrites. If a run fails, it deletes everything that run created and writes no binding.
It refuses up front with a clear message if the bot lacks one of the permissions above, or if
Player or Admin sits above the bot's role. It also refuses to bind a second guild.

**Output.** This is the real formatter, run against the test guild. In Discord the `<#…>` render as
channel links, and the invite is the real one:

```
**cardtable layout applied** — 12 created, the rest already in place.
Roles: Player (created) · Admin (created)
Info: #announcements read-only (created) · #events read-only (created)
Table: #general (moved here) · #looking-for-game (created) · #bugs-and-feedback (created)
Voice: Table 1 (created) · Table 2 (created)
Members: Player given to 1; Admin is the server owner.
Invite, permanent, joins get Player (created): https://discord.gg/<code>
Not part of the layout, left alone: Text Channels, Voice Channels, General
```

A re-run says `0 created` and `(in place)` throughout. **The `https://discord.gg/<code>` line is
the URL for cardtable's top bar.** The reply is ephemeral, so the operator copies it from there.
Nothing outside the layout is deleted. The two empty default categories and the default voice
channel are listed so the operator can remove them by hand.

## 4. The secret

The wrapper entry isn't in `hadoku_site` yet. ArchiveBot has written hadoku_site a request,
`hadoku_site/docs/requests/ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET.md`, covering the vault item, both
wrappers' `vaultKeys`, and `SHARED_SECRETS.md`. Until it lands, every cardtable call is a 401.

## 5. Ask 4: `/link <code>` (design note, not built)

The per-guild store keeps room for it. `Output/{guildId}/cardtable.json` already has a reserved
`links` object beside `setup`:

```jsonc
{
  "setup": { … },
  "links": {
    "<discordUserId>": { "hadokuUserId": "…", "linkedAt": "…" }
  }
}
```

Keyed by Discord user id, because every Discord event arrives with one. Per guild, because a link
means "this member of the cardtable guild is this hadoku user". The proposed flow, for when Asks
1–3 have proven out:

1. cardtable mints a short single-use code for the signed-in user (≈10 min). It sends it to
   ArchiveBot over a signed `POST /api/cardtable/link-codes` with
   `{ code, hadokuUserId, expiresAt }`, so ArchiveBot never has to call back into cardtable.
2. The user runs `/link <code>` in the guild. ArchiveBot consumes the code and writes
   `links[discordUserId]`. Re-linking overwrites the entry, and `/unlink` deletes it.
3. cardtable resolves identities over a signed `POST /api/cardtable/links/lookup` with
   `{ hadokuUserIds: [...] }` → `{ [hadokuUserId]: discordUserId }`, batched so a tournament
   bracket is one call.

Pings like "your match is ready" would then be a deliberate per-message `allowedMentions.users`,
which needs its own request, as you said.
