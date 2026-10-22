# Draft pools — the operator's plan, and how it is built

The operator's words are quoted verbatim so the goal cannot drift through
paraphrase. Everything under **Design** is ours and may change; the quotes and
rulings may not.

## The ask (2026-10-21, verbatim)

> i need some improvements to draft rooms. i need a way to select draft pools.
> 3 different types:
>
> 1. pre-selected cube lists
> 2. list read directly from cube-cobra link, builds the cube list, and saves
>    that cube for the future.
> 3. set draft (select Innistrad and do a set cube draft) for this we want two
>    types of options: (realistic or set-cube. realistic simulates a real
>    limited draft with one rare and 3 uncommon. set-cube creates a pack from a
>    cube that contains a singleton card for every card from the set and
>    creates random packs with no restrictions. Additionally, we should be able
>    to create 'custom draft' in which any of the prev settings can apply but
>    also we can choose a different source for each pack. so we can do shards of
>    alara + alara reborn in one draft. this should also be doable with cube
>    sets as well, not just draft sets.

## Rulings (2026-10-21, from the operator's answers)

1. **Realistic** uses Forge's per-set collation (`Booster=` in
   `forge-gui/res/editions/*.txt`): rare/mythic rates, land slot, and set quirks
   such as Innistrad's DFC slot.
2. **Set-cube** is one copy of every **non-basic** card in the set. No bonus
   sheets, no special guests.
3. When a set-cube cannot cover the pod (8 × 3 × 15 = 360), a **second copy of
   the set is added only when short**.
4. **Cube Cobra** imports are a **snapshot** with a **refresh** button. Any
   friend imports and refreshes; **only the importer deletes**.
5. **Custom** is **one source per pack round**; every drafter opens the same
   source in a round. A source is a set (realistic or set-cube) or any cube.
6. **Playability** — verbatim: *"it shouldn't even get to the drafting stage.
   if a set/cube is selected for drafting we should immediately evaluate then
   whether or not its forge playable"*. A source with any card Forge cannot play
   is **refused at selection, with the list of those cards**.
7. **Cube picker** = a curated shortlist plus imported cubes. The shortlist
   (operator's pick of 8 from 20):
   - MTGO Vintage Cube 2025-12 — **amended 2026-10-22 by the operator to MTGO Vintage Cube 2025-04**
     ("go to a prev version that has less new cards"): 2025-12 dealt 534 of 540, and 2025-04 is the newest
     version that resolves all 540
   - MTGO Legacy Cube 2021-08
   - The Pauper Cube 2026-02
   - Ryan Overturf's Grixis Cube (MTGO)
   - Timothee Simonot's Twisted Color Pie Cube
   - Guillaume Matignon's Jenny's-Johnny's Cube
   - Old School 93-94 Magic Powered 360 Card Cube
   - Hypercube (383 cards)
8. **Sets** = every set Forge has a draft booster for, searchable, newest first.
9. The source is chosen **in the draft room's setup by the leader**; everyone
   seated sees the choice live.

Defaults stated to the operator and not objected to: a custom setup can be
saved as a named **preset**; pack rounds stay **3 × 15**.

## What exists on 2026-10-21

- **One pool for the whole server.** `apps/server/src/index.ts:413` loads
  `apps/ui/src/draft/pool.json` (the Vintage Cube 2025-12, built offline by
  `packages/carddata/src/cli/build-pool.ts`) and hands it to `createDraftRooms`
  as `pool` + `cube`. Every pod drafts that cube.
- **The engine slices one pool.** `packages/draft/src/engine.ts`'s
  `DraftConfig` takes `pool`, `packCount`, `packSize`; a pack is a slice of the
  shuffled pool.
- **The UI reads the same file** as a card index: `apps/ui/src/draft/live.ts`,
  `apps/ui/src/play/adapter.ts` (printed base values),
  `apps/ui/src/play/live/art-preload.ts` (`preloadCubeArt`),
  `apps/ui/src/play/prompts/testing.ts`.
- **Card data.** `packages/carddata/data/cards.jsonl` (176 MB, Scryfall bulk,
  synced **2026-09-15**) is read only by CLIs. The server has no runtime card
  index.
- **Art.** `resolveArtUrl` falls back to Scryfall by `scryfallId` for any card
  without a manifest row, so any card from any source renders.
- **Forge.** `CardEdition.hasBoosterTemplate()` (`CardEdition.java:563`) says
  whether Forge can make a draft booster for a set;
  `BoosterGenerator.getBoosterPack(SealedTemplate)` (`BoosterGenerator.java:92`)
  makes one; its randomness is `MyRandom.getRandom()`, settable with
  `MyRandom.setRandom` (`MyRandom.java:62`).
- **Cube Cobra.** `GET https://cubecobra.com/cube/api/cubeJSON/<id>` returns
  `cards.mainboard[]` with `details.name`, `details.scryfall_id`,
  `details.oracle_id` (checked 2026-10-21 on `LSVCube`: 516 mainboard cards).
  It also carries image URLs, which we never keep.

## Design

### One shape: a plan of sources

```ts
type PoolSource =
  | { kind: 'cube'; cubeId: string }                 // shortlist or imported
  | { kind: 'set'; code: string; style: 'realistic' | 'set-cube' };

type DraftPlan = { rounds: [PoolSource, PoolSource, PoolSource] };
```

Cube, set and custom are one thing: a plan whose three rounds are equal, or
not. The setup UI has a Cube tab and a Set tab that fill all three rounds, and a
Custom tab that edits each round. Zod schemas in `packages/shared`.

### The engine deals what it is handed

`DraftConfig.pool` is replaced by `packs: DraftCard[][][]` (`[round][seat]`).
The engine stops shuffling and slicing; it passes what it is given. Dealing
moves to a pure `deal(plan, seed, seatCount)` in `packages/draft`, plus the
Forge call for realistic rounds.

- **Cube rounds** draw from one shuffled copy of that cube. Two rounds of the
  same cube share the copy, so no card repeats (what happens today).
- **Set-cube rounds** do the same over the set's non-basic singleton list.
  Rounds of the same set share it, and a second copy of the set is shuffled in
  only when total demand exceeds the list (ruling 3).
- **Realistic rounds** ask Forge for `seatCount` boosters of that set, with
  `MyRandom` seeded from the draft seed and round.

The dealt packs are written into the pod's persisted snapshot. A restore reads
them back instead of re-dealing, so a Forge pin change can never change a draft
in flight.

### The catalog (server)

`apps/server/src/pools/` owns every question about sources:

- **Cubes.** The 8 shortlisted cubes are resolved offline into
  `apps/server/pools/cubes/<id>.json` (gameplay text + `scryfallId`, the same
  shape as `pool.json`, the same D13 control in `loadPool`). `build-pool`
  learns to emit them all. Imported cubes live in `data/cubes/<id>.json`
  (gitignored, like `data/rooms`):
  `{ id, name, cubeCobraId, importedBy, importedAt, refreshedAt, cards }`.
- **Sets.** The jar lists the sets with a draft template (ruling 8) and each
  set's non-basic card names (set-cube). Cached per Forge pin.
- **Card text for any card.** A compact card catalog (one entry per card name:
  the `DraftCard` projection and a default `scryfallId`) generated from
  `cards.jsonl` by a new `build-catalog` CLI into `data/catalog/` (gitignored,
  rebuilt on deploy when the sync is newer). The server indexes it at boot,
  alongside the ~16 MB library it already loads there. Set rounds use the
  set's own printing ids for art.

### Playability, at selection

When the leader picks a source, the server returns a verdict before the
choice is accepted:

```ts
type PoolVerdict =
  | { ok: true; cards: number }
  | { ok: false; unplayable: string[]; missingText: string[] };
```

- `unplayable`: names the jar's card DB (`StaticData.getCommonCards()`) does
  not know at the pinned jar.
- `missingText`: names the catalog cannot produce text for (a Scryfall sync
  older than the set).

Any non-empty list refuses the source (ruling 6). The room keeps its previous
plan, and the list is shown. Verdicts are cached per (source, Forge pin), so the
second pick of a source is instant. An import is checked when it is saved and
again on every selection, because the pin moves.

### The jar's pool service

The bridge JVM is already booted and warm (`play/host.ts`). It learns four
requests, answered on its existing line protocol:

| Request | Answer | Forge |
| --- | --- | --- |
| `pool:sets` | `[{ code, name, date, type }]` with a draft template | `CardEdition.hasBoosterTemplate()` |
| `pool:setCards {code}` | non-basic unique names in the set | edition's `[cards]` |
| `pool:boosters {code, count, seed}` | `count` boosters as names + set + collector number | `BoosterGenerator.getBoosterPack` under a seeded `MyRandom` |
| `pool:check {names}` | the names it does not know | `getCommonCards().getCard` |

Not yet verified: whether the pooled bridge can serve these between matches
without a dedicated JVM. The first lane on this measures it and, if not, runs a
second long-lived JVM for pools only.

### Cube Cobra import

Paste a link (`/cube/overview/<id>`, `/cube/list/<id>`) or a bare id. The server
fetches `cubeJSON`, keeps `mainboard` only, and copies **name and
`scryfall_id`** — never an image field. Names resolve through the catalog, and
the verdict runs. The cube is saved even when the verdict refuses it, so the
importer can fix it on Cube Cobra and press refresh. It still cannot be drafted
until the verdict is clean. Refresh refetches and overwrites the snapshot.
Delete is allowed only for `importedBy` (ruling 4). The identity is the edge
session's friend id.

### Room setup UI

The draft room's setup (leader only, live for everyone seated) gains a pool
picker:

- **Cube** — the 8 shortlisted cubes, with imported cubes pinned above them
  (importer and refresh time shown, refresh/delete on each). An import field
  takes a link.
- **Set** — a searchable list, newest first, and a Realistic / Set-cube
  toggle.
- **Custom** — three round rows, each a Cube-or-Set picker. Save / load
  named presets (`data/presets.json`, shared across the group).
- A verdict line: checking → ready, or refused with the card list. Start is
  disabled until it is ready.

No explanatory copy (standing rule). The pod screen's `pod__cube` label
becomes the current round's source name.

### What this makes dead

- The server-global pool: `POOL_FILE`, `DraftRoomsOptions.pool` / `.cube`,
  `DraftRooms.cube`. A room's pool is its plan.
- The engine's own shuffle-and-slice from `pool`.
- `apps/ui/src/draft/pool.json` as a runtime card index. `live.ts` and
  `adapter.ts` read card text from the draft's own cards (already on the wire
  as `DraftCard`). `preloadCubeArt` preloads the plan's cards from the server.
  The file survives only as a test fixture, if a test still needs it.
- `gate-fixture.ts`'s load of the UI's `pool.json` moves to a shortlisted cube
  file.

## Order

Each step starts as a failing spec (standing rule) and lands on its own.

1. **Plan + deal.** `DraftPlan` schema, `deal()`, engine takes packs, per-room
   plan with the 8 shortlisted cubes, Cube tab. Delete the global pool. No jar.
2. **Card catalog + Cube Cobra.** `build-catalog`, import/refresh/delete,
   imported cubes in the Cube tab.
3. **Pool service + verdict.** Jar requests `check`, `sets`, `setCards`. The
   verdict gates every source, and set-cube is added.
4. **Realistic.** `pool:boosters`, seeded, snapshot-persisted packs.
5. **Custom + presets.**

## Open risks

- **Scryfall sync is from 2026-09-15.** Sets released after that have no card
  text, so they will show `missingText`. A deploy-time sync (Scryfall bulk is
  daily) belongs with step 2.
- **Forge names vs Scryfall names** for split, adventure and DFC cards.
  `resolve.ts` already joins them for `.dck`. Step 2 reuses it rather than
  writing a second join.
- **Three bundled cubes parse to 0 cards** (`MTGO Grixis Cube 2019-09`,
  `MTGO Grixis Cube (540 Cards)`, `Old School … Full Set 878`). None are
  shortlisted. Diagnose and record them, but it does not block this work.
- **Bots** score by colour and mana (`packages/draft/src/bot.ts`), so any card
  works. Realistic packs may want rarity-aware picks later. Not in scope.
