// @vitest-environment jsdom
/*
 * A land played and spells cast by CLICKING THE BOARD, against a real Forge
 * match in a real child JVM.
 *
 * Two seats (`./jvm-harness.ts`), each a `LiveBoard` rendered into its own
 * container. Every action here is a DOM click on what the product draws: a
 * card's own button (`[data-board-card] button`, which `Board` renders only
 * for a card `boardInteraction` offers), a seat's button, or the button bar.
 * Nothing is sent through the harness's `act`, `game-driver.ts` or
 * `e2e/play/hands.ts`, so what reaches Forge is exactly what the product
 * sends. Blocking asks are answered by `answerOpenPrompt`, which also only
 * clicks.
 *
 * The plan, for whichever seat takes turn 1 (the actor):
 *
 *  1. Turn 1: click a Mountain in hand (Forge's `InputPassPriority` plays
 *     it), click Raging Goblin, pay by clicking the Mountain now on the
 *     battlefield (`InputPayMana`). The actor never presses a button in this
 *     main phase, so only the land click can have paid.
 *  2. Then the card Forge's input IGNORES — a second land the same turn. There
 *     is no longer a button to click: Forge names what is actionable through
 *     `setWeaklySelectable` and a second land is not in it, so `Board` draws
 *     the card inert. This step checks the whole equivalence, card for card —
 *     a face exists exactly where Forge named the card and nowhere else — and
 *     it is the proof against the real jar that the frame crosses at all.
 *  3. The actor's next turn: a land, then Shock. Forge's `InputSelectTargets`
 *     sends `setSelectables` — its own list, with min and max — and the actor
 *     clicks the OPPONENT'S SEAT (`selectPlayer`), then pays with a land.
 *
 * Done when each is visible on the actor's own folded board: the Mountain on
 * the battlefield, the Goblin on the stack or resolved, Shock on the stack or
 * in the graveyard with the opponent at 18.
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

import type { BoardCard, BoardPlayer } from '../adapter.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness, type SeatClient } from './jvm-harness.ts';
import { LiveBoard } from './LiveBoard.tsx';
import { currentAsk, type LiveSelectables } from './match.ts';
import { answerOpenPrompt } from './prompt-driver.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'playing by clicking the board, against a real Forge match'
  : `playing by clicking the board, against a real Forge match — SKIPPED: ${available.reason}`;
if (!available.ok) console.warn(`[board-play.jvm] SKIPPED — no Forge build: ${available.reason}`);

function deck(name: string): string {
  return `[metadata]\nName=${name}\n[main]\n24 Mountain\n18 Raging Goblin\n18 Shock\n`;
}

const named = (name: string) => (c: BoardCard) => c.card.name === name;
const isMountain = named('Mountain');

/** The clickable face of a card on this seat's board, or null when Board drew it inert. */
function cardButton(root: HTMLElement, id: number): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-board-card="${id}"] button`);
}

/** A seat's clickable name, or null when Board drew it inert. */
function seatButton(root: HTMLElement, playerId: number): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-testid="player"][data-player-id="${playerId}"] button`);
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
    'a player plays a land and casts spells — one targeted — by clicking their own board',
    async () => {
      const started = Date.now();
      const h = await startLiveMatch({
        seed: 11,
        seats: [
          { name: 'A', ai: false, deck: deck('Red A') },
          { name: 'B', ai: false, deck: deck('Red B') },
        ],
      });
      running.push(h);

      const roots = h.seats.map((s) => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        render(createElement(LiveBoard, { match: s.live }), { container: root });
        return root;
      });
      const log: string[] = [];
      const me = (s: SeatClient): BoardPlayer => s.live.view!.players.find((p) => p.isViewer)!;
      const opponent = (s: SeatClient): BoardPlayer => s.live.view!.players.find((p) => !p.isViewer)!;

      let actor: SeatClient | null = null;
      let firstTurn = 0;
      const clicked = {
        land: null as number | null,
        goblin: null as number | null,
        landPaid: false,
        land2: null as number | null,
        shock: null as number | null,
        targeted: false,
        shockPaid: false,
      };
      let targeting: LiveSelectables | null = null;

      const click = (el: HTMLButtonElement, what: string, s: SeatClient) => {
        log.push(`seat ${s.seat} t${s.live.view!.turn} clicks ${what}`);
        fireEvent.click(el);
      };

      /** Click a card of this name in hand, if Board offers it. */
      function fromHand(s: SeatClient, name: string): number | null {
        const card = me(s).hand?.find(named(name));
        const button = card === undefined ? null : cardButton(roots[s.seat]!, card.id);
        if (card === undefined || button === null) return null;
        click(button, `${name} ${card.id} in hand`, s);
        return card.id;
      }

      /** Pay by clicking an untapped Mountain on the battlefield. */
      function payWithLand(s: SeatClient): boolean {
        const land = me(s).battlefield.find((c) => isMountain(c) && !c.tapped);
        const button = land === undefined ? null : cardButton(roots[s.seat]!, land.id);
        if (land === undefined || button === null) return false;
        click(button, `Mountain ${land.id} on the battlefield to pay: ${JSON.stringify(s.live.prompt)}`, s);
        return true;
      }

      const phase1Done = (): boolean => {
        if (actor === null || clicked.goblin === null) return false;
        const p = me(actor);
        const onStack = actor.live.view!.stack.some((i) => i.sourceCardId === clicked.goblin);
        return p.battlefield.some((c) => c.id === clicked.land) && (onStack || p.battlefield.some((c) => c.id === clicked.goblin));
      };
      let phase1Checked = false;
      const phase2Done = (): boolean => {
        if (actor === null || clicked.shock === null || !clicked.targeted) return false;
        const v = actor.live.view!;
        const onStack = v.stack.some((i) => i.sourceCardId === clicked.shock);
        const resolved = me(actor).graveyard.some((c) => c.id === clicked.shock) && opponent(actor).life === 18;
        return onStack || resolved;
      };

      /** One tick for one seat: answer, act by clicking, or press OK. At most one click. */
      function step(s: SeatClient): void {
        const root = roots[s.seat]!;
        if (currentAsk(s.live) !== null) {
          log.push(`seat ${s.seat} answers ${answerOpenPrompt(root) ?? 'nothing'}`);
          return;
        }
        const v = s.live.view;
        if (v === null || !s.live.inputLive) return;
        const p = me(s);
        const myMain = v.turn >= 1 && v.activePlayerId === p.id && v.phase === 'MAIN1';
        if (myMain && actor === null) {
          actor = s;
          firstTurn = v.turn;
        }
        if (s === actor && myMain && v.turn === firstTurn && !phase1Done()) {
          if (clicked.land === null) clicked.land = fromHand(s, 'Mountain');
          else if (!p.battlefield.some((c) => c.id === clicked.land)) return;
          else if (clicked.goblin === null) clicked.goblin = fromHand(s, 'Raging Goblin');
          // Pay only once Forge has answered the Goblin click (its mana input), never into the priority input.
          else if (!clicked.landPaid && !s.live.spent.cards.has(clicked.goblin)) clicked.landPaid = payWithLand(s);
          return;
        }
        if (s === actor && myMain && v.turn > firstTurn && phase1Checked && !phase2Done()) {
          if (clicked.land2 === null) clicked.land2 = fromHand(s, 'Mountain');
          else if (!p.battlefield.some((c) => c.id === clicked.land2)) return;
          else if (clicked.shock === null) clicked.shock = fromHand(s, 'Shock');
          else if (!clicked.targeted) {
            // Forge's own list of what Shock may target, as it arrived.
            if (s.live.selectables === null) return;
            targeting = s.live.selectables;
            const target = seatButton(root, opponent(s).id);
            if (target === null) return;
            click(target, `the opponent's seat (player ${opponent(s).id}) as Shock's target`, s);
            clicked.targeted = true;
          } else if (!clicked.shockPaid && s.live.selectables === null) clicked.shockPaid = payWithLand(s);
          return;
        }
        // Forge wants cards picked (the cleanup discard): pick the first it offers.
        const sel = s.live.selectables;
        const ok = root.querySelector<HTMLButtonElement>('[data-testid="live-button-ok"]');
        if (sel !== null && ok?.disabled === true) {
          const pick = [...sel.cards].map((id) => cardButton(root, id)).find((b) => b !== null);
          if (pick !== undefined && pick !== null) click(pick, `a card Forge offered (${sel.min}..${sel.max})`, s);
          return;
        }
        if (ok !== null && !ok.disabled) {
          log.push(`seat ${s.seat} t${v.turn} ${v.phase ?? '-'} presses ${ok.textContent ?? ''}`);
          fireEvent.click(ok);
        }
      }

      async function drive(until: () => boolean, label: string): Promise<void> {
        const deadline = Date.now() + 120_000;
        while (!until()) {
          if (Date.now() > deadline) {
            throw new Error(`${label}: not done in 120 s\n${log.slice(-40).join('\n')}\nrefused: ${JSON.stringify(h.refused)}`);
          }
          for (const s of h.seats) step(s);
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      // 1. A land and a spell, turn 1.
      await drive(phase1Done, 'a land and Raging Goblin by clicking');
      const a = actor! as SeatClient;
      const mountain = me(a).battlefield.find((c) => c.id === clicked.land);
      expect(mountain?.card.name).toBe('Mountain');
      // No button was pressed in this main phase, so only the click on the land paid.
      expect(clicked.landPaid).toBe(true);
      expect(mountain?.tapped).toBe(true);
      const goblinResolved = me(a).battlefield.some((c) => c.id === clicked.goblin);
      console.log(
        `[board-play.jvm] seat ${a.seat} turn ${firstTurn}: Mountain ${clicked.land} played, Raging Goblin ${clicked.goblin} ` +
          `${goblinResolved ? 'resolved' : 'on the stack'}, paid by clicking the land — ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );

      // 2. The card Forge's input ignores is drawn inert — nothing to click.
      //
      // `setWeaklySelectable` is the frame that makes this possible, so first
      // prove it crossed: against the real jar, for this seat, at least once.
      await waitUntil(
        () => a.live.inputLive && currentAsk(a.live) === null && a.live.weaklySelectable !== null && a.live.spent.cards.size === 0,
        'the actor to hold priority again with Forge’s actionable set',
        15_000,
      );
      const weaklyFrames = h.emitted.filter(
        (e) => e.seat === a.seat && (e.envelope.frame as { method?: unknown }).method === 'setWeaklySelectable',
      );
      expect(weaklyFrames.length, 'Forge must publish its actionable set to this seat').toBeGreaterThan(0);

      const offeredNow = a.live.weaklySelectable!;
      const second = me(a).hand?.find(isMountain);
      expect(second).toBeDefined();
      // A second land in one turn: Forge does not name it, so it is not drawn
      // as a button — the click that used to go nowhere cannot be made.
      expect([...offeredNow].includes(second!.id), `Forge's actionable set was ${JSON.stringify([...offeredNow])}`).toBe(false);
      expect(cardButton(roots[a.seat]!, second!.id)).toBeNull();

      // And the whole board agrees with Forge, card for card: a clickable face
      // exists exactly where Forge named the card, and nowhere else. This is
      // the "nothing glows that cannot be clicked" claim, measured.
      const onBoard = [...(me(a).hand ?? []), ...me(a).battlefield, ...opponent(a).battlefield];
      expect(onBoard.length).toBeGreaterThan(1);
      const drawn = onBoard.map((c) => [c.id, cardButton(roots[a.seat]!, c.id) !== null] as const);
      const forge = onBoard.map((c) => [c.id, offeredNow.has(c.id)] as const);
      expect(drawn).toEqual(forge);
      console.log(
        `[board-play.jvm] Forge's actionable set at priority: ${JSON.stringify([...offeredNow])}; of ${onBoard.length} cards drawn, ` +
          `${drawn.filter(([, on]) => on).length} are clickable, and every one of them is Forge's — ` +
          `${weaklyFrames.length} setWeaklySelectable frames reached this seat`,
      );
      phase1Checked = true;

      // 3. Next turn: a targeted spell, the target chosen by clicking a seat.
      await drive(phase2Done, 'Shock at the opponent by clicking');
      const t = targeting as LiveSelectables | null;
      expect(t).not.toBeNull();
      const shockResolved = me(a).graveyard.some((c) => c.id === clicked.shock);
      console.log(
        `[board-play.jvm] seat ${a.seat} turn ${a.live.view!.turn}: Forge's setSelectables for Shock was ` +
          `${JSON.stringify([...t!.cards])} min ${t!.min} max ${t!.max}; the opponent's seat was clicked; Shock ` +
          `${shockResolved ? `resolved, opponent at ${opponent(a).life}` : 'on the stack'} — ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );

      // Lane C's says crossed and this client holds them (display only). With
      // the shortcuts on, a match this short has still auto-passed stops for
      // the actor — the board must be able to say so.
      expect(a.live.says.length).toBeGreaterThan(0);
      console.log(`[board-play.jvm] says held by the actor: ${JSON.stringify(a.live.says.slice(-4))}`);

      // Nothing this client sent was refused, by the server or by the bridge.
      expect(h.refused).toEqual([]);
      expect(h.raw.filter((l) => l.t === 'rejected' || l.t === 'stale' || l.t === 'fatal' || l.t === 'unsupported')).toEqual([]);
      console.log(log.filter((l) => / clicks /.test(l)).join('\n'));
      h.stop();
    },
    300_000,
  );
});
