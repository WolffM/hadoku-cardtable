# Handoff: trailer cut 2 feedback → waves 87 and 88, then trailer cut 3

**For the agent that scaffolds and manages these waves.** Written 2026-10-30 by promo-27, the session that shot trailer cut 2. The operator reviewed cut 2 and asked for this feedback to be catalogued and dispatched as new waves. You scaffold and run them; the operator does not want it done from the promo session.

## What you have
- **The cut-2 review artifact:** https://claude.ai/artifact/GsUN4VziEmaDAaSZL5Kpc2 (the 720p trailer, the beat sheet, findings).
- **Footage for every timestamp below:** `/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/promo/e2e/.run/promo/<clip>/<clip>.mkv`, plus `<clip>.marks.json`. Pull stills with `ffmpeg -ss <t> -i <clip>.mkv -frames:v 1 out.png`.
- **The master cut** and `beats.json` are in `…/promo/e2e/.run/promo/trailer/`.
- **The promo rig** (on branch `promo-clips`, not landed: 892cfd8ec):
  - `e2e/promo/rig.ts` films a headed Chromium on a private Xvfb display with a null pulse sink;
  - `e2e/promo/shoot.sh <clip>` runs one clip.
  - Look lanes can use it to film their before/after artifacts. Never show a browser on the operator's screen, and never use the default audio sink.
- **The cut-2 closing note:** `/home/hadoku/.cache/cardtable-manager/trailer-v2-closing.md`.

## Before you scaffold
1. **Main must be green.** At writing, CI on `b705764b2` was queued, and the four runs before it were green.
2. **Ledger rows:** add the rows listed at the end of this brief to `docs/planning/playtest-ledger.md` as `| AF??? |` (`land.sh` numbers them), and the waves to `docs/planning/workstreams.md`.
3. **Wave files:** write `docs/planning/wave87-<date>.md` and `wave88-<date>.md` from the per-lane sections below, with the "Settled" block at the top of each.
4. **Worktree env:** follow `docs/WAVE_WORKTREE.md` for each worktree's env block, copied from that doc, not from an older handoff. That covers Node 24, the per-pin jar, the PPE `res`, an on-disk `CARDTABLE_PLAY_WORK_DIR`, and linking node_modules with the absolute path.
5. **`@hadoku/shared`:** lane D changes `packages/shared`, and its worktree must link `@hadoku/shared` before any app-level test means anything.
6. **Lane models:** lane sub-agents run on Sonnet (`model: "sonnet"`), never as forks.
7. **Recheck everything below against live state** before it goes in a wave file. It was measured on 2026-10-30; other sessions land constantly.

# Wave brief: trailer cut 2 feedback (proposed waves 87 + 88)

**For the manager.** Source: the operator's review of trailer cut 2, 2026-10-30 (quoted per item below). Waves 84 (brackets) and 85 (events/front page) are already planned, and 86 belongs to hadoku_site/watchparty, so these are 87 and 88 unless the board says otherwise.

**Before dispatch:**
- Add the ledger rows below to `docs/planning/playtest-ledger.md` as `| AF??? |`; `land.sh` numbers them. Each lane links its row.
- Check the list against the ledger for repeats. The ones found are named per item.

**Shape:** two waves of three lanes, then one single session. Seven lanes break the wave-size rule (at most 4 lanes, ~3 h target, 4 h hard stop), so the work splits by area. Every lane is independent: no shared file, and each is at least an hour of work.

| wave | lanes | area |
| --- | --- | --- |
| **87: board motion** | A the punch · B stack placement and arrows · C same-target checkbox | `apps/ui/src/play/live/**` |
| **88: sound and lobby** | D creature sounds · E tournament table card · F deck grid transitions | `packages/shared` sounds, `screens/pod/*`, `ConstructedScreen.tsx` |
| **H (no wave)** | trailer cut 3 | one session in the existing promo worktree, after 87 and 88 have deployed to PPE |

- 87 and 88 share no files, so they may run side by side. Running them one after the other is the default (`parallel-waves-need-a-landing-queue`, `heavy-lock-is-the-wave-clock`). If they do run together, they land through the one `scripts/land.sh` queue.
- A and D share one rule (the `entryWeight` curve, see Ordering). If the waves are sequential, run 87 first so D builds on A's lifted module. If they run in parallel, D only reads `entryWeight` and never edits `entries.ts`.
- There is no lane G: AI names stay as they are (see Settled).

**Look lanes:** A, B, E and F (and D's sound picks) **publish an artifact and wait for the operator's approval before landing** (`show-motion-as-an-artifact`).

## Settled: do not re-open
- **Counter war resolving all at once is fine.** Operator: "oh it's because the spells fizzle when the top counterspell resolves. i guess that's fine." That retracts cut-2 finding 1. No lane.
- **The trailer keeps its music bed and hard cuts.**
- **AI names stay as they are** ("Sage", "Knight": the sprite id, capitalised). Operator, 2026-10-30: "keep the AI names as is, but for the sake of the trailer can you pretend that it's two real people?" So the product doesn't change, and the trailer films two humans with gamer tags (§H).
- **A strong hit's board effect scales the way an entry does.** Operator, 2026-10-30: "we should match the power of the board effects to how they scale with entry." That means `entryWeight` (`apps/ui/src/play/live/entries.ts`): continuous with power up to `ENTRY_MAX` (15), shake from 5, cracks from 7, cards knocked away from 8 and a second ring from 12. There is no separate tier table for hits.
- **Trailer text style: C2 (the top kicker, anchored), varied per page** so consecutive beats don't look the same. Picked 2026-10-30 from the options artifact linked at the end of this brief.

## Lanes

Wave 87 is A, B and C. Wave 88 is D, E and F. H comes after both.

| lane | what | owns (files) |
| --- | --- | --- |
| **A** the punch | Creature hits on a player land harder at both ends, plus an Emrakul-style board effect when a strong creature hits. | `apps/ui/src/play/live/ram.ts`/`ram.css`, `crash.ts`/`crash.css`; reads `entries.ts`'s arrival effect, and if the effect must be shared it is lifted out of `entries.ts`, not copied |
| **B** stack placement and arrows | Triggers overlap when crowded, collide on the inner 50%, and spread with jittered directions. A new arc algorithm. Corner brackets only before a target is committed. The stack never covers the control box. | `apps/ui/src/play/live/placed.ts`/`placed.css`, `apps/ui/src/play/live/gestures/arrow.ts`/`arrow.css`/`stack.ts`/`targets.ts` |
| **C** same-target checkbox | Visible and pressable at 1920×1080 whenever several triggers of the same source want targets. | the `sameTargetCheck` block in `apps/ui/src/play/live/LiveBoard.tsx` (~2909, ~3944) and the confirm/target prompt css; no other `LiveBoard.tsx` edits |
| **D** creature sounds | Landing tiers get takes, and artifact and colourless creatures get their own voice. | `packages/shared/src/sounds.ts` (roles, `LANDING_TIERS`), `apps/ui/src/play/live/sound-events.ts`, `scripts/sfx/**`; the server's sound catalogue through the builder only |
| **E** tournament table card | The face-off/match card redesigned: compact, centred, no dead space, better buttons. | `apps/ui/src/screens/pod/TablePage.tsx`, `FaceOff.tsx`/`FaceOff.css`, the table-page rules in `PodSeats.css` (grep the block name first: `bem-blocks-are-global`) |
| **F** deck grid transitions | Switching era or format crossfades instead of popping. | the deck grid in `apps/ui/src/screens/ConstructedScreen.tsx` and its css; the AF225 skeleton stays |
| **H** trailer cut 3 | Re-shoot and re-cut after A–F. | `e2e/promo/**`, `apps/server/src/play/scenarios/promo-*`; branch `promo-clips` (worktree `.claude/worktrees/promo`) |

**Ordering:**
- A and D both scale with a creature's power the way its entry does (`entryWeight` in `entries.ts`, the one curve). A drives a hit's board effect from that same function, and does not write a second curve.
- D's landing sounds are discrete tiers (`LANDING_TIERS` = 3/5/7/10 in `packages/shared/src/sounds.ts`, owned by D). D moves the cut points onto `entryWeight`'s thresholds (5 shake, 7 cracks, 8 knock-away, 12 second ring), so a sound gets heavier exactly where the picture does. The constant stays in one place, with a unit test pinning it against `entryWeight`.
- `packages/**` changes are invisible to apps in a worktree until linked (`worktree-node-modules-hides-package-changes`), so D links `@hadoku/shared` before testing.
- C is the only lane in `LiveBoard.tsx`. B and A reach the board through their own modules.
- H starts after A–F have landed and deployed to PPE. The promo session rebases `promo-clips` onto main, rebuilds, and films that build. It doesn't film any lane's worktree.

## §A: the punch (repeat: AF119, AF146, AF148, AF413; asked at least 4 times)
> "i notice that the creature's impact still isn't what i want. i notice it both with low-damage creatures and high damage creatures. both ends of the spectrum need to hit harder. both the floor and the ceiling for how much velocity is reached with each "punch" should be harder. and let's add a bit more animation as well. remember how we added that nice board animation for when emrakul hits the board? i want to try something similar with when strong creatures hit the opponent."

- **Measure first:** record the peak velocity and the impact frame for a 1-power and a 10+-power hit on today's main (the AF119 harness or a Playwright frame trace), and put the numbers in the lane report.
- **Raise both ends:** the floor (1 power) and the ceiling (largest tier) both reach a higher peak velocity, with the same slow start and burst shape AF119 asked for.
- **The strong-hit effect:** reuse the arrival board effect (AF413's screenshake, cracks and knock-away for big creatures entering), driven by the attacker's power through `entryWeight`. That is the operator's ruling: "match the power of the board effects to how they scale with entry". The same thresholds apply (shake from 5, cracks from 7, knock-away from 8, a second ring from 12), growing continuously to 15. Lift the effect out of `entries.ts` into one module that both the entry and the hit call; don't copy it.
- **Failing spec first:** a unit test that pins peak velocity per tier (red on main at the new floor and ceiling), plus an e2e that asserts a hit's board effect matches `entryWeight` for the attacker's power (none at 2, shake at 5, cracks at 7+) and is the same module the entry uses.
- **Artifact first:** a side-by-side of the old and new hits at 1, 4 and 10 power, filmed with the promo rig (`e2e/promo/rig.ts`).

## §B: stack placement and arrows (repeat: AF451)
> valakut: "i notice the triggers don't nicely spread out on the board. if there isn't enough space to fit more triggers, i wish for them to stack on top of eachother. it's okay if it's messy. allow them to bump into eachother and make the collision only the inner 50% of the card's area. also when they spread out can we apply a slight randomization to the directional vector? that would make things look more natural."
> counter war: "the arrows are too small and they look weird. probably because the cards are too close, but something about the arrow arc algorithm still needs to be changed." / "the corner targeter boxes are ugly. i think i only want to keep those for when a target hasn't been committed yet. they are way too noisy."

- **Placement (`placed.ts`):**
  - Collision boxes are the inner 50% of a card's area, so cards may overlap at the edges.
  - When there is no free spot, cards pile on top of each other rather than being refused or squeezed.
  - The spread direction gets a small random rotation, seeded per stack item, so a replay draws the same layout.
- **Also in B:** the stack must never cover the control box. Cut-2 finding: a Valakut trigger sat over End Turn at valakut.mkv ~16 s.
- **Arrows (`arrow.ts`):**
  - Close source/target pairs get a readable arc: a minimum arc height and length, and a head that is not clipped by the cards.
  - Read the counter-war frames: trailer 25–43 s, and counterwar.mkv ~26–37 s in the promo worktree.
- **Brackets:** the corner brackets (`markArrow`, `arrow.css` "corner brackets") show only while a target is being chosen, not after it is committed. Delete the committed-state bracket code; don't hide it.
- **Failing specs first:**
  - Placement unit tests: 10 triggers on a small board overlap and none is dropped; inner-50% collision; the jitter is seeded and stable.
  - Arrow unit tests: a minimum arc for adjacent cards.
  - An e2e on `promo-valakut`: all ten triggers are drawn and none sits over `live-button-end-turn`.
  - An e2e on `promo-counterwar`: no corner brackets on committed targets.
- **Artifact first:** Valakut's ten triggers and the six-deep counter war, filmed.

## §C: same-target checkbox (repeat: AF12, landed and awaiting ✅)
> "when selecting a target for valakut, i would expect to see a checkbox that allows picking 'select same target for all?' this checkbox should appear when the game detects multiple triggers of the same thing on the stack."

- **It exists** (`live-same-target`, LiveBoard.tsx ~2909), but at 1920×1080 it is drawn under the target popup's own tiles. The promo driver has to click it through the DOM; see the comment in `e2e/promo/valakut.promo.ts`. The operator never saw it in either cut.
- **Failing spec first:** an e2e at 1920×1080 on `promo-valakut`. The checkbox is visible, not covered (elementFromPoint at its centre is the checkbox), and a real pointer click ticks it.
- **Also check** that it appears only when two or more pending triggers share a source, and test that.

## §D: creature sounds (audio workstream rules apply: the operator picks takes, and "harvest" means `harvest.py`)
> "no creature land sound? we should get a progressively more intense creature land sound that matches the effect of the creature landing." / "need a different sound for artifact creatures and colorless creatures."

- **Measured (2026-10-30):** the roles `g.landing.3/5/7/10` exist (`landingRole`, `packages/shared/src/sounds.ts:204–214`), but the deploy tree's `assignments.json` has no take in any of them. Every creature falls back to the single `g.enter` take, so the tiers are silent in practice.
- **Landing takes:** generate candidates for the four landing tiers, rising in weight and intensity, in step with the arrival effect (AF413 / §A). Present them to the operator as an artifact; the operator assigns. Read `scripts/sfx/retired.py` first, and check raw clipping (`sfx-raw-takes-clipped`).
- **Artifact and colourless creatures:** today the voice is the colour × creature cell. Add an artifact-creature row and a colourless-creature row (the role, then `sound-events.ts` choosing it from the type line and colours), with a fallback to the current behaviour while the cells are empty.
- **Failing spec first:** a `sound-events.test.ts` case where an artifact creature and a colourless Eldrazi each pick their new role (red on main).

## §E: tournament table card (repeats: AF361, AF372, AF442)
> "this match card looks quite ugly (showing Ashgrove vs Cleric for example) i really dislike how much space it takes, the empty space at the top, that it's not vertically centered and the buttons also look bad. we gotta improve this."

- **What the operator sees:** the table page after pairing. It has a "Ashgrove vs Cleric" title, the two avatars with 0–0 between them, "not ready" chips, and Ready far off to the right. See trailer ~93–100 s and tournament.mkv ~8–11 s.
- **Keep:** the full-width rush-in of the face-off (AF442), and the standings boxes that click back into a game (AF372).
- **Fix:**
  - The card is compact and vertically centred in its space, with no dead band above it.
  - The buttons are styled from the theme (`state-colours-are-theme-tokens`).
  - There is no explanatory text (`no-explanatory-ui-text`).
- **Artifact first:** two or three layouts at 1920×1080 and at phone width. Then the operator picks, then build.
- **Spec:** a layout e2e asserting the card's vertical centring and its height bound. Grep `e2e/` for `table-page`/`face-off` test ids before changing markup (`e2e-specs-pin-ui-defaults`).

## §F: deck grid transitions (repeat: AF225)
> "30 years of real tournament decks: while flipping through the decks they sort of pop into existence. can we make this loading animation better? how do we smoothen the switching between each list?"

- **On an era or format switch:** the old grid fades or slides out and the new tiles arrive staggered, with art decoded before a tile shows (`preload-both-decks-art`'s rule: never draw a face before its art decodes). The AF225 skeleton (12 boxes) stays for first load.
- **Spec:** an e2e flips eras three times and asserts no tile is painted with an undecoded image, plus a check that the transition completes and the grid is interactive afterwards.
- **Artifact first:** film it with `e2e/promo/constructed.promo.ts`'s era flip.

## §H: trailer cut 3 (the promo session; after A–F land)
> "i dont really like the floating text at the bottom. it kind of covers part of the page and it just looks ugly? it would be nice to show some text on the screen, but this is not it."
> "'play the decks that made history' showing the front page is a bit ugly. i think we don't need this slide at all."
> "'pick a deck, sit down. play' can we instead show the head-to-head animation in tournament mode? that one looks cooler."
> "in the next trailer take, i'd prefer to see it from a non-manager perspective so we dont get the extra management buttons in there."

- **Caption style: C2, varied per page** (the operator, 2026-10-30): "C2 · TOP KICKER, ANCHORED … this looks nice. but we'll want to vary this somewhat with each page we're showing so each demo run doesn't look so boring."
  - **One family:** the type (Noto Sans Black headline, letter-spaced SemiBold label), the accent purple, the rule, and the ease-out timing all stay fixed. Recipe: `/home/hadoku/.cache/cardtable-manager/trailer-text-styles/make2.py`.
  - **What varies:** the anchor and the entrance, chosen per beat. No two consecutive captions share both.
  - **Anchors, each fixed to something on that screen and never a free placement:**
    - game board: the top band, right-aligned to the battlefield's edge (C2 as approved); or left-aligned when the opponent's hand is empty;
    - lobby screens: the page-title row (room name, right side);
    - the draft: above the pack;
    - Gauntlet: over the reveal row's empty top;
    - tournament: centred above the face-off.
    Measure each anchor from a still of that clip before rendering.
  - **Entrances:** words rising one by one (as approved); a mask wipe left to right; letters sliding in from the anchored edge; the headline dropping in from above with a short settle. The rule leads each entrance from the side the text is anchored to.
  - Put the vocabulary in `cut.py` as data: a caption is (text, kicker, anchor, entrance). The fixed lower-third code goes.
- **Ending: a rapid-fire montage, then Progenitus** (the operator: "at the end i want a rapid first of a bunch of cool moments. we might need to generate some more stuff. maybe the final flip being someone getting hit by progenitus.")
  - **The montage:** about 12–16 shots of 0.35–0.7 s each, cut on the music bed's beat (find the beat grid with an onset detector, e.g. `aubio onset` or librosa, and cut on onsets). Hard cuts and no captions. It accelerates into the final shot.
  - **Final shot:** Progenitus hitting a player, at full length and real speed. Progenitus is a 10/10, so this is lane A's strong-hit effect at the top of the `entryWeight` curve, with its sound (lane D's top landing and impact tiers), then the end card.
  - **New scenarios to write** (`apps/server/src/play/scenarios/promo-*.state`: no blank lines, no shocklands, human* = seat 0):
    - `promo-progenitus`: Progenitus already on the hero's battlefield, untapped and not summoning-sick, with the rival at 10 or less and no flyers or blockers that matter (protection from everything makes blocks moot anyway). The hero attacks.
    - Candidates for the montage, each a 1–3 s moment:
      - Show and Tell into Emrakul or Griselbrand;
      - a Craterhoof Behemoth swing with a wide board;
      - storm: Tendrils or Grapeshot copies stacking;
      - Lightning Bolt to the face;
      - Force of Will pitched;
      - Wrath of God;
      - Oko turning a creature into an Elk;
      - a planeswalker ultimate;
      - Jace, the Mind Sculptor's Brainstorm;
      - a Gauntlet ban X slamming down;
      - a draft pick landing in the pool;
      - a tournament bracket advancing;
      - a Victory screen.
    - Reuse cut 2's best frames too: Emrakul's landing, the ten Valakut arrows, the Sutured Ghoul swing, the Blasphemous fireballs, Tamiyo turning over.
  - Film the montage's new scenarios after lanes A, B and D have landed, so the hits, stack and sounds are today's.
- **Captions:** the lower-third bar and vignette (`caption_filter` in `cut.py`) go; C2-varied (above) replaces them.
- **Front-page slide:** drop it (`constructed` front → front+3.3). "Play the decks that made history / with your friends" moves to the next beat, or onto a card in the style the operator picks.
- **"Pick a deck. Sit down. Play.":** replace the ready → board beat with the tournament face-off rush-in. That means filming the tournament table page after §E lands.
- **Tournament from a non-leader:** the filmed seat is not the room's leader. Today `tournament.promo.ts` creates the room as the hero; create it as `vexmoor` instead, so no Reset/DQ/leader controls are on screen.
- **Gauntlet as two real people:** the operator wants it to look like two people, not a player against "Sage". Film the Gauntlet clip between two humans with gamer tags (hero `ashgrove` as Fern vs `nightjar` as Himmel, both from `e2e/identities.ts`'s promo rows). The rival seat runs headless and its bans, picks and choices are pressed by the driver. No AI seat in that clip. Check the tournament clip's face-off pairs the hero against a human too (seat order or pairing seed), or film a human-vs-human table.
- **Human mouse movement** (the operator, 2026-10-30: "for future trailer, lets add a bit of randomness to simulate human mouse movement"). Today `e2e/promo/drive.ts` glides the pointer in straight, evenly stepped lines (`page.mouse.move(..., { steps })`), which shows in the replay card's cursor and in hover timing. Add one `humanMove(page, to)` helper:
  - a curved path (a quadratic Bézier with a random perpendicular offset);
  - ease-in-out speed, a small overshoot-and-settle on long moves, and a little per-step jitter;
  - randomised rest times between moves;
  - seeded per clip, so a re-shoot is reproducible.

  Route every pointer move in `drive.ts` through it: `deliberateClick`, `cast`, `restCursor`, `glide`, the deck hovers and the draft sweep. Delete the straight-line moves; don't keep them alongside.
- **Re-shoot everything after A–F,** so the punch, stack, arrows, checkbox, sounds, table card and deck transitions are all today's.
- **Valakut:** the same-target tick becomes a real click (§C).
- **Rig carry-over from cut 2:** `startFilm` on display :97 and the null sink, the 4.5 s fullscreen-bubble wait, the production sprites without Referer, and the prefs-cache avatars.
- **Still open from cut 2:** scenario clips show silhouettes (finding 5). Either the play server takes a seat avatar for a roomless scenario match (a test-only option), or the gameplay clips start from a room.

## Not in a lane this wave (cut-2 findings for the tracker to triage)
- **Front-page replay card:**
  - A cold load shows an empty "Turn 0" square for about 4 s before the first frame (constructed take 2, 0.5–4.3 s).
  - The active player's held card is drawn face down (◆) mid-drag in the replay (constructed.mkv ~3.5–5.5 s).
  - `apps/ui/src/front/**` belongs to wave 85.
- **Waiting-bar wording:** "Waiting for Nightjar to choose cards for Force of Will…" while Nightjar picks Spell Pierce's target, and the bar covers the Oko stack card (counterwar.mkv ~30 s).

## Ledger rows to add (`| AF??? |`, asked = 1 unless noted)
1. Punch floor and ceiling harder, plus a strong-hit board effect. Repeat of AF119/AF146/AF148/AF413. → §A
2. Stack triggers overlap when crowded, inner-50% collision, jittered spread. Repeat of AF451. → §B
3. Arrow arc and size for close cards. → §B
4. Corner brackets only before a target is committed. → §B
5. A stack item covers the End Turn button (cut-2 finding). → §B
6. Same-target checkbox unseen: drawn under the popup's tiles. Repeat of AF12. → §C
7. Creature landing sounds silent in practice (empty `g.landing.*` cells). → §D
8. Separate voices for artifact and colourless creatures. → §D
9. Tournament table card: compact, centred, better buttons. Repeat of AF361/AF372/AF442. → §E
10. Deck grid pops on an era switch. Repeat of AF225. → §F
11. AI opponents named after their sprite id. Answered: kept as is (the operator, 2026-10-30); the trailer films humans instead (§H).
12. Trailer cut 3: captions, the front-page slide dropped, the face-off beat, a non-leader tournament. → §H
13. Counter war resolving at once: answered, no change (record it as closed by the operator's answer).
14. Replay card cold load ~4 s empty, and the held card face down. → triage, wave 85.
15. Waiting-bar wording and placement during a stack target. → triage.

**Standing rules for every lane:**
- `docs/lanes/RULES.md`.
- A failing spec first (`report-becomes-failing-spec-first`).
- Delete what you replace (`waves-must-delete-what-they-replace`).
- Fix the shared mechanism, not the instance (`system-level-fixes`).
- Proofs follow `proof-budget-after-ci1`.
- A release-notes file in `docs/releases/pending/` for every player-visible change.

## Done when (per wave, for the tracker to check from artifacts)
- Every lane's failing spec is red on its base and green on the landed commit. A local spec run with no Forge jar shows as skipped (exit 0), so a skip doesn't count as green.
- Each look lane (A, B, E, F) has an artifact the operator approved before it landed, and D's takes were assigned by the operator.
- Each lane landed through `scripts/land.sh`, CI `check` is green on main, and the change is deployed to PPE.
- Each player-visible lane added a release-notes file in `docs/releases/pending/`.
- Each lane wrote its own closing note, with mutation counts, before the worktree was removed.
- After both waves: hand H to the promo session (worktree `/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/promo`, branch `promo-clips`) with §H as its brief.

## Text style options (for §H)
https://claude.ai/artifact/GCwbQMFuqrWa4PuBqeEihw shows four treatments on the same counter-war beat:
- **A:** a full-frame title card between beats;
- **B:** large centred type over a blurred, dimmed opening;
- **C:** a top kicker in the opponent's empty band;
- **D:** the empty chat rail on the right.

The ffmpeg recipe that renders them is `/home/hadoku/.cache/cardtable-manager/trailer-text-styles/make.py`, ready to fold into `cut.py`. **Round 2 (same link, top of the page):** the operator liked C and D best but found the placement "a bit random" and asked for animation. So:
- **C2** right-aligns to the battlefield's edge;
- **D2** sits on the chat rail's own margin, on a panel in the board's surface colour;
- both animate: an accent rule slides in, the label's letters cascade, the words or lines rise 70 ms apart, and everything lifts away together.

The recipe is `make2.py` beside `make.py`. **Picked: C2, varied per page** (operator, 2026-10-30). See §H.
