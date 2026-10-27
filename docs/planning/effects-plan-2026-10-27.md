# Effects plan — 2026-10-27 hand-off

Written at the end of the 2026-10-27 session because the operator is switching accounts: the design
previews were claude.ai artifacts on the old account and will not open from the new one, and that
account's memory does not carry over. Everything needed to continue is here, in the playtest ledger
(`docs/planning/playtest-ledger.md`, rows AF413–AF420), and in the preview sources on this host under
`~/.cache/cardtable-manager/` (durable; not a tmpfs).

## Shipped today (all on main, green, on PPE at 40faeb53 or later)

| Row | What | Commits |
| --- | --- | --- |
| AF414 | Lifelink: your life rises as the lifelinker strikes, a heal mote flies to your face | `08553524` |
| AF415 | Fact or Fiction (32 TwoPiles cards): two piles of cards, a Pile 1 / Pile 2 button under each, cards not clickable | `0c351832` |
| AF416 | Countered spells crack and fade in place, decided by Forge's own resolved/fizzled events (`counteredStackItems`) | `f6b7cf43`, test race fix `9055729b` |
| AF417 | Firefox panel edges: the scoop frame's zero-width radial-gradient stop dithered at non-1 scale | `094610d0` |
| AF418 | One table: the two seats merge at the seam, 10px gutter each side, battlefields `position: relative` | `ea0dc9b2`, `c682b96a` |
| AF419 | No native `title` tooltips on cards ("Generic 6", "Power 15, toughness 15") | `9d7844c2` |
| AF413 | Creature (and permanent) entries land with weight — see below | `afe7519f`, `e7da2faf`, `8deacf73` |

All of these await the operator's ✅ in the ledger after they play them on PPE.

### AF413 as shipped (approved preview v10)

`apps/ui/src/play/live/entries.ts` (+ `entries.css`, `entries.test.ts`). Origin picks the motion
(`entryMotionFor`): `rise` from a graveyard pile, `blink` from exile, `release` for a token (it
materialises over its own slot and drops), `cast` otherwise. Every permanent lands, weighed by
`entryHeft` (creature: power; anything else: mana value; a land: just the drop). `entryWeight` is
continuous to `ENTRY_MAX = 15`: thump from 2, shake from 5 (0.6 → 13px), full debris and cracks from 7
(2–3 cracks with 2–3 breaks, growing to ~6 with 4–5 breaks; forks from 10, one level), shove from 8
(one ring) and 12 (two rings; cards are knocked and settle back into their OWN places, never moved).
Cracks are tapered filled outlines, zigzag, drawn in table coordinates into every battlefield under its
cards, so they cross the seam onto the other side.

Known gaps, not regressions (queued below): a noncreature permanent CAST from hand still lands without
weight (`gestures/cast.ts`'s weight tail reads only a creature's P/T badge); no browser e2e asserts the
entry motions (unit + one jvm proof only).

## Approved, not yet built: spell damage (AF420) — preview v4

The operator, 2026-10-27: "looks great. i can approve that animation." Build it as one lane.

Preview source (the spec): `~/.cache/cardtable-manager/spell-damage-preview/`. `src/patched/{motion,
projectile,numbers}.ts` are copies of the app's modules, swapped in at build time by the vite plugin
in `vite.config.ts`, each change marked `PREVIEW:` and gated on a Today/Proposed switch; the new look is
`src/patched/impact.css`. `notes.md` is the design log v1–v4 with every measurement. Rebuild and view:
`./build.sh`, then `python3 -I -m http.server 18732 --bind 127.0.0.1` in that directory and open
`http://127.0.0.1:18732/index.html` (kill the server's printed PID afterwards). The built page is
`index.html` there too, and can be re-published as an artifact from the new account.

What to build:

1. **One damage scale, capped at 20.** `motion.ts` `damagePower` normalised to 20 (today `MAX_DAMAGE`
   10); `powerSize` 0.8 + 1.7p. Ball 18 → ~55px, impact grows to 20.
2. **The number grows with the hit:** 15px at 1 → 38px at 20, stroke 2 → 4px; the ≥5 pop stays as an
   accent; the number is drawn ABOVE the explosion (z-index), never under it.
3. **Shake for a spell's blow on the landing curve:** none below 5, 0.6px at 5 → 16px at 20. Factor it
   on `crash.ts`'s px shake (the entries lane already made `shake` take px).
4. **The sling arc** (`slingFrames`): a cubic path that first swings AWAY — pulled back by
   8 + (0.05–0.17)·d·power and out to a seeded side by 0.10–0.26·d — then curves in at the target,
   played on `powerEase(power)` (the ram's punch: a heavy blow creeps at the back of its swing and whips
   in). Control points clamped 16px inside the overlay so the flight never leaves the board (measured: 0
   off-board frames). Seeded PER RESOLUTION: the face-hit key becomes `player:<id>:<stack item id>`
   (today it is `player:<id>`, so every spell at the same player flies the same arc).
5. **The fire trail** (`trail`): no lagging ball copies; embers shed every (5 − 2p) px along the stretch
   the ball actually travelled since the last frame, centred on the path (animate `-50% -50%` →
   `calc(-50% + dx) …`, never replace the centring — the v3 bug), shrinking and cooling core → flame →
   smoke, 180–420ms by power. Draw them out of `effect-budget.ts`'s particle pool.
6. **The explosion** (`explode`): a white-hot flash (160ms); 3–9 soft puffs clustered round the point
   (the first the white-hot heart) at ONE size at every damage (operator: the big ones were
   distracting), smoke ghosts rising after; a shockwave ring from 3 damage; 6–28 spark streaks each on
   its own arc with gravity; a few falling embers for heavy blows. All in the bolt's colour from the
   card (`data-colour`).
7. **Behaviour fix with it — the Calibrated Blast link.** Telemetry (`m-bafaa3d3238f`): each cast
   resolves as the spell (reveal, 0 hits) and then a reflexive trigger (1 hit). `numbers.ts`
   `revealOf` (≈:614) ties a reveal only to an item `firstSeen` on the stack; the trigger is new in the
   frame it resolves, so its bolt leaves wherever the nameless trigger sat. Key the reveal by its
   source too, so the bolt leaves the revealed card. AF403 (the reveal frame never reaching the seat at
   all: `SeatGui` overrides neither `IGuiGame.reveal` nor `updateRevealedCards`) is separate and open.

Open question for the operator before the lane starts: **do creature combat blows (rams) share the
cap of 20?** They read the same `damagePower`; the recommendation is yes (one scale for all damage), with
combat's own shake left as it is unless the operator says otherwise. Creature LANDINGS stay at 15.

## Queued (not started)

- **`seedOf` mixes poorly (class bug, found 2026-10-27).** `projectile.ts` `seedOf` is FNV-1a with no
  final mix: keys that differ only in their LAST character land close together (`…:pr1`…`:pr8` →
  0.351–0.398). Every seeded visual whose key ends in a counter is nearly uniform — including the
  shipped AF413 cracks (`l${i}`, `w${i}`, `t${i}`). Fix: a finaliser (e.g. murmur3 fmix32) inside
  `seedOf`; deterministic on both screens either way. Small lane, ship on its own.
- **AF413 follow-ups:** the mana-value landing for a noncreature permanent cast from hand; a browser
  e2e asserting `data-entry="rise"` on a reanimate scenario (`apps/server/src/play/af413-reanimate.state`
  exists) and that no card changes slot after a shove.
- **Instants/sorceries on resolve** — the operator: "resolutions we gotta think about differently".
  Not designed; ask before previewing. Ideas offered: a press-onto-the-stack ring by mana value on cast;
  the effect itself as the event on resolve.
- **Constrained searches multi-pick (AF411) + one picker UI + the "monkey seat" fuzzer** — approved by
  the operator 2026-10-26 ("yes do both") as an engine wave after the ask-path work; not drafted. Fork:
  `ChangeZoneEffect.java` `allowMultiSelect` is false for DifferentNames (23), WithTotalCMC (11),
  DifferentCMC (4), WithTotalPower (3), DifferentPower (2), ShareLandType (1), WithTotalCardTypes (1).
  The wave number "w77" was used by the front-page wave; give it the next free number.
- **AF397 pending-death shimmer** — look work; needs a preview first.
- **AF403** — the reveal wire frame (above).

## How previews were made (so the next ones are quick)

A scratch vite page under `~/.cache/cardtable-manager/<name>/` imports the deploy tree's real
components (`/home/hadoku/srv/hadoku-cardtable/apps/ui/src/...`) and the committed fixture
(`boardFromFixture(PLAY_FIXTURES[0])`), with `node_modules` symlinked to the deploy tree's
`apps/ui/node_modules`; `build.sh` builds and `inline.py` folds it into one self-contained `index.html`
for an artifact. To preview a change to an app module, swap the module at build time (the
`spell-damage-preview` vite plugin) rather than editing the app. Measure motion from the page (per-frame
positions, handover jumps, off-board frames), never by eye alone: every defect fixed today was found by
a number (a 23px turned-card offset, the uncentred trail, the seed clustering).
