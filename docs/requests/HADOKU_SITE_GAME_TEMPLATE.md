# Request to hadoku_site: a template gap, and a `game` template to close it properly

Two asks. The first is a bug in an existing template that will bite the next
app hydrated from it. The second is the template the operator actually wants.

---

## Ask 1 — `tunnel-loopback-ui` hands an app no hadoku chrome, and warns nobody

**cardtable was hydrated from `templates/tunnel-loopback-ui` on 2026-09-15**
(`docs/child-apps/CHECKLIST_cardtable.md:3`). Four days later the operator
opened it and asked why there was no theme selector, and why the app showed
`anon` instead of their name.

Both have the same cause, and it is not a cardtable mistake:

- `templates/tunnel-loopback-ui/` is **server-only** — `AGENTS.md`,
  `eslint.config.js`, `package.json`, `src/{base-path,config,edge-auth,index}.ts`.
  Its own `TEMPLATE.md:36-38` says it *"scaffolds no UI"*, which is a
  reasonable thing for the template to do.
- The hydrator's "NO HADOKU CHROME" warning banner
  (`scripts/build/hydrate-child-app.mjs:2152-2190`) is gated on
  `isProxy && !isContained`. **A loopback-ui app never sees it.**

So nothing in the pipeline — not the template, not the hydrator, not the
checklist — ever handed cardtable `HadokuThemeRoot`, `AppHeader` or
`@wolffm/prefs-client`. A grep over `apps/ui/src` and `apps/server/src` returns
**zero** hits for any of them.

The visible symptom is sharp: `@wolffm/prefs-client` exports
`ANON_USER_ID = "anon"` and a `whoami()` that returns `{ userId, userType,
name }`. cardtable rolled its own `/api/whoami`, which has no `name`, so it
renders the sentinel. Meanwhile watchparty's `RoomChrome` DOES read
`@wolffm/themes` and defaults to *"the viewer's saved hadoku theme"* — so the
chat column is themed and the app around it is not, in the same viewport.

**What we would like:** either the loopback-ui template carries the chrome the
way `tunnel-contained` does, or the hydrator's warning fires for it too. The
second is a one-condition change and would at least have told us.

We are fixing cardtable's own copy from
`templates/tunnel-contained/packages/ui/src/` and `hadoku-conjure`'s live
version; this ask is so the **next** loopback-ui app does not repeat it.

---

## Ask 2 — a `game` template

The operator's words: *"the vision for the watchparty templates is to be able
to create more standalone games that can utilize the networking, chat, and room
components without needing to worry about other stuff in the ecosystem …
I think it might be nice if hadoku_site can cut a new type of child template
which is this type of 'game-scaffolding' template."*

**No such template exists today.** The seven in `templates/` are the complete
set; `grep -i game` across them finds only `games-host` as a cautionary
mention, and `games-host` is a plain `child-apps.json` entry
(`scripts/child-apps.json:173-185`), not a template. The hydrator has no
networking/chat/rooms flag — `resolveAppConfig()` asks only UI / Worker /
Tunnel.

**Where it should live, and why we think hadoku_site rather than watchparty.**
The operator was open to either. Our reading of the evidence:

- **Templates are a hadoku_site concept.** All seven live here, one hydrator
  drives them, and hydration is what wires edge-router route-tiers, the route
  atlas, PM2 wrappers, `deploy-config.json`, vault key declarations, preview
  policy and the repo-policy seed. Watchparty cannot do any of that.
- **Watchparty already ships the right libraries**, and they are good:
  `@wolffm/rooms-protocol`, `@wolffm/rooms-server`, and
  `@wolffm/watchparty-ui/room-chrome` — all at 0.39.x. cardtable consumes all
  three today.

So: a `templates/game` in hadoku_site that **composes watchparty's packages**,
rather than a template inside watchparty. One mechanism provisions the app;
watchparty stays the library owner.

**What it should carry, from what cardtable had to build by hand:**

1. The hadoku chrome the loopback-ui template omits — `HadokuThemeRoot`,
   `AppHeader`, `usePlatform`, `prefs-client` with `whoami()`, and the four
   required CSS imports. This is the `ui-app`/`tunnel-contained` pattern and
   is not game-specific; it is just the half that went missing.
2. `RoomChrome` mounted **once**, around the app's own content. The one-per-page
   rule is real — watchparty's store and socket are module singletons, so a
   second instance shares and then tears down the first one's connection. A
   template that gets this right once saves every game getting it wrong.
3. A server with `@wolffm/rooms-server`'s `RoomRegistry` and seating already
   wired, and a room id shaped `[a-z0-9-]{1,40}` so
   `cardtable-<id>`-style keys need no provisioning.
4. The loopback-ui server half that already exists, unchanged — edge auth,
   tier floor, base path.

**A lesson worth baking in, from cardtable's wave 13.** We built a room list
and per-player state, and shipped a bug where the room's URL was not
self-sufficient: `join()` had exactly one caller, the list's Join button, so an
invite link left you a non-member, and the server — correctly — answers a
non-member exactly as it answers a missing room. The result was a real room
reported as missing and a 404 re-asked on a 1.5 s timer. **If the template
ships a room screen, have entering a room join it.**

---

## What we are NOT asking for

- Not asking watchparty to change anything. Their 0.39.0 delivery was complete
  and verified from the published tarball.
- Not asking for a draft/tournament abstraction. cardtable's draft rooms have
  sub-pod fan-out that is genuinely ours.
- Not blocked. cardtable will wire its own chrome now either way; the template
  is so the next game does not pay for it again.
