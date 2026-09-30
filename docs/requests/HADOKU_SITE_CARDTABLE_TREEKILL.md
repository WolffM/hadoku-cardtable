# Request to `hadoku_site`: stop pm2 tree-killing cardtable's handed-over match JVMs

**Filed 2026-09-30 by the cardtable tracker.** One line in `ecosystem.config.cjs`.
Every deploy has been killing every live match, and the code that exists to
prevent that has never once worked in production.

```sh
cd /home/hadoku/repos/hadoku_site && claude
```

> Read `/home/hadoku/repos/hadoku-cardtable/docs/requests/HADOKU_SITE_CARDTABLE_TREEKILL.md`
> and do it. Work in your own worktree. Don't ask questions.

## What the operator saw

`#/match/m-c6f0bd09c188`, opened right after a deploy: *"why can I still join
this if the match is gone?"*, and two rooms ("hi there", "hi there2", members
Hadoku and Bella) still listed on the front page with an **Enter** button.

## What happened, from `~/.pm2/logs/cardtable-out.log`

A match was live (created 21:04:49, joined 21:05:00). A push redeployed cardtable:

```
21:06:09.984 match-handed-over   m-c6f0bd09c188   (jvm-handed-over pid 1930104)
21:06:09.985 shutdown-matches    handed:["m-c6f0bd09c188"]
21:06:10.145 shutdown-done       handed:1
21:06:17.172 run-dirs-swept      removed:2  live:[]  orphans:[]
21:06:18.276 match-gone          m-c6f0bd09c188   event:join
```

Cardtable's server did its part: Wave 22 built a hand-over (detached JVM, named
pipes, stream replay, `orphans()` at boot; `apps/server/src/play/host.ts:120-200`).
Eight seconds later the new process found **no live JVM**: pid 1930104 was gone
and its run directory was swept as dead.

**It has never worked here.** In the rotated logs since 2026-09-27 there are
six `match-handed-over` events and **zero** `match-adopted` and zero
`jvm-attached`.

## Why, reproduced

pm2 is configured `treekill: true` for `cardtable` (pm2's default; confirmed from
`pm2 jlist`). On stop it walks the parent-pid tree and signals every
descendant. The JVM is `detached: true` and `unref()`'d, which puts it in its own
process group and off the event loop, but **it is still a child of the server**
until the server exits, so the tree walk finds it.

Isolated experiment, its own `PM2_HOME`, nothing near production. The shape is
the real one: a wrapper spawns a node child, which spawns a `detached`,
`unref()`'d `sleep 300`. Then `pm2 restart`:

| `treekill` | stand-in for the JVM after `pm2 restart` |
| --- | --- |
| `true` | **dead** |
| `false` | **alive** |

## The change

In `ecosystem.config.cjs`, the `cardtable` app entry (around line 554): add
`treekill: false`, with a comment saying why: the match JVMs are deliberately
detached and outlive the server so a deploy does not end a game.

Check the consequence before you land it. With `treekill: false`, pm2
signals only the wrapper. `services/pm2/lib/wrap-service.mjs` already imports
`forwardSignals`, so confirm that path still delivers SIGINT to the server and
the server still exits cleanly within `kill_timeout`. Also confirm
`killPortProcess('9008')` in the wrapper cannot reach a JVM: the bridge listens
on other ports, but say what you checked.

## Done when

1. `pm2 jlist` shows `treekill: false` for `cardtable` after the deploy.
2. **A live match survives a restart.** Start a match, `pm2 restart cardtable`,
   and show in the log: `match-handed-over`, then `match-adopted` (or
   `jvm-attached`) for the same `matchId`, with no `match-gone` for it. Do not
   use the operator's live match; start your own.
3. `pm2 stop cardtable` followed by `pm2 start` leaves no stray JVM. List the
   `java` processes before and after, and say what reaps an orphan nobody claims
   (`ORPHAN_MAX_MS` / `ORPHAN_CLAIM_MS` in `host.ts`).

## Not in this request

The room list still shows rooms with stored members after everyone has gone.
That is cardtable's own and is tracked on its board.
