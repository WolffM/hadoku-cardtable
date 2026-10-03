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
  /**
   * Stop acting (the timer stays) — and wait out any tick already in flight,
   * so a caller that awaits this is guaranteed none of this bot's own clicks
   * or mouse moves can land after it returns. See this interface's own
   * implementation note for why that guarantee needs an await now.
   */
  pause(): Promise<void>;
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
  /**
   * Wave 35 R2: the coin toss / play-draw question, in its own decision area
   * (`live-play-or-draw-play`) rather than `live-button-ok` — which is
   * DISABLED the whole time this is true, so `ok` alone can no longer stand
   * in for "something pressable is showing".
   */
  playOrDraw: boolean;
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
        playOrDraw: document.querySelector('[data-testid="live-play-or-draw-play"]') !== null,
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
    pause: async () => {
      paused = true;
      // Wave 35 R7's own click-then-settle (`clickCard`, above) made a
      // single tick do more than one await — long enough that a caller
      // which set `paused` and moved straight on to its own precision work
      // could still race a tick that was ALREADY running when `pause()` was
      // called (measured directly: `w31.spec.ts`'s combat-rail test still
      // hit the log's own "two different cards" race — `named` read, then a
      // tick's own settle-move landed before `.hover()` — with a synchronous
      // `pause()` sitting between the two). Waiting out `busy` here, the
      // same guard `close()` already uses, is what actually closes it: a
      // caller that `await`s this is guaranteed no tick is mid-flight the
      // moment it returns, not just that no NEW one will start.
      while (busy) await new Promise((r) => setTimeout(r, 20));
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
  const pressPlayOrDraw = () => f.page.getByTestId('live-play-or-draw-play').click({ timeout: 2_000 });
  /**
   * Click a card to play/cast/choose it, then settle the Arena gesture (R7)
   * the click only ARMS for any card in the viewer's own hand.
   *
   * **Wave 35 R7 regression, confirmed by a real-browser debug trace**:
   * `isHandCard` (`gestures/cast.ts`) makes no exception for "this press is
   * choosing an answer, not casting a spell" — a plain click on ANY hand
   * card now only lifts it and waits for the (still unheld) pointer to cross
   * into the viewer's own battlefield before anything is sent at all. This
   * bot plays lands and casts spells by clicking hand cards as its two most
   * basic acts (`decide()`, below), so without this every pre-existing spec
   * that drives a real game via `connectHands` (most of `table-fit.spec.ts`,
   * `play.spec.ts`, and the w31-w34 files that call it) would stall the
   * instant it tried to play a land or cast anything, having done nothing
   * Forge or the server would ever see. Harmless for a card NOT in hand
   * (`isHandCard` false — a battlefield target, say): no gesture was ever
   * armed, so the follow-up move is a no-op.
   *
   * **`row`, a SECOND regression this bot's own first fix introduced**: R9's
   * `notePlayedTo` (`Board.tsx`) records whichever row the settle point
   * lands in as the PERMANENT's placement, overriding `group()`'s own
   * default (a land to the back row, anything else to the front —
   * `table-fit.spec.ts`'s own "the back row holds lands only" invariant).
   * The first draft of this settle-move always targeted the whole
   * battlefield's geometric centre, which — on this board's own proportions
   * — sits inside the BACK row's box: every card this bot ever cast, land or
   * not, settled into the back row (measured: two non-land permanents, ids 9
   * and 26, landed there in a real `table-fit.spec.ts` run, 2 of 2 tries,
   * same ids both times — the match seed is fixed, so this was not chance).
   * `row`, when the caller knows it (`decide()` does — it already branches on
   * land vs. spell to pick WHICH card to click), aims the settle at that
   * row's own box instead, so a bot-driven cast lands exactly where
   * `group()`'s default would have put it anyway. Omitted (a selection
   * answer, an unknown case), it falls back to the old centre-of-battlefield
   * point — still correct for anything that is not itself an R9 slot choice.
   *
   * **One jump, not an animated move**: the first draft moved in 5 STEPS,
   * which on a fast localhost round trip is its own version of the same
   * race — `install.ts`'s settle fires on the FIRST pointermove that crosses
   * into the viewer's own battlefield, which an animated move reaches a step
   * or two before the row-correct final point, usually still over the
   * NEARER row (back, approaching from the hand below); if Forge's delta for
   * a one-mana creature comes back before the remaining steps finish — on
   * this host, every time, for the very first cast of a real match, not a
   * rare case — that early, wrong-row point is what gets recorded, and the
   * later, correct arrival (`row`, aimed right) is already too late to
   * matter (same `useLayoutEffect`-consumes-once mechanism "R9b" in
   * `w35.spec.ts` found). A single, unanimated jump makes the FIRST (and
   * only) pointermove event's own position the final, row-correct one, so
   * there is no earlier point left to win that race.
   */
  const clickCard = (id: number, row?: 'back' | 'front') => async () => {
    await f.page.locator(`[data-board-card="${id}"] button`).first().click({ timeout: 2_000 });
    // Checked directly (`data-cast-lift`), not assumed: this bot only
    // touches the mouse again when a gesture was actually armed. A spec
    // driving its OWN precision mouse work concurrently (`w31.spec.ts`'s
    // combat-rail test hovers a log name on the SAME page this bot runs on)
    // is a real, measured race this halves but does not fully remove (4 of
    // 5 runs — `wave35-evidence/e-runs.md`); such a spec still needs to
    // `pause()`/`resume()` this bot around its own window, same as it
    // already must for a board measurement (this file's own header).
    const lifted = await f.page.locator(`[data-board-card="${id}"]`).getAttribute('data-cast-lift').catch(() => null);
    if (lifted !== 'lifted') return;
    const target =
      row === undefined
        ? await f.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox()
        : await f.page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot="${row}"]`).boundingBox();
    if (target !== null) await f.page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  };

  async function decide(s: Look): Promise<void> {
    const msg = s.says;
    const turn = /Turn: (\d+)/.exec(msg)?.[1] ?? '?';
    // Wave 35 R2: the coin toss is no longer answered through `live-button-ok`
    // (`s.ok` is false the whole time this is showing), so it needs its own
    // branch ahead of everything below — without it, this seat's `decide()`
    // fell through every later check, found nothing pressable, and did
    // nothing at all, forever.
    if (s.playOrDraw) {
      await act('Play (the coin toss)', s, pressPlayOrDraw);
      return;
    }
    if (s.me !== '' && msg.startsWith(`Priority: ${s.me}`)) {
      if (msg.includes(`(${s.me})`) && msg.includes('Main phase, precombat') && msg.includes('Stack: Empty')) {
        const land = s.hand.find((c) => /\bland\b/i.test(c.type));
        if (land !== undefined && !tried.has(`${turn}:land`)) {
          tried.add(`${turn}:land`);
          if (await act(`play land ${land.name}`, s, clickCard(land.id, 'back'))) return;
        }
        const spell = s.hand.find((c) => !/\bland\b/i.test(c.type) && !tried.has(`${turn}:${c.id}`));
        if (spell !== undefined) {
          tried.add(`${turn}:${spell.id}`);
          hands.cast.push(spell.name);
          if (await act(`cast ${spell.name} (offered by Forge)`, s, clickCard(spell.id, 'front'))) return;
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
