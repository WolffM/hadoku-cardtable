# Motion unification — one animation kit any game can use

The operator, 2026-11-21: *"unify the animation framework … i would prefer if the animation framework was
magic agnostic and can be used for other games in the future … build animations in an abstract/generic
way such that they are built efficiently and consistently."*

This is the programme. It runs in three steps: **M1** (a single session), **wave 124** (three lanes,
`wave124-2026-11-21.md`) and **M3** (a single session). Every count below was measured on `origin/main`
`28b5c1e90`.

## What is there now (measured)

There is no third-party animation library. Everything is the Web Animations API (WAAPI) plus CSS:

- 125 `@keyframes`, 65 `transition:` declarations;
- 23 direct `.animate(` calls in 10 files;
- `requestAnimationFrame` in 21 source files.

**A framework already exists, but it lives in Magic's folder, and `layers.json` classifies it `magic`**
(`games/magic/ui/**`), so no platform file may import it:

| file | generic mechanism | Magic content mixed in |
| --- | --- | --- |
| `games/magic/ui/src/play/motion.ts` (529) | beat registry: `noteBoardDrawing`, `whenBoardStill`, `whenBoardUnlocked`, `animationsSettled`, `UNLOCK_AT`, `unlockAfter`; `writeDurations`; `afterGlide` | `damagePower`/`MAX_DAMAGE`/`damageSize`; four identical `{seq, at}` slots (`noteLifeImpact`, `noteCardImpact`, `noteExitBeat`, `noteMillBeat`) plus `noteBoardSounds` |
| `games/magic/ui/src/play/frame-phases.ts` (52) | `everyFrame`: one rAF, all reads then all writes | none |
| `games/magic/ui/src/play/live/effect-budget.ts` (43) | `claimParticles`, `particleShare`: a particle pool per board | none |
| `games/magic/ui/src/play/live/tempo.ts` (181) | `quicken`, `markTempo`, `tempoOf` | `instanceKey` (stack items, mills) |
| `games/magic/ui/src/play/live/quake.ts` (396) | `play()` (guard + tempo + collect + never-reject), `standIn`, `Box`/`rel`, `shadow` | cracks, shoves |

`powerEase`/`homeEase` (`motion.ts`) are generic too: a 0–1 weight in, a cubic-bezier out.

**The inconsistency is at the edges:**

1. **`play()` is barely used.** Only `entries.ts` imports it. Nine files repeat the
   `typeof el.animate !== 'function'` guard, and `quicken` is called by hand in six.
2. **Beats are recognised by name, not registered.** `motion.ts`'s `isBeat` counts an animation as a beat
   when its id is `'beat'` (28 sites in 7 files) or its keyframe name starts with `board-exit-`,
   `board-number-`, `effect-` or `placed-` (33 keyframes). Renaming a keyframe silently takes it out of
   the pacer's wait.
3. **There are four handle shapes.** A cancel (`recoil`, `blast`), `{done, cancel}` (`quake`), a Promise
   (`play`), and install handles (`installMill`, `installNumbers`).
4. **Sequencing is a timeline worked out by hand.** `live/numbers.ts` (1,652 lines) directs every view
   with `schedule`/`atBeat`, which are `setTimeout(fn, delayMs / tempo)`, and its offsets are summed from
   constants (`ALIGN_MS + contactMs(kind)` …). A timeline's length is known only by adding it up.
5. **Reduced motion and tempo are opt-in per file.** 22 files call `prefersReducedMotion()` directly, and
   only some honour `host.reducedMotion`. `PackView`, `SeatBar`, `ModeRow` and `gauntlet/arrive.ts` have
   no tempo, no beat and no cancel on dispose.
6. **The global state is module-level.** `motion.ts`'s `drawing`/`locked` sets are module-level, so two
   boards on one page (a featured match beside a live one) share one pacer clock.

## Bomberman, checked (`~/repos/hadoku-bomberman`, `f9f573a`)

- **The game is Bevy 0.18 compiled to WASM, drawing to a canvas.** Its in-game motion is ECS systems
  running on simulation time: popups fade (`game/src/sim.rs:294`), explosions fade out of their lethal
  window (`sim.rs:330`), the shrinking ring blinks (`sim.rs:437`). That motion is tied to the simulation
  and has to stay in Rust. No TypeScript kit drives it, and none should.
- **Its DOM side is CSS only:** `bomberman-cover-in`, `bomberman-digit` and a few transitions
  (`apps/ui/src/styles/index.css`, `room/SeatOverlay.css`), each with a `prefers-reduced-motion` block.
  There is no WAAPI, no rAF and no sequencing.
- **It already depends on `@wolffm/ui-shell` 0.1.100** (`npm:@hadoku/ui-shell`), whose `./motion` export is
  today's 8-line `prefersReducedMotion`. Anything that lands there reaches bomberman with no new dependency.
- **What it would reuse:** the reduced-motion preference, duration tokens, and `animate()`/`Running` for
  its DOM chrome (cover, countdown). **What it would not:** the stage's unlock clock (bomberman is
  real-time, and nothing waits on an animation), and a canvas backend.
- **A gap found on the way:** nothing under `game/src` reads reduced motion, so the canvas blinks and
  flashes regardless of the viewer's setting. That is bomberman's item, not this programme's.

Design consequences: the kit lives in **`packages/ui-shell/src/motion/`**, not a new package. The stage's
pacer half (unlock) stays optional. No canvas backend is built.

## The kit (target shape)

There is no class hierarchy. WAAPI animations are already objects, and a base class would wrap a wrapper.
Instead, one result shape, one context, and a stage per board:

```ts
// packages/ui-shell/src/motion/
interface Running { finished: Promise<void>; cancel(): void; endsInMs: number }
type Clip = (ctx: MotionContext) => Running;

interface MotionContext {          // handed in, never read from a global
  stage: Stage; overlay: HTMLElement;
  tempo: number; reduced: boolean;
  frame: typeof everyFrame; particles: ParticlePool;
}

animate(el, frames, opts, ctx): Running   // the ONE .animate() call: guard, tempo, reduced fallback, stage
seq(...clips) / par(...clips) / at(ms, clip) / stagger(ms, clips)   // M3, with numbers.ts as first user
class Stage {                      // one per board; replaces motion.ts's module sets
  track(r: Running, o?: { unlockAt?: number; after?: Promise<unknown> }): Running
  trackCss(el: Element): Running   // a stylesheet animation, registered explicitly, not by name
  whenStill(fn) / whenUnlocked(fn) / cancelAll()
  cue(name, seq, at) / cueAt(name, seq)   // replaces the four note*Beat slots
}
everyFrame, claimParticles/particleShare, standIn(overlay, el, copy), Box/rel, weightEase/homeEase, writeDurations
```

**Magic keeps:** what animates (`diffViews`, `planRams`, `millsOf`, `ptChanges`), its weights
(`damagePower`, `MAX_DAMAGE`, `entryWeight`), `copyOfCard`, `instanceKey`, and its recipes (`ram`, `crash`,
`projectile`, `quake`, `entries`, `mill`, …), which become `Clip`s built from the kit.

## Steps

| step | shape | what it makes true | why that shape |
| --- | --- | --- | --- |
| **M1** | single session | the kit exists in `ui-shell/motion`: the moves, `animate()`, `Running`, `Stage` (with a default instance so `motion.ts`'s 24 importers do not move), cues, and the ratchet test | one dependent root: every later lane imports it |
| **w124** | 3 lanes, each net negative | every `.animate()` and rAF in Magic goes through the kit, with **exported signatures unchanged** | three disjoint file sets (board blows / board beats / off-board screens) |
| **M3** | single session, long pole | `numbers.ts` sequenced with `seq`/`par`/`at`/`stagger`; effects return `Running`; old signatures, `BEAT_KEYFRAMES`, name-based `isBeat` and the default stage deleted | it rewires the one file every effect is called from; timing-critical |

### M1 — the kit (single session, before w124)

1. Move `frame-phases.ts`, `effect-budget.ts`, `quicken`/`markTempo`, `play` (as `animate`), `Box`/`rel`,
   `standIn` (taking a `copy` callback in place of `copyOfCard`), `writeDurations`, `afterGlide` and
   `powerEase`/`homeEase` (as `weightEase`/`homeEase`) into `packages/ui-shell/src/motion/`. Magic's old
   paths re-export them. The tests move with their code.
2. Add `Running` and `Stage`. `motion.ts`'s module functions become calls on a `defaultStage` it
   exports, so `pace.ts:642`, `LiveBoard.tsx:1925` and every `noteBoardDrawing` caller are unchanged.
3. Cues: delete the four `{seq, at}` slots and `noteBoardSounds`/`boardSoundsAt`, replaced by
   `stage.cue`/`cueAt`. Update the writers (`numbers.ts`, `mill.ts`) and the one reader
   (`LiveBoard.tsx:1858–1880`).
4. Add a ratchet in `pnpm run check`: count direct `.animate(` and `requestAnimationFrame(` in
   `games/**` and `apps/**` source (tests excluded). Today that is 23 and 21 files. The count may only fall,
   on the model of `scripts/layers/ratchet.test.ts`.
5. **Made dead / deleted:** the four slots, Magic's own copies of the moved files (re-exports only),
   `play` in `quake.ts`.
6. **Done when:** `pnpm run check` is green, with the ratchet test present and failing when a
   `.animate(` is added to a Magic file. The layer ratchet is green (`ui-shell` stays platform). The
   non-test diff is recorded (`jscpd`/`knip` before and after). **Amended 2026-11-22:** M1 adds an API whose
   duplicates wave 124 deletes, so the net gate binds each wave-124 lane and the programme as a whole, not M1.
   M1 measured about +72 non-test lines (the ratchet script +48, the kit and Magic about +24). A claw run of
   `fx-effects`, `af413-weight`, `cp-lethal-blow`, `w69-attack-flash` and `mana-ring-once` is green, plus
   whatever a grep of `e2e/` for the moved symbols' attributes adds.

### M3 — the director (single session, after w124)

1. Add `seq`/`par`/`at`/`stagger` to the kit. A combined clip's `endsInMs` comes from its parts.
2. `numbers.ts`'s `schedule`/`atBeat` timeline becomes a `Clip` per view, and its `beatsOver`/unlock
   comes from `stage.track(view)`. Effects return `Running`.
3. CSS beats that `numbers.ts`/`departures.ts`/`placed.ts` start by attribute register with
   `stage.trackCss`. Then delete `BEAT_KEYFRAMES`, `BEAT_ANIMATION_ID` and the name-based `isBeat`.
4. `LiveBoard` creates its own `Stage`. Delete `defaultStage`, and give `pace.ts` its stage by option (it
   already takes `boardStill` by option, `pace.ts:642`).
5. **Done when:** a full Forge run (`full=true`) is green on the M3 head. Timing specs are proven under
   the CPU quota. A two-browser film of a wipe (Blasphemous Act) and a lethal combat, before and after, is
   shown to the operator as an artifact with no visible difference. `numbers.ts` is smaller.

### What wave 124 left M3 (amended 2026-11-22, after the wave)

Wave 124 landed C, A, B and an extra lane K on `origin/main` (`c17b5a965`…`6ba7a296a`). PPE serves
`6ba7a296a`, from green CI run 45037209264. Its first e2e attempt hit the 23-minute timeout on a loaded claw,
with every spec about 1.86× slower and none failing; the re-run took 10.5 min. The ratchet now reads
`.animate(` **0** and `requestAnimationFrame(` **24**. Non-test diff: A −19, B −6, C −2, K 0. The wave
totals −27, so **the programme still stands +45 over M1's +72, and M3 must delete at least that much**.
Per-lane notes: `~/.cache/cardtable-manager/w124-closing.md`.

M3 takes on, beyond steps 1–4 above:

- **The `'beat'` id is still an e2e probe.** A kept `BEAT_ANIMATION_ID` beside `stage` in 21 lines
  (crash, entries, projectile, quake, ram), and B kept it on the die. `e2e/motion-combos.spec.ts:100` finds the
  shake by `a.id === 'beat'`, and `e2e/w80c-unlock-early.spec.ts:92` records `'beat'`-named animations.
  Move those probes to the stage's own registration first, then delete the ids.
- **`trackCss` is too wide for step 3.** `Stage.trackCss(el)` (`stage.ts:109–112`) registers every finite
  animation in the subtree, which would add a card copy's `pt-glint-*`, `pt-roll-*` and `card-shimmer`, and a
  `.placed`'s translate transition, to the pacer's wait. Step 3 first needs a `trackCss` limited to the element
  itself or filtered by name. B's list of stylesheet beats:
  - `data-exit-go` (`.board-departure`): `board-exit-{crumple,return,dissolve-sweep,dissolve-hold,dissolve-tint,dissolve-aura,speck,shard,crack,slash,slice-top,slice-bottom}`
  - `data-placed-resolving` (`.placed__hover`): `placed-resolve`
  - `data-placed-countered` (`.placed`, its tile/back and crack lines): `placed-countered-{fade,drain}`, `placed-crack-draw`
- **`everyFrame` passes no frame time.** `rooms/scroll-watch.ts:134,142` times frames from the rAF timestamp,
  so it stays on a raw rAF until the step receives the time.
- **`everyFrame` has no test reset.** A test that switches to real timers while a fake frame is owed leaves
  `frame` set, and no loop runs again in that file. K fixed only the double scheduling (`frame ??=`).
- **The die's unit test no longer catches a missing stage**, because the `'beat'` name alone keeps it counted.
  Make it check registration directly when the ids go.
- **Not the wave's:** `e2e/w79a-arrival.spec.ts:317` flakes on the pre-wave base too (#94).

## Not in this programme

- **A canvas or Bevy backend.** Bomberman's motion is simulation-coupled Rust; nothing calls for it.
- **Bomberman's canvas ignoring reduced motion.** It belongs in hadoku-bomberman, filed there if the
  operator wants it.
- **Any change a player can see.** This is a refactor. A visible difference is a bug in the lane.
