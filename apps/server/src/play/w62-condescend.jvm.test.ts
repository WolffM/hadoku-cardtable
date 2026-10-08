/**
 * The operator, on Condescend: *"i cast 'condescend' which
 * lets me scry as part of the resolution of the spell, but also asks the
 * opponent about paying the cost. lets be careful and resolve these things
 * one at at time, i dont think it should be showing simultaneously."*
 *
 * Whether Forge opens bob's "pay {X} or be countered" window (he is the
 * targeted spell's controller) and alice's own, unconditional Scry 2 AT
 * ONCE — both already on the wire before either is resolved — or in
 * sequence, was NOT measured before this wave. This is that measurement,
 * against a real Forge jar: bob (`ai…`
 * keys, `w62-condescend.state`) casts Grizzly Bears in his own Main Phase
 * 1; alice (`human…` keys) responds with Condescend, X=1, targeting it
 * (the only spell on the stack, so Forge's own targeting choice is a
 * single-option shortcut, answered explicitly below because full control —
 * see next paragraph — disables that shortcut too). Once both seats have
 * passed priority on "Stack: 2 to Resolve", Condescend resolves.
 *
 * **Measured first, and worth recording — both wrong against the wave
 * file's own guess of `confirm`/`manipulateCardList`:**
 * - Bob's "pay or decline" is NOT a `kind: 'ask'` at all — it is the
 *   ORDINARY mana-payment channel every cost uses (`showPromptMessage` +
 *   `updateButtons`, Auto/Cancel), which this harness's default policy
 *   auto-pays the instant it is affordable (`match.ts`'s `autoPayReason`) —
 *   bob has a spare Forest so it always is. Full control
 *   (`s.match.setFullControl`) is the one thing that turns this into a
 *   real, un-auto-resolved stop (`autoPayReason`/`trackPayment` both gate
 *   on `s.fullControl`), the same escape hatch `scenario-w46-b-
 *   counterspell.jvm.test.ts` uses for its own single-target ask; both
 *   seats get it here, so Grizzly Bears' own cost needs a `landPayer` too.
 * - Alice's Scry 2 is NOT `manipulateCardList` under this host's own
 *   `FORGE_PREFERENCES` (`UI_SELECT_FROM_CARD_DISPLAYS: 'false'`,
 *   `host.ts`): `PlayerControllerHuman.arrangeForScry` (two cards, that
 *   pref off) calls `getGui().many(…, min: -1, max: -1, …)` to pick which
 *   cards go to the bottom, and `AbstractGuiGame.many` with an unbounded
 *   `max` delegates straight to `order(…)` — so the FIRST ask Scry 2
 *   raises on the wire is `order`, confirmed against the real jar below.
 *   (`manipulateCardList` is a different Forge GUI call this host's own
 *   Preordain finding, `host.ts`'s comment, used for a reveal-the-whole-
 *   library shape — not what a plain Scry 2 raises here.)
 *
 * The method: every frame this seat's wire carries is timestamped on
 * arrival (`scenario.ts`'s own `Stamped.t`). Bob's own payment window and
 * alice's scry ask are each recorded, UNRESOLVED, the instant either shows
 * up in `s.sent` — before this test's own loop has had a chance to act on
 * anything new that tick. If BOTH are already present the first time either
 * is seen, Forge opened them without waiting for either seat's input:
 * concurrent, by construction, not by how fast this harness happens to act.
 * If only one is there, the loop resolves that one (bob's: `s.cancel`,
 * declining — Condescend still counters Grizzly Bears and still scries
 * either way; alice's: the ordinary `answerAsks()` default) and keeps
 * watching; the second showing up only AFTER that is sequential, not
 * concurrent.
 *
 * **The measured result (confirmed against the real jar, three runs):
 * sequential, not concurrent.** Bob's own payment window opens; only once
 * this test explicitly declines it (`s.cancel(1)`) does alice's `order`
 * ask reach the wire at all, ~30ms later — Forge's own resolution of
 * Condescend blocks on bob's reply before it ever computes alice's scry.
 * `match.ts`'s `openAsk` needs no cross-seat hold: there is nothing for it
 * to hold back. The operator's "showing simultaneously" is therefore a CLIENT
 * rendering artifact, not a server race — `docs/planning/wave62-evidence/
 * D/waiting.md` has the full note; lane D's fix is client-side only
 * (`match.ts`'s `closeAsk` ordering is untouched).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/w62-condescend.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, landPayer, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
  ? 'Condescend over Grizzly Bears: whether bob’s pay-or-decline and alice’s scry open at once, against real Forge'
  : `Condescend over Grizzly Bears, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
  it(
    'records the wire order of bob’s pay-or-decline window and alice’s scry ask, with timestamps',
    async () => {
      if (!available.ok) return;

      const s = await startScenario(available.config, {
        seed: 62,
        decks: DECKS,
        scenario: scenarioText('w62-condescend'),
        // Full control (set on both seats below) disables the server's own
        // "one legal choice" `getChoices` shortcut too (`match.ts`'s
        // `openAsk`: `s.fullControl ? null : onlyAnswer(...)`) — so BOTH of
        // Condescend's own `getChoices` asks reach the wire for real: the X
        // announce ("Choose X for Condescend", Forge's plain, unconstrained
        // `0..9` shape — `choose-x.jvm.test.ts`'s own finding — picked here
        // by its LABEL), and the target choice ("Select target spell"),
        // which has exactly one legal entry (Grizzly Bears, the only spell
        // on the stack) and is answered with it. Every other ask
        // (`getAbilityToPlay`, the scry `order` — see the file header)
        // keeps `answerAsks()`'s ordinary default.
        reply: (f) => {
          if (f.method !== 'getChoices') return undefined;
          const message = String(f.message ?? '');
          const choices = f.choices as { key: string; label?: string }[];
          if (/Choose X/i.test(message)) {
            const one = choices.find((c) => c.label === '1');
            return one === undefined ? undefined : [one.key];
          }
          if (/target/i.test(message)) return choices[0] === undefined ? undefined : [choices[0].key];
          return undefined;
        },
      });
      try {
        await finishMulligan(s);

        // See the file header: full control for BOTH seats, so neither
        // Grizzly Bears' nor Condescend's own casting cost auto-pays
        // (`landPayer` drives both below), and bob's own "unless its
        // controller pays {X}" stops for a real, observable decision
        // instead of auto-resolving before this test can look at it.
        expect(s.match.setFullControl(0, true).ok).toBe(true);
        expect(s.match.setFullControl(1, true).ok).toBe(true);

        // Bob casts Grizzly Bears in his own Main Phase 1.
        const bears = await waitUntil(
          () => {
            s.answerAsks();
            return s.zone(1, 'Hand').some((c) => c.name === 'Grizzly Bears');
          },
          "seat 1's hand to reflect Grizzly Bears",
          20_000,
          s,
        ).then(() => s.zone(1, 'Hand').find((c) => c.name === 'Grizzly Bears'));
        if (bears === undefined) throw new Error('no Grizzly Bears in hand');
        s.select(1, bears.id);

        const payBears = landPayer(s, 1);
        const pressedBearsPass = new Set<number>();
        await waitUntil(
          () => {
            s.answerAsks();
            payBears();
            // Full control: bob does not auto-pass once Bears is paid for —
            // he must explicitly pass priority himself before alice sees it.
            const at = s.sent
              .map((x, i) => (x.seat === 1 && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
              .filter((i) => i >= 0)
              .pop();
            if (at !== undefined && !pressedBearsPass.has(at) && /^Stack: 1 to Resolve/m.test(s.prompt(1)) && s.buttons(1)?.enable1 === true) {
              pressedBearsPass.add(at);
              s.ok(1);
            }
            return /Stack: 1 to Resolve/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
          },
          'seat 0 to be given priority with Grizzly Bears on the stack',
          30_000,
          s,
        );

        // Alice responds with Condescend, X=1.
        const condescend = s.zone(0, 'Hand').find((c) => c.name === 'Condescend');
        if (condescend === undefined) throw new Error('no Condescend in hand');
        s.select(0, condescend.id);

        const payCondescend = landPayer(s, 0);
        await waitUntil(
          () => {
            s.answerAsks();
            payCondescend();
            return /Stack: 2 to Resolve/.test(s.prompt(0));
          },
          'Condescend to reach the stack (Stack: 2 to Resolve)',
          30_000,
          s,
        );

        // Both seats pass priority (full control: neither auto-passes) so
        // the top of the stack (Condescend) resolves. `recordMarkers`
        // reads `s.sent` fresh every tick, before anything below acts on
        // what it finds — the timestamps and the presence/absence of each
        // marker are the actual measurement.
        let bobPayAt: number | null = null;
        let aliceScry: { callId: string; t: number } | null = null;
        // Plain flags, not `bobPayAt !== null`/`aliceScry !== null` — kept
        // separate on purpose. TS correlates a boolean with the nullability
        // check it was literally built from for the rest of the scope, which
        // is wrong here: `recordMarkers` (a closure, called again in every
        // branch below) keeps reassigning both.
        let bobSeen = false;
        let aliceSeen = false;

        function recordMarkers(): void {
          if (!bobSeen) {
            const hit = s.sent.find((x) => {
              if (x.seat !== 1 || x.envelope.frame.method !== 'showPromptMessage') return false;
              const message = (x.envelope.frame as unknown as { message: string }).message;
              return /Pay Mana Cost/.test(message) && /Condescend/.test(message);
            });
            if (hit !== undefined) {
              bobPayAt = hit.t;
              bobSeen = true;
            }
          }
          if (!aliceSeen) {
            const hit = s.sent.find((x) => {
              const f = x.envelope.frame as { kind?: string; method?: string; callId?: string };
              return x.seat === 0 && f.kind === 'ask' && f.method === 'order';
            });
            if (hit !== undefined) {
              aliceScry = { callId: (hit.envelope.frame as unknown as { callId: string }).callId, t: hit.t };
              aliceSeen = true;
            }
          }
        }

        const pressedStack2 = new Set<number>();
        await waitUntil(
          () => {
            recordMarkers();
            if (!bobSeen && !aliceSeen) {
              for (const seat of [0, 1]) {
                const at = s.sent
                  .map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
                  .filter((i) => i >= 0)
                  .pop();
                if (at === undefined || pressedStack2.has(at)) continue;
                const msg = s.prompt(seat);
                if (/^Stack: 2 to Resolve/m.test(msg) && s.buttons(seat)?.enable1 === true) {
                  pressedStack2.add(at);
                  s.ok(seat);
                }
              }
            }
            return bobSeen || aliceSeen;
          },
          'bob’s pay-or-decline window or alice’s scry to reach the wire',
          30_000,
          s,
        );

        // The measurement: were BOTH already on the wire the first time
        // either was seen? `recordMarkers` above never resolves anything,
        // so this reads what Forge itself did, not what this test did.
        const overlapAtFirstSight = bobSeen && aliceSeen;

        if (!overlapAtFirstSight) {
          // Sequential, so far: resolve whichever showed up, then watch for
          // the other to follow.
          if (bobSeen) {
            s.cancel(1); // decline — Condescend still counters Grizzly Bears and still scries either way
            await waitUntil(
              () => {
                recordMarkers();
                return aliceSeen;
              },
              'alice’s scry to reach the wire once bob’s payment is settled',
              20_000,
              s,
            );
          } else {
            s.answerAsks(); // answers exactly alice's scry ask — the only thing open at this point
            await waitUntil(
              () => {
                recordMarkers();
                return bobSeen;
              },
              'bob’s pay-or-decline window to reach the wire once alice’s scry is answered',
              20_000,
              s,
            );
          }
        }

        // Settle: resolve whatever is still open so the match does not hang
        // on the way to `s.stop()` — not an assertion, just cleanup.
        s.cancel(1);
        s.answerAsks();

        const fmtMs = (n: number | null): string => (n === null ? 'null' : `${n.toFixed(1)}ms`);
        const aliceScryRecord = aliceScry as { callId: string; t: number } | null;
        console.log(
          `[w62-condescend] bobPayAt=${fmtMs(bobPayAt)} aliceScryAt=${fmtMs(aliceScryRecord === null ? null : aliceScryRecord.t)} overlapAtFirstSight=${String(overlapAtFirstSight)}`,
        );

        expect(bobPayAt, 'bob (the targeted spell’s controller) was asked to pay or decline').not.toBeNull();
        expect(aliceScry, 'alice (Condescend’s own caster) was asked to scry').not.toBeNull();

        // The measured fact this item turns on ("Settled — do not
        // re-open"): Condescend's resolution opens bob's payment window
        // and alice's scry SEQUENTIALLY — Forge does not compute alice's
        // `order` ask until bob's own payment is resolved. See
        // `docs/planning/wave62-evidence/D/waiting.md` for what this meant
        // for `match.ts` (nothing: no cross-seat hold is needed there).
        expect(overlapAtFirstSight, 'Forge opens bob’s payment window and alice’s scry one at a time, never both before either is resolved').toBe(false);
      } catch (err) {
        console.log(`[w62-condescend-timeline-s0]\n${timeline(s, 0)}`);
        console.log(`[w62-condescend-timeline-s1]\n${timeline(s, 1)}`);
        throw err;
      } finally {
        await s.stop();
      }
    },
    180_000,
  );
});
