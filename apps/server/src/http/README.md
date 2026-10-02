# `apps/server/src/http` — the constructed table

Wave 10, lane B. Pick a format, pick a deck, start a match — and a deck that is
not legal in the format is refused **before Forge launches**, with the card
named.

| file | what |
| --- | --- |
| `index.ts` | the exports `src/index.ts` needs: `attachTables` |
| `routes.ts` | `attachTables(api, deps)`: the catalog routes and the gate on play's start route |
| `gate.ts` | the one check: `{ deck, rules }` → a verdict, from `@hadoku/deck`'s own validators |
| `library.ts` | the frozen Standard pools and the deck library, read off `decks/` once at boot |
| `draftPool.ts` | a drafted pool as deck entries — the UI's `cardRequestOf`, copied and pinned by a test |
| `tables.test.ts` | the gate through the REAL `attachPlay` route, with a recorded Forge |

## Where drafting and constructed meet

A drafted 45-card pool and a prebuilt 60-card deck are both `.dck` text by the
time a match starts. So a seat is `{ deck, rules }`, and there is one function
from that to a verdict (`checkSeat`):

```
deck   { library: "<catalog id>" }     a Wave 7 library deck
       { dck: "<.dck text>" }          anything else — a drafted deck, a pasted list
rules  { kind: "standard", format: "<date>" }   formatIssues  vs the frozen Standard pool
       { kind: "draft", draftId: "<pod id>" }    deckIssues    vs the CALLER's own drafted pool
```

Both arms parse with `parseDck`, build with `deckFromDeckFile`, return
`DeckIssue[]`, and — when legal — hand the **same text, byte for byte** to play
as that seat's `deck`. The draft arm finds the pool by the caller's derived
identity (never a seat number in the body), because a verdict like "plays 1x X
but drafted 0" says what someone drafted.

Where they converge, by line: `checkSeat` sets `text` from the library
(`gate.ts`, `text = found.text`) or the body (`text = seat.deck.dck`), both
arms parse that one string (`const file = parseDck(text)`), and `routes.ts`
forwards it (`req.body = { opponent, decks: verdicts.map((v) => v.text) }`) to
play's `parseStartBody` (`play/socket.ts`, `deck: decks[0]`/`decks[1]`), which
becomes the bridge config and `PlayBridge.parseDeck(s.deck())`. One request can
carry one of each; `tables.test.ts` ("starts a match through the same gate")
asserts both land in the same spec.

## The file, not just the deck (Wave 11)

The rules check `main` and `sideboard`; the gate forwards the whole file; and
Forge reads more than that, with a reader that differs from `parseDck` in two
places. Three files the Wave 10 gate passed were launched by a real Forge as a
different deck (library counts read off the live board):

| appended to a legal 60 | Forge's seat 1 library |
| --- | --- |
| `[Planes]` + `4 Black Lotus\|LEA` | 64 — `Deck.normalizeDeferredSections` moves ordinary cards into Main |
| `\u00A0[junk]` + the same line, before `[Sideboard]` | 64 — JS trims the no-break space (a header), Java does not (a card line) |
| `[main\u0001]` + the same line | **4** — Java's `trim` makes it Main and it REPLACED the real main deck |

`dckShapeIssues` now refuses, as issues on the verdict: any section other than
`metadata`/`main`/`sideboard` that holds a card (named, with its section);
any character the two `trim`s disagree on (C0 controls other than tab/CR/LF,
the Unicode spaces, the BOM — named by line); and a file with no exact
`[metadata]` line, which Forge's `readDeckMetadata` needs verbatim or the
bridge fails the match after the JVM is committed. Every door is tested in
`tables.test.ts` ("bypass routes"), and the socket carries no deck at all
(`sideboard` is answered `null` by the bridge).

What is NOT the same yet: nothing in the UI builds a deck out of a drafted pool
(`#/deck/<id>` is still the reserved stub), so the draft arm is reachable from
the API and proven by `tables.test.ts` (a deck written by the UI's own
`deckFromPool` + `dckTextOf`, checked and started), but not from a screen.
The draft's `DeckView` can already download that `.dck`; what is missing is a
"play this deck" step that hands `{ dck, rules: { kind: 'draft', draftId } }`
to `#/play` (a button in `components/DeckView.tsx` plus a seat source in
`screens/ConstructedScreen.tsx` — no server change). The hard limit is Forge's,
not ours: the bridge reads both decks at launch and the draft arm checks only
the caller's own pool, so a friend's drafted deck cannot be seated until decks
can arrive after launch. Drafted-vs-AI and drafted-vs-library work today.

## HTTP

All on the `api` router, behind `requireMinTier` like every API route. No public
tier.

**`GET /api/tables/formats`** → `{ formats: [{ id, name, effective, sets, banned, cardCount, source }] }`
— one per `decks/pools/standard-<date>.generated.json`, oldest first. `id` is the date.

**`GET /api/tables/decks`** → `{ decks: [{ id, collection, name, format, date, provenance, citation, main, sideboard }] }`
— `main`/`sideboard` are `[{ count, name }]`.

**`POST /api/tables/check`** `{ deck, rules }` → 200 `{ deckName, rulesName, legal, issues, note }`,
or 400 `{ error }` for an unknown deck/format/draft. Starts nothing.
`issues` are `[{ kind, message, cardName, count, limit }]`. `note` is
`libraryPoolMismatch` — a library deck checked against a format it was not
built for — shown, never refused on.

**`POST /api/play/matches`** — the gate, in front of play's own route:

| body | answer |
| --- | --- |
| `{ opponent?, seats: [{ deck, rules }, { deck, rules }] }`, both legal | rewritten to play's `{ opponent, decks: [dck, dck] }` → play answers (201 …) |
| same, any seat illegal | **422** `{ error, seats: [verdict, verdict] }` — Forge is never launched |
| same, a seat unresolvable | 400 `{ error: "seat N: …", seat }` |
| play's raw body with a non-null `decks[i]` | **422** — an unchecked deck does not reach Forge by the side door |
| play's raw body with no/null decks | untouched → play (Forge's random precons, the dev tooling) |

`error` on a 422 leads with the seat, the deck and the first card:
`Seat 1's deck "UG Polymorph (Antoine Ruel)" is not legal in Standard (M12): plays 1x Essence Scatter, which is not in Standard (M12) (and 2 more)`.
The `.dck` text is never sent back.

## The edits this lane needs in files it does not own

### `apps/server/src/index.ts` — mount the gate BEFORE `attachPlay`

**Order is load-bearing**: the gate is a handler on play's own path, so it runs
only if it is registered first. Mounted after, every product start answers 400
from play's parser (`unknown field seats`) and a raw `decks` body walks past.

```diff
--- a/apps/server/src/index.ts
+++ b/apps/server/src/index.ts
@@ import { loadPool } from './room/pool.js';
 import { attachDraftSocket } from './room/socket.js';
 import { attachPlay, jvmHostConfig, jvmHostFactory } from './play/index.js';
+import { attachTables } from './http/index.js';
 
@@ const io = new SocketIOServer(httpServer, {
-attachDraftSocket(io, {
-	rooms: poolLoad.ok
-		? createDraftRooms({ pool: poolLoad.pool.cards, cube: poolLoad.pool.meta })
-		: null,
-	minTier: CONFIG.minTier,
-});
+const draftRooms = poolLoad.ok ? createDraftRooms({ pool: poolLoad.pool.cards, cube: poolLoad.pool.meta }) : null;
+attachDraftSocket(io, { rooms: draftRooms, minTier: CONFIG.minTier });
+
+// ── Constructed ──────────────────────────────────────────────────────────────
+// Formats, the deck library, and the deck gate on POST /api/play/matches. MUST
+// come before attachPlay: the gate is a handler on play's own path and runs
+// only if it is registered first. See src/http/README.md.
+attachTables(api, { repoRoot: resolve(PKG_ROOT, '../..'), draftRooms });
 
 // ── Matches ──────────────────────────────────────────────────────────────────
```

`resolve(PKG_ROOT, '../..')` is the repo root from both `dist/index.js` and
`src/index.ts` (the same one-directory-below-the-package argument `index.ts`
already makes for `POOL_FILE`); the deploy tree is a full checkout, so
`decks/` is there.

### `apps/server/package.json` (+ `pnpm-lock.yaml`) — two workspace deps

```diff
   "dependencies": {
+    "@hadoku/carddata": "workspace:*",
+    "@hadoku/deck": "workspace:*",
     "@hadoku/draft": "workspace:*",
```

```diff
   apps/server:
     dependencies:
+      '@hadoku/carddata':
+        specifier: workspace:*
+        version: link:../../packages/carddata
+      '@hadoku/deck':
+        specifier: workspace:*
+        version: link:../../packages/deck
       '@hadoku/draft':
```

Both are bundled by esbuild like the other `@hadoku/*` packages, so the
`--external` list does not change. `@hadoku/carddata` is imported only through
its `/dck` subpath (the parser, no node builtins).

### `apps/ui/src/App.tsx` — two routes

```diff
+import { ConstructedScreen } from './screens/ConstructedScreen.tsx';
 import { DebugHarness } from './screens/DebugHarness.tsx';
 import { DeckScreen } from './screens/DeckScreen.tsx';
 import { LobbyScreen } from './screens/LobbyScreen.tsx';
+import { MatchScreen } from './screens/MatchScreen.tsx';
 import { PodScreen } from './screens/PodScreen.tsx';
@@
     case 'deck':
       return <DeckScreen draftId={route.draftId} />;
+    case 'play':
+      return <ConstructedScreen />;
+    case 'match':
+      return <MatchScreen matchId={route.matchId} />;
     case 'lobby':
       return <LobbyScreen />;
```
