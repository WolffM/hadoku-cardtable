// @vitest-environment jsdom
/*
 * Combat, driven by DRAG, against a REAL Forge match (§C.3).
 *
 * `./prompts.jvm.test.ts` reaches combat by CLICK — `game-driver.ts` sends
 * `selectCard` on the harness's own socket, which is not a gesture and not the
 * board. The drag affordance the operator asked for ("i need like a targeter
 * arrow that helps me pick", 2026-09-24) was therefore unproven in combat: it
 * had cases in `./LiveBoard.test.ts` against the replay server, where nothing
 * downstream can disagree, and none against an engine that can refuse.
 *
 * So here an attack and a block are declared by pressing on a card, moving the
 * pointer, and releasing — on a `LiveBoard` rendered over a real Forge in a
 * child JVM — and what is asserted is
 *
 *   1. **what went on the wire**: every `forge:c2s` frame the BOARD sent, taken
 *      at the transport seam, matched against the exact `selectCard` act each
 *      gesture should have produced and nothing else; and
 *   2. **that Forge agreed**: the dragged attacker comes back `attacking` and
 *      the dragged blocker comes back `blocking`, in each seat's own folded
 *      view — Forge's verdict on the gesture, not ours.
 *
 * ## The two gestures, and why they are the ones they are
 *
 * Forge decides what is draggable, through `setWeaklySelectable`, and in combat
 * it is not the same set as at priority:
 *
 *   - declaring attackers, `InputAttack.updateMessage` →
 *     `PlayerControllerHuman.pushAttackerCandidates` — MY undeclared legal
 *     attackers, and nothing of the defender's;
 *   - declaring blockers, `InputBlock.showMessage` → `pushBlockerCandidates` —
 *     MY creatures that could block a live attacker, and again nothing of the
 *     attacker's.
 *
 * So neither the attacking creature nor (until wave 46 §B's X1 fix, below) the
 * defending player was ever an offered drop TARGET in combat for the BLOCK
 * gesture, which still goes through the zone drop: a card Forge offers,
 * released anywhere inside a zone, is the card being used — one `selectCard`,
 * the same frame its own face would send. That makes
 *
 *   - **block**: drag the blocker onto the attacker it means to stop (the
 *     zone drop; `InputBlock` has already auto-selected the attacker being
 *     blocked, which is why this reads as "onto that attacker" and lands
 *     correctly with one frame).
 *
 * **Attack is different, since wave 46 §B's X1 fix.** `match.ts`'s
 * `attackDefenders` now offers the opponent's planeswalkers/battles as card
 * targets AND `boardInteraction` offers every opponent PLAYER while attackers
 * are being declared, so a face IS now a legal drop target in combat —
 * `commitDrag`'s `attackAssignment` branch fires, defender first: dragging
 * the attacker straight onto the defending player's face sends `selectPlayer`
 * then `selectCard`, TWO frames for the one gesture, and the attack is fully
 * declared right there. This is the fix for the product gap this file used to
 * record as unworked-around (*"dragging an attacker onto the defending
 * PLAYER's face sends nothing"*) — see the case at the end, which now asserts
 * the two frames instead of the old silence.
 *
 * ## Setup is not the subject
 *
 * Getting to combat needs lands kept, priority passed and creatures cast. Those
 * go through the harness's own act channel (`SeatClient.act`), exactly as
 * `game-driver.ts` does, and they are deliberately NOT visible in the wire this
 * test asserts on: `s.act` emits on the harness's transport closure, while the
 * board emits through `match.transport`, which is the object tapped below. So
 * everything in `wire` came from a gesture, and nothing else could have put it
 * there.
 *
 * ## This suite PINS `EVERY_PRIORITY_POLICY`, and here is why that is honest
 *
 * Wave 28 §B made `ARENA_STOP_POLICY` the server's default: a seat now stops in
 * MAIN1, MAIN2 and declare-attackers on its own turn, in declare-blockers and the
 * end step on the opponent's, and **every other phase is passed whether or not
 * Forge named anything the seat could do there**. That is the right default and
 * the operator asked for it — *"it's stopping everywhere, super annoying"*.
 *
 * It also turned a latent race in this file's driver into a routine one, which
 * lane B measured rather than guessed
 * (`docs/planning/wave28-evidence/B-tests-A-must-reaim.md`): with the change,
 * exit 1; with the three changed fields reverted in place, exit 0. The mechanism
 * is one line of the harness — `jvm-harness.ts:158-165` bumps `notes.version` on
 * an `updateButtons` arriving ALONE, so a driver that keys on the version and
 * then reads `notes.prompt` acts on the previous window with a live button. Under
 * the old default the server auto-passed only windows Forge itself called empty,
 * so the bursts were rare; under `'always'` a whole sequence of phases is passed
 * at once and the stale read is hit on nearly every turn.
 *
 * **This suite does not test the stop set.** It exists to prove that an attack
 * and a block can be declared BY DRAGGING, and that Forge agrees. The stop set is
 * asserted directly, and now in several places, by `apps/server/src/play/auto.test.ts`
 * and `auto.jvm.test.ts`. So the seats here are pinned to
 * {@link EVERY_PRIORITY_POLICY} — the stop behaviour that WAS the default until
 * 2026-09-28 — which restores the timing this driver was written in and changes
 * nothing about the gesture under test.
 *
 * `./board-play.jvm.test.ts:217` is the precedent, and the same kind of reason:
 * it pins `STRICT_PAYMENT_POLICY` because it is about payments and not about what
 * the default does with them. Pinning is only honest written down, which is what
 * this section is: **the product's real default is exercised, by the suites that
 * are about it.**
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, like the
 * server's `jvm.test.ts`.
 */

import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClientFrame } from '@hadoku/forge-wire';

import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import { EVERY_PRIORITY_POLICY } from '../../../../server/src/play/auto.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness, type SeatClient } from './jvm-harness.ts';
import { LiveBoard } from './LiveBoard.tsx';
import { boardInteraction, currentAsk } from './match.ts';
import { answerOpenPrompt } from './prompt-driver.ts';
import { MATCH_EVENTS } from './transport.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'an attack and a block, declared by dragging on a real Forge match'
  : `an attack and a block, declared by dragging on a real Forge match — SKIPPED: ${available.reason}`;

/**
 * Thirty lands and thirty Memnites. Memnite costs nothing, so both seats have
 * creatures from their first main phase without a mana cost being paid, a
 * payment prompt being answered or a target being chosen — combat is the only
 * thing this game does. Both decks are the same on purpose: nothing here is
 * about hidden information (`./prompts.jvm.test.ts` and the server's
 * `jvm.test.ts` carry the leak oracle), and a symmetric game reaches an attack
 * and a block whichever seat wins the toss.
 */
function deck(name: string): string {
  return `[metadata]\nName=${name}\n[main]\n30 Volcanic Island\n30 Memnite\n`;
}

type Act = Extract<ClientFrame, { kind: 'act' }>;

const cardAct = (id: number): Act => ({
  kind: 'act',
  method: 'selectCard',
  card: { kind: 'card', id },
  otherCardViewsToSelect: [],
  triggerEvent: null,
});

const playerAct = (id: number): Act => ({
  kind: 'act',
  method: 'selectPlayer',
  player: { kind: 'player', id },
  triggerEvent: null,
});

/** What one seat's BOARD put on `forge:c2s`, in order. */
interface Wire {
  frames: ClientFrame[];
}

/**
 * Tap the handle's transport, so every frame the board sends is recorded with
 * the bytes it sent.
 *
 * `startMatch` registered its inbound handlers on the transport it was given
 * and holds it on `match.transport` for sending; replacing that property after
 * the fact therefore intercepts the outbound half and disturbs nothing else.
 * The harness's own `act()` closes over the original object, so setup acts do
 * not appear here — which is exactly the property this test needs.
 */
function tapWire(s: SeatClient): Wire {
  const wire: Wire = { frames: [] };
  const inner = s.live.transport;
  s.live.transport = {
    ...inner,
    emit: (event, payload) => {
      if (event === MATCH_EVENTS.clientToServer) {
        wire.frames.push((payload as { frame: ClientFrame }).frame);
      }
      inner.emit(event, payload);
    },
  };
  return wire;
}

/**
 * A real drag on the rendered board: press on `from`, move the pointer past
 * `DRAG_SLOP_PX`, and release over `onto`.
 *
 * Nothing here touches `selectCard`, `commitDrag` or the transport. It presses,
 * moves and releases, and `LiveBoard`'s own window listeners do the rest — the
 * same three events a browser delivers. The coordinates only have to clear the
 * slop: jsdom gives every box zeroes, so they are not geometry and nothing here
 * asserts any (`e2e/arrow.spec.ts` is where the geometry is measured, in a
 * browser that has boxes).
 */
function drag(from: HTMLElement, onto: HTMLElement): void {
  fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(onto, { clientX: 140, clientY: 110 });
  fireEvent.pointerUp(onto, { clientX: 140, clientY: 110 });
}

const cardEl = (root: HTMLElement, id: number): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-board-card="${id}"]`);

/** The zone element a drop lands in. `[data-zone]` is `Board.tsx`'s own name. */
function zoneEl(root: HTMLElement, mine: boolean, zone: string): HTMLElement | null {
  const seat = root.querySelector<HTMLElement>(mine ? '.seat[data-viewer]' : '.seat:not([data-viewer])');
  return seat?.querySelector<HTMLElement>(`[data-zone="${zone}"]`) ?? null;
}

/**
 * Forge's button one as the page draws it (wave 51): the control box's Next
 * Phase at the empty-stack priority pass, the decision pop-up's own OK for
 * every other input (declaring done, priority with spells on the stack).
 */
function okButton(root: HTMLElement): HTMLButtonElement | null {
  const nextPhase = root.querySelector<HTMLButtonElement>('[data-testid="live-button-next-phase"]');
  if (nextPhase !== null && !nextPhase.disabled) return nextPhase;
  return root.querySelector<HTMLButtonElement>('[data-testid="live-decision-ok"]');
}

/** Press the board's own OK. Never the harness's act channel — the page is the product. */
function pressOk(root: HTMLElement): boolean {
  const ok = okButton(root);
  if (ok === null || ok.disabled) return false;
  fireEvent.click(ok);
  return true;
}

interface Driven {
  /** `[seat, attackerId]` for every attack declared by a drag. */
  attacks: [number, number][];
  /** `[seat, blockerId, attackerId]` for every block declared by a drag. */
  blocks: [number, number, number][];
  /** A drag of an attacker onto the defending player's FACE, and what it sent. */
  faceDrags: { seat: number; attacker: number; defender: number; sentBefore: number; alreadyCurrent: boolean }[];
  log: string[];
}

describe.skipIf(!available.ok)(title, () => {
  const running: LiveHarness[] = [];

  afterAll(async () => {
    cleanup();
    for (const h of running) h.stop();
    await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
    expect(liveJvmCount()).toBe(0);
  }, 60_000);

  it(
    'an attack and a block go on the wire as one selectCard each, and Forge puts both creatures in combat',
    async () => {
      const h = await startLiveMatch({
        seed: 7,
        seats: [
          { name: 'A', ai: false, deck: deck('Drag A') },
          { name: 'B', ai: false, deck: deck('Drag B') },
        ],
      });
      running.push(h);
      /*
       * The stop policy this driver was written in — see "This suite PINS
       * `EVERY_PRIORITY_POLICY`" above. Set before a single frame is clicked on,
       * so no window in the run is timed by the wave-28 default.
       */
      for (const s of h.seats) expect(h.match.setStopPolicy(s.seat, EVERY_PRIORITY_POLICY)).toEqual({ ok: true });
      const wires: [Wire, Wire] = [tapWire(h.seats[0]), tapWire(h.seats[1])];

      const mount = (s: SeatClient): HTMLElement => {
        const root = document.createElement('div');
        root.dataset.seat = String(s.seat);
        document.body.appendChild(root);
        render(createElement(LiveBoard, { match: s.live }), { container: root });
        return root;
      };
      const roots: [HTMLElement, HTMLElement] = [mount(h.seats[0]), mount(h.seats[1])];

      const driven: Driven = { attacks: [], blocks: [], faceDrags: [], log: [] };
      /*
       * Which seats' boards HAVE SEEN Forge put a dragged creature in combat.
       * Recorded as it happens, not read back at the end: combat is a step, not
       * a resting state, and by the time the game has moved on the boards are
       * right to have forgotten it. Sampling every tick is what makes "both
       * boards agreed" assertable at all.
       */
      const sawAttacking = new Set<number>();
      const sawBlocking = new Set<number>();
      function scan(): void {
        const inCombat = (seat: number, id: number, how: 'attacking' | 'blocking'): boolean =>
          h.seats[seat]!.live.view?.players.some((p) => p.battlefield.some((c) => c.id === id && c[how])) === true;
        for (const s of h.seats) {
          for (const [, id] of driven.attacks) if (inCombat(s.seat, id, 'attacking')) sawAttacking.add(s.seat);
          for (const [, id] of driven.blocks) if (inCombat(s.seat, id, 'blocking')) sawBlocking.add(s.seat);
        }
      }

      const seen = [0, 0];
      const idleSince = [Date.now(), Date.now()];
      const once = [new Set<string>(), new Set<string>()];
      /** Cards already offered to a given selection, so a min of 2 is answered with two. */
      const picked = new Map<string, number[]>();
      const IDLE_MS = 3000;

      /** A card of mine the board is offering right now, by Forge's own set. */
      function offeredOnMyBattlefield(s: SeatClient, me: BoardPlayer, skip: (c: BoardCard) => boolean): BoardCard | null {
        const offered = boardInteraction(s.live).selectable;
        return me.battlefield.find((c) => offered.has(c.id) && !skip(c)) ?? null;
      }

      function step(): void {
        for (const s of h.seats) {
          const root = roots[s.seat]!;
          if (currentAsk(s.live) !== null) {
            const answered = answerOpenPrompt(root);
            if (answered !== null) driven.log.push(`seat ${s.seat} answered ${answered}`);
            idleSince[s.seat] = Date.now();
            continue;
          }
          const v: BoardView | null = s.live.view;
          if (v === null) continue;
          const me = v.players.find((p) => p.isViewer);
          const opp = v.players.find((p) => !p.isViewer);
          if (me === undefined || opp === undefined) continue;
          const msg = s.notes.prompt?.message ?? '';
          if (/^Waiting/.test(msg)) continue;
          if (s.notes.version === seen[s.seat]) {
            // Nothing new: an act that changed nothing. Press OK rather than hang.
            if (Date.now() - idleSince[s.seat]! > IDLE_MS && s.notes.buttons?.enable1 === true) {
              idleSince[s.seat] = Date.now();
              if (!pressOk(root)) s.act({ kind: 'act', method: 'selectButtonOk' });
              driven.log.push(`seat ${s.seat} idle -> OK`);
            }
            continue;
          }
          seen[s.seat] = s.notes.version;
          idleSince[s.seat] = Date.now();
          /*
           * Forge's own prompt message, not the board's `view.phase`, is what
           * the decisions below read. Measured: a seat's projected view can lag
           * its prompt by a whole step (in one run seat 1 was shown "Phase:
           * Main phase, postcombat" while its view still said COMBAT_END), so a
           * driver keyed on `view.phase` silently never acted for that seat and
           * the game went nowhere. The message is the seat's own instruction; it
           * cannot disagree with itself.
           */
          const mainPhase = /Phase: Main phase, precombat/.test(msg);
          const stackEmpty = /Stack: Empty/.test(msg);
          const myTurn = new RegExp(`Turn: \\d+ \\(${me.name}\\)`).test(msg);
          driven.log.push(
            `seat ${s.seat} t${v.turn} ${v.phase ?? '-'}${myTurn ? ' MINE' : ''} ok=${String(s.notes.buttons?.enable1 === true)} ` +
              `offered=${boardInteraction(s.live).selectable.size} field=${me.battlefield.length} hand=${me.hand?.length ?? -1} msg=${JSON.stringify(msg.slice(0, 120))}`,
          );
          const mine = once[s.seat]!;
          const first = (key: string): boolean => (mine.has(key) ? false : (mine.add(key), true));

          /* ── declare attackers, by drag ── */
          // `showPromptMessage` is per seat: a seat only sees "select creatures
          // to attack" when it is the one declaring, so the message is the whole
          // test — no need to work out whose turn it is. With the bar live: the
          // input's last refresh stays the latest prompt through the combat steps
          // the server passes for the seat, with its bar dead.
          if (/to attack/.test(msg) && s.notes.buttons?.enable1 === true) {
            const attacker = offeredOnMyBattlefield(s, me, (c) => c.summoningSick || c.tapped || c.attacking);
            const face = root.querySelector<HTMLElement>(`[data-player-face][data-player-id="${opp.id}"]`);
            const theirField = zoneEl(root, false, 'battlefield');
            const el = attacker === null ? null : cardEl(root, attacker.id);
            if (attacker !== null && el !== null && (face !== null || theirField !== null) && first(`attack-t${v.turn}`)) {
              if (face !== null) {
                /*
                 * X1/W14 (wave 46 §B): the gesture a person reaches for first —
                 * the creature straight onto the player it is attacking — now
                 * DECLARES the attack by itself. `match.ts`'s `attackDefenders`
                 * offers the opponent's own planeswalkers/battles and
                 * `boardInteraction` offers every opponent player while
                 * attackers are being declared, so `commitDrag`'s
                 * `attackAssignment` branch fires: defender first
                 * (`selectPlayer`), then the attacker (`selectCard`) once Forge
                 * has marked that player its current defender (`afterMarked`:
                 * Forge may apply two quick clicks in either order). When the
                 * player is ALREADY the marked defender — `InputAttack` starts
                 * on the first one — the attacker's click is the whole gesture.
                 */
                const sentBefore = wires[s.seat]!.frames.length;
                const alreadyCurrent = s.live.highlightedPlayers?.has(opp.id) === true;
                drag(el, face);
                driven.faceDrags.push({ seat: s.seat, attacker: attacker.id, defender: opp.id, sentBefore, alreadyCurrent });
                driven.attacks.push([s.seat, attacker.id]);
                driven.log.push(`seat ${s.seat} t${v.turn} DRAGS ${attacker.card.name} ${attacker.id} onto the defender's face to attack`);
                continue;
              }
              // No face element on screen (should not happen): the zone drop
              // still works, the same "a card Forge offers, released anywhere
              // inside a zone, is the card being used" rule blocking uses.
              drag(el, theirField!);
              driven.attacks.push([s.seat, attacker.id]);
              driven.log.push(`seat ${s.seat} t${v.turn} DRAGS ${attacker.card.name} ${attacker.id} to attack (zone drop)`);
              continue;
            }
            if (!pressOk(root)) s.act({ kind: 'act', method: 'selectButtonOk' });
            driven.log.push(`seat ${s.seat} t${v.turn} attackers done`);
            continue;
          }

          /* ── declare blockers, by drag ── */
          if (/to block/.test(msg) && s.notes.buttons?.enable1 === true) {
            const attacker = opp.battlefield.find((c) => c.attacking);
            const blocker = offeredOnMyBattlefield(s, me, (c) => c.tapped || c.blocking);
            const blockerElement = blocker === null ? null : cardEl(root, blocker.id);
            const attackerElement = attacker === undefined ? null : cardEl(root, attacker.id);
            if (
              attacker !== undefined &&
              blocker !== null &&
              blockerElement !== null &&
              attackerElement !== null &&
              first(`block-t${v.turn}`)
            ) {
              // Onto the attacker it means to stop. `InputBlock` has already
              // made that attacker the current one, so one frame is the whole
              // declaration.
              drag(blockerElement, attackerElement);
              driven.blocks.push([s.seat, blocker.id, attacker.id]);
              driven.log.push(`seat ${s.seat} t${v.turn} DRAGS ${blocker.card.name} ${blocker.id} onto attacker ${attacker.id}`);
              continue;
            }
            if (!pressOk(root)) s.act({ kind: 'act', method: 'selectButtonOk' });
            driven.log.push(`seat ${s.seat} t${v.turn} blockers done`);
            continue;
          }

          /* ── setup: a land, a free creature, then pass ── */
          if (msg.startsWith('Priority')) {
            if (myTurn && mainPhase && stackEmpty) {
              const land = me.hand?.find((c) => c.card.name === 'Volcanic Island');
              if (land !== undefined && first(`land-t${v.turn}`)) {
                s.act({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: land.id }, otherCardViewsToSelect: [], triggerEvent: null });
                continue;
              }
              const memnite = me.hand?.find((c) => c.card.name === 'Memnite');
              if (memnite !== undefined && first(`memnite-${memnite.id}`)) {
                s.act({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: memnite.id }, otherCardViewsToSelect: [], triggerEvent: null });
                continue;
              }
            }
            if (!pressOk(root)) s.act({ kind: 'act', method: 'selectButtonOk' });
            continue;
          }
          /*
           * Anything else Forge wants a set of cards for — the cleanup discard
           * is the one this game always reaches. Raw acts, like the rest of the
           * setup: a selection is not what this test is about, and leaving it
           * unanswered stalls the game with OK disabled.
           */
          const sel = s.notes.selectables;
          if (sel !== null && sel.cards.length > 0 && sel.min > 0) {
            const key = `${s.seat}:t${v.turn}:${msg}`;
            const already = picked.get(key) ?? [];
            const next = sel.cards.find((c) => !already.includes(c.id));
            if (already.length < sel.min && next !== undefined) {
              picked.set(key, [...already, next.id]);
              s.act({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: next.id }, otherCardViewsToSelect: [], triggerEvent: null });
              driven.log.push(`seat ${s.seat} chooses ${next.id} (${already.length + 1}/${sel.min})`);
              continue;
            }
          }
          if (s.notes.buttons?.enable1 === true) {
            if (!pressOk(root)) s.act({ kind: 'act', method: 'selectButtonOk' });
            driven.log.push(`seat ${s.seat} fell through to OK`);
          }
        }
      }

      /* ── drive until one attack and one block have been dragged, and Forge has ruled on both ── */
      const done = (): boolean => sawAttacking.size === 2 && driven.blocks.some(([seat]) => sawBlocking.has(seat));
      const deadline = Date.now() + 240_000;
      let ticks = 0;
      while (!done()) {
        if (Date.now() > deadline) {
          throw new Error(
            `combat was never driven by drag: ${driven.attacks.length} attack drags, ${driven.blocks.length} block drags, ` +
              `attacking seen by [${[...sawAttacking].join(',')}], blocking seen by [${[...sawBlocking].join(',')}]\n` +
              driven.log.slice(-60).join('\n'),
          );
        }
        // Sample twice per tick, around the step: combat is short-lived and a
        // board that held it only between two steps still held it.
        scan();
        if (ticks % 3 === 0) step();
        scan();
        ticks += 1;
        await new Promise((r) => setTimeout(r, 40));
      }

      console.log(`[combat-drag] ${driven.log.slice(-80).join('\n[combat-drag] ')}`);

      /* ── 1. what went on the wire ── */
      /*
       * Everything in `wires` came from the BOARD (see the header). Four things
       * can put something there, and the drag is two of them:
       *
       *   - a prompt component's answer — kind `reply` (or `abort`);
       *   - the board's own OK button — `selectButtonOk`;
       *   - a drag — `selectCard`, always, one per committed drag;
       *   - a drag onto the defending player's FACE (X1/W14) ALSO —
       *     `selectPlayer`, defender first, one per face-drag.
       *
       * So no frame is of any other shape, every `selectCard` names a card that
       * was DRAGGED, every `selectPlayer` names a defender some face-drag
       * actually used, and — the tight one — the number of `selectCard`s a seat
       * sent equals the number of drags it committed (a face-drag is still
       * exactly one `selectCard`, for the attacker; the `selectPlayer` is the
       * EXTRA frame that gesture sends, not a substitute). A gesture that sent
       * the source AND the drop, one that sent a card nobody picked up, or a
       * stray click that reached `selectCard` by another route all break that
       * count.
       */
      const dragged = new Set([...driven.attacks.map(([, id]) => id), ...driven.blocks.map(([, id]) => id)]);
      const defended = new Set(driven.faceDrags.map((t) => t.defender));
      expect(dragged.size).toBeGreaterThanOrEqual(2);
      for (const [seat, wire] of wires.entries()) {
        expect(wire.frames.length, `seat ${seat} sent something from the board`).toBeGreaterThan(0);
        for (const frame of wire.frames) {
          const where = `seat ${seat}: ${JSON.stringify(frame)}`;
          if (frame.kind !== 'act') {
            expect(['reply', 'abort'], where).toContain(frame.kind);
            continue;
          }
          expect(['selectCard', 'selectPlayer', 'selectButtonOk'], where).toContain(frame.method);
          if (frame.method === 'selectPlayer') {
            expect(frame, where).toEqual(playerAct(frame.player.id));
            expect(defended, `${where} — no face-drag targeted that player`).toContain(frame.player.id);
            continue;
          }
          if (frame.method !== 'selectCard') continue;
          // The whole frame, field for field: `otherCardViewsToSelect` empty and
          // `triggerEvent` null are what make a multi-ability card come back as
          // a `getAbilityToPlay` ask rather than firing one at random.
          expect(frame, where).toEqual(cardAct(frame.card.id));
          expect(dragged, `${where} — nothing dragged that card`).toContain(frame.card.id);
        }
        const picks = wire.frames.filter((f) => f.kind === 'act' && f.method === 'selectCard');
        const playerPicks = wire.frames.filter((f) => f.kind === 'act' && f.method === 'selectPlayer');
        const gestures =
          driven.attacks.filter(([s]) => s === seat).length + driven.blocks.filter(([s]) => s === seat).length;
        const faceDragsForSeat = driven.faceDrags.filter((t) => t.seat === seat && !t.alreadyCurrent).length;
        expect(gestures, `seat ${seat} dragged something`).toBeGreaterThan(0);
        expect(picks.length, `seat ${seat}: exactly one selectCard per committed drag`).toBe(gestures);
        expect(playerPicks.length, `seat ${seat}: one selectPlayer per face-drag whose defender was not already current, and only from those`).toBe(faceDragsForSeat);
      }
      // And the attack and the block are in it, byte for byte.
      const [attackSeat, attackerId] = driven.attacks[0]!;
      const [blockSeat, blockerId] = driven.blocks[0]!;
      expect(wires[attackSeat]!.frames).toContainEqual(cardAct(attackerId));
      expect(wires[blockSeat]!.frames).toContainEqual(cardAct(blockerId));
      // Not "exactly one frame naming this card": a creature that attacked on
      // one turn blocks on another, and both gestures send the same bytes. One
      // frame PER GESTURE is the claim, and the per-seat count above is it.

      /* ── 2. Forge agreed, and BOTH boards drew the same combat ── */
      // The attacker: seen attacking by the seat that dragged it AND by the seat
      // it is attacking, so this is the game's state and not one client's guess.
      expect([...sawAttacking].sort(), `both boards drew attacker ${attackerId} in combat`).toEqual([0, 1]);
      // The blocker: seen blocking by the seat that dragged it.
      expect(sawBlocking.has(blockSeat), `seat ${blockSeat}'s board drew blocker ${blockerId} in combat`).toBe(true);

      /* ── 3. nothing the board sent was refused ── */
      expect(h.refused).toEqual([]);
      expect(h.match.invalidFrames).toBe(0);

      /* ── 4. X1/W14: the gap is fixed, and this is the proof ── */
      // An attacker dragged onto the defending player's FACE now declares the
      // attack by itself — the natural combat gesture this file used to
      // record as inert. In order, byte for byte: `selectPlayer` (the defender)
      // then `selectCard` (the attacker), or the attacker alone when that
      // player was already Forge's marked defender. The attacker's frame can
      // follow the drag by a moment (it waits for Forge's mark), so it is read
      // from the whole wire, up to and including that attacker's frame.
      expect(driven.faceDrags.length, 'the face drag was tried at all').toBeGreaterThan(0);
      for (const t of driven.faceDrags) {
        const after = wires[t.seat]!.frames.slice(t.sentBefore);
        const upTo = after.findIndex((f) => f.kind === 'act' && f.method === 'selectCard' && f.card.id === t.attacker);
        expect(upTo, `seat ${t.seat}'s face-drag sent the attacker ${t.attacker}`).toBeGreaterThanOrEqual(0);
        const sent = after.slice(0, upTo + 1);
        const expected = t.alreadyCurrent ? [cardAct(t.attacker)] : [playerAct(t.defender), cardAct(t.attacker)];
        expect(sent, `seat ${t.seat}'s face-drag (defender already current: ${t.alreadyCurrent})`).toEqual(expected);
      }
    },
    300_000,
  );
});
