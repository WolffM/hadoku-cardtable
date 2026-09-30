/**
 * TEST SCAFFOLDING: a person's hands on the board, for the parts of a game the
 * spec is not about — playing a land, casting a spell, passing priority.
 *
 * ## Through the page, since wave 31
 *
 * This used to be a SECOND SOCKET per friend, sending `selectCard` and
 * `selectButtonOk` over a raw socket.io connection, because the board could not
 * act (wave 6). The board acts now, and wave 31 §S made a second connection on a
 * held seat a SPECTATOR — *"it would be really messy if two clients were capable
 * of performing game actions"* — whose inputs the server refuses and logs as
 * `c2s-spectator`. So the scaffold's socket was refused every act it sent, every
 * game it drove stalled at turn 1 with no land played, and `table-fit.spec.ts`
 * ran to its play cap (turn 22, largest battlefield 0) before anyone read why.
 *
 * It therefore clicks what a person would click, on that friend's own page: an
 * offered card (`data-selectable` is Forge's own offer), the OK / Cancel bar, the
 * opponent when Forge asks for a target. Nothing it does is a thing the page
 * could not do. It never answers an ASK (a dialog): those are the board's, and
 * every spec that counts answers counts the ones the board gave.
 *
 * It keeps out of the refresh measurement the way it always did: `close()` stops
 * it, and `pause()`/`resume()` hold it still while a spec measures the board.
 */

import type { Friend } from './browser.ts';

export interface Hands {
  seat: number;
  /** What it did, for the evidence file. */
  log: string[];
  acts: number;
  /** Spells it put on the stack, by name. */
  cast: string[];
  /** Stop acting (the timer stays). */
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

const IDLE_MS = 3000;
const TICK_MS = 250;

interface Look {
  says: string;
  ok: boolean;
  cancel: boolean;
  /** This seat's name as the board draws it. */
  me: string;
  /** Hand cards Forge offered, with their type lines. */
  hand: { id: number; name: string; type: string }[];
  /** Every card Forge offered anywhere (a selection's candidates). */
  anywhere: { id: number }[];
  /** The opponent, when Forge is asking for a player. */
  opponentSelectable: boolean;
  ask: boolean;
}

async function look(f: Friend): Promise<Look | null> {
  try {
    return await f.page.evaluate((): Look => {
      const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
      const cardsIn = (root: ParentNode, sel: string) =>
        Array.from(root.querySelectorAll(sel)).map((el) => ({
          id: Number(el.getAttribute('data-board-card')),
          name: el.querySelector('.card__name')?.textContent ?? '',
          type: el.querySelector('.card__type')?.textContent ?? '',
        }));
      return {
        says: text('[data-testid="live-says"]'),
        ok: document.querySelector('[data-testid="live-button-ok"]:enabled') !== null,
        cancel: document.querySelector('[data-testid="live-button-cancel"]:enabled') !== null,
        me: text('[data-testid="player"][data-viewer] .seat__name').trim(),
        hand: cardsIn(document, '[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]'),
        anywhere: cardsIn(document, '[data-board-card][data-selectable]').map((c) => ({ id: c.id })),
        opponentSelectable: document.querySelector('[data-testid="player"]:not([data-viewer])[data-selectable] .seat__select') !== null,
        ask: document.querySelector('[data-testid="live-prompt"]') !== null,
      };
    });
  } catch {
    // The page is mid-navigation or closing; the next tick looks again.
    return null;
  }
}

export async function connectHands(f: Friend, seat: number): Promise<Hands> {
  const log: string[] = [];
  const tried = new Set<string>();
  const picked = new Map<string, number[]>();
  let signature = '';
  let idleSince = Date.now();
  let paused = false;
  let closed = false;
  let busy = false;

  const hands: Hands = {
    seat,
    log,
    acts: 0,
    cast: [],
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      signature = '';
    },
    close: async () => {
      closed = true;
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 50));
    },
  };

  const act = async (why: string, s: Look, click: () => Promise<unknown>): Promise<boolean> => {
    log.push(`${new Date().toISOString()} seat ${seat}: ${why} [${s.says.replace(/\s+/g, ' ').slice(0, 100)}]`);
    try {
      await click();
    } catch (err) {
      // The offer can be replaced under the click (a drag's can too); the next tick looks again.
      log.push(`  (click did not land: ${String(err).split('\n')[0]})`);
      return false;
    }
    hands.acts += 1;
    return true;
  };
  const press = (which: 'ok' | 'cancel') => () =>
    f.page.locator(`[data-testid="live-button-${which}"]:enabled`).click({ timeout: 2_000 });
  const clickCard = (id: number) => () =>
    f.page.locator(`[data-board-card="${id}"] button`).first().click({ timeout: 2_000 });

  async function decide(s: Look): Promise<void> {
    const msg = s.says;
    const turn = /Turn: (\d+)/.exec(msg)?.[1] ?? '?';
    if (s.me !== '' && msg.startsWith(`Priority: ${s.me}`)) {
      if (msg.includes(`(${s.me})`) && msg.includes('Main phase, precombat') && msg.includes('Stack: Empty')) {
        const land = s.hand.find((c) => /\bland\b/i.test(c.type));
        if (land !== undefined && !tried.has(`${turn}:land`)) {
          tried.add(`${turn}:land`);
          if (await act(`play land ${land.name}`, s, clickCard(land.id))) return;
        }
        const spell = s.hand.find((c) => !/\bland\b/i.test(c.type) && !tried.has(`${turn}:${c.id}`));
        if (spell !== undefined) {
          tried.add(`${turn}:${spell.id}`);
          hands.cast.push(spell.name);
          if (await act(`cast ${spell.name} (offered by Forge)`, s, clickCard(spell.id))) return;
        }
      }
      if (s.ok) await act('pass', s, press('ok'));
      return;
    }
    if (/Pay Mana Cost/i.test(msg)) {
      if (s.ok) await act('Auto-pay', s, press('ok'));
      else if (s.cancel) await act('cannot pay: cancel', s, press('cancel'));
      return;
    }
    if (/target/i.test(msg)) {
      if (s.opponentSelectable && !tried.has(`${turn}:target:${msg}`)) {
        tried.add(`${turn}:target:${msg}`);
        if (
          await act('target the opponent', s, () =>
            f.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable] .seat__select').first().click({ timeout: 2_000 }),
          )
        )
          return;
      }
      if (s.ok) await act('targets done', s, press('ok'));
      else if (s.cancel) await act('no target: cancel', s, press('cancel'));
      return;
    }
    // A selection that needs cards (a discard, a choice) and whose OK is still dead.
    if (!s.ok && s.anywhere.length > 0) {
      const done = picked.get(msg) ?? [];
      const next = s.anywhere.find((c) => !done.includes(c.id));
      if (next !== undefined) {
        picked.set(msg, [...done, next.id]);
        await act(`choose card ${next.id}`, s, clickCard(next.id));
        return;
      }
    }
    if (s.ok) await act('OK', s, press('ok'));
  }

  const tick = async (): Promise<void> => {
    if (paused || closed || busy) return;
    busy = true;
    try {
      const s = await look(f);
      if (s === null || s.ask || /^Waiting/.test(s.says)) return;
      const sig = `${s.says}|${s.ok}|${s.cancel}|${s.anywhere.map((c) => c.id).join(',')}`;
      if (sig === signature) {
        // Nothing new since the last act: it changed nothing (a spell it cannot
        // actually pay for, a target it cannot choose). Move on rather than wait.
        if (Date.now() - idleSince > IDLE_MS) {
          idleSince = Date.now();
          if (s.ok) await act('idle → OK', s, press('ok'));
          else if (s.cancel) await act('idle → Cancel', s, press('cancel'));
        }
        return;
      }
      signature = sig;
      idleSince = Date.now();
      await decide(s);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  return hands;
}
