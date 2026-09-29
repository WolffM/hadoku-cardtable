# C — evidence for wave 28 §C (the room screen)

Suite: `apps/ui/src/screens/constructed.test.ts`, run as
`pnpm vitest run apps/ui/src/screens/constructed.test.ts`. Exit codes read
directly, never through a pipe.

## The work was NOT already done (§C.3)

Checked before building either half, because wave 27 §A specified as new work
something wave 24 had already shipped.

- **Item 1** — `ConstructedScreen.tsx`'s `PoolSets` at HEAD renders
  `format.sets.map(code => <SetSymbol code={code} />)`, and
  `components/ManaPip.tsx:272-279`'s `SetSymbol` renders
  `<i class="ss ss-…"/>` **plus `<span class="setsym__code">{code}</span>`**. So
  the code text was there by construction, and there was no grouping of any kind.
  `screens.css` at HEAD had **no `.lobby__sets` rule at all** — the row was an
  unstyled `<p>`, which is the cramped look being complained about.
- **Item 2** — `deck-mine` at HEAD was `<select>` with `<option>` children, and
  its own doc-comment argued for keeping it. Not done.

## Mutation counts

Each half reverted alone, the suite re-run, then restored. Every count names the
suite.

| state | `apps/ui/src/screens/constructed.test.ts` | exit |
| --- | --- | --- |
| both halves in place | **70 passed / 0 failed (70)** | 0 |
| **item 1 reverted** — `PoolSets` back to `SetSymbol` per code, ungrouped | **2 failed / 68 passed (70)** | 1 |
| **item 2 reverted** — the chooser back to the `<select>` with `<option>` rows | **28 failed / 42 passed (70)** | 1 |
| restored | **70 passed / 0 failed (70)** | 0 |

The two that fail under the item-1 revert:

- `the era’s set symbols > groups the era’s sets by block, with no set code text anywhere`
- `the era’s set symbols > follows the pool the leader moves it to, and NPH joins its own block`

The third test in that suite — `puts a set it has no block for in a group of its
own, at the end` — is a unit test of `groupSetsByBlock` and correctly survives a
revert of the *render*; it fails if the map or the ordering rule is broken
instead.

The 28 under the item-2 revert include the six in `describe('the deck chooser')`
and every suite that picks a deck at all, because picking is now a click on a row
rather than a `change` on a select.

## The art rule, checked against all 49 committed decks

Rule: **the most expensive maindeck card, ties broken by copies, then by name.**
A card with no mana cost is not a candidate, which is how a land is excluded.

All 49 decks under `decks/` resolve to a Scryfall id — **0 unresolved** — through
`apps/ui/src/draft/art-ids.json`, whose own scope note says it covers *"every card
in the committed decks/ lists"* plus a bare-name fallback row per name. A sample of
what the rule picks:

```
1-brian-kibler-kessig-titan.dck        -> Primeval Titan (cmc 6 x4)
6-matthew-costa-uw-delver.dck          -> Geist of Saint Traft (cmc 3 x4)
4-conley-woods-tempered-steel.dck      -> Etched Champion (cmc 3 x4)
8-miguel-rondon-valakut-ramp.dck       -> Avenger of Zendikar (cmc 7 x2)
2-nick-marriott-mono-green-infect.dck  -> Wild Defiance (cmc 3 x4)
3-mamoru-nagai-black-kessig.dck        -> Grave Titan (cmc 6 x4)
```

These are the cards the decks are named after, which is the argument for "most
expensive" over "first non-land": the `.dck` files list lands first and then
creatures alphabetically, so "first non-land" would have given *Acidic Slime* for
Kessig Titan.

## The block data came from Scryfall's `/sets`, not from a memory

A static map of twelve codes, because **the fixture generator cannot answer the
question**: `packages/deck/src/library/build-pool-fixture.ts` reads
`packages/carddata/data/cards.jsonl` (Scryfall `default_cards`), and a Scryfall
**card** object has no `block` field — its keys are

```
id oracle_id name lang layout released_at mana_cost cmc type_line oracle_text colors
color_identity keywords produced_mana legalities reserved game_changer all_parts set
set_name set_type collector_number rarity booster digital promo reprint variation
border_color frame full_art textless finishes games artist
```

`block`/`block_code` live on the **set** object. Verified on 2026-09-28 against
`https://api.scryfall.com/sets`:

| code | set | `block` | `block_code` |
| --- | --- | --- | --- |
| zen | Zendikar | Zendikar | zen |
| wwk | Worldwake | Zendikar | zen |
| roe | Rise of the Eldrazi | Zendikar | zen |
| som | Scars of Mirrodin | Scars of Mirrodin | som |
| mbs | Mirrodin Besieged | Scars of Mirrodin | som |
| nph | New Phyrexia | Scars of Mirrodin | som |
| isd | Innistrad | Innistrad | isd |
| dka | Dark Ascension | Innistrad | isd |
| avr | Avacyn Restored | Innistrad | isd |
| m11 | Magic 2011 | Core Set | lea |
| m12 | Magic 2012 | Core Set | lea |
| m13 | Magic 2013 | Core Set | lea |

The core sets really are one block whose `block_code` is `lea` (Alpha, 1993),
which is why the core group is ordered **last** rather than by its own earliest
set.

`decks/pools/*.generated.json` was therefore **not regenerated** — no shipped data
changed.

## The screenshot

`C-room-screen-1280x800.png`, 1280x800, the room screen with four real library
decks offered and UW Delver chosen. Rendered from the real components with the
real stylesheets (`@wolffm/themes` `style.css`, `styles.css`, the vendored
`mana.css` and `keyrune.css`, `screens.css`) in headless Chromium.

Measured in that browser rather than assumed:

- each `.lobby__block` computes to `font-size: 32px`, and the three groups sit at
  x=669 (`ZEN WWK ROE`), x=786 (`SOM MBS`), x=871 (`M11`) — a 26px gap between
  blocks against a 7px gap inside one;
- every `.lobby__block`'s `textContent` is `""` — no set code is painted;
- all four deck rows loaded their art: `naturalWidth` 488, `naturalHeight` 680,
  from `https://cards.scryfall.io/normal/front/…`, which is the Scryfall arm of
  `resolveArtUrl` (the committed `art-manifest.json` ships `entries: {}`, so every
  id falls through to it — the same thing the deployed UI does today);
- **zero failed requests** on the page.
