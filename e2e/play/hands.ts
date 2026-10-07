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

import { BUTTON_ONE, BUTTON_TWO, clickHandCard } from './board.ts';
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
   * (`live-play-or-draw-play`) rather than Forge's button one anywhere else,
   * so `ok` alone cannot stand in for "something pressable is showing".
   */
  playOrDraw: boolean;
  /**
   * Wave 36 T4: every OTHER Forge yes/no (the opening mulligan's
   * Keep/Mulligan, a shockland's pay-2-life, any other `InputConfirm`) is
   * ALSO in its own decision-area pop-up (`e2e/play/confirm.ts`). Before
   * this, the mulligan was answered by this bot's own generic "press OK"
   * fallback below (the bar's OK read Forge's "Keep") — that fallback goes dark
   * the instant the question moves, so this needs its own flag the same way
   * `playOrDraw` already does.
   */
  confirmYes: boolean;
  /** This seat's own battlefield and hand, as the board counts them — evidence for whether a play landed. */
  counts: { battlefield: number; hand: number };
}

async function look(f: Friend): Promise<Look | null> {
  try {
    return await f.page.evaluate(([one, two]): Look => {
      const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
      const cardsIn = (root: ParentNode, sel: string) =>
        Array.from(root.querySelectorAll(sel)).map((el) => ({
          id: Number(el.getAttribute('data-board-card')),
          name: el.querySelector('.card__name')?.textContent ?? '',
          type: el.querySelector('.card__type')?.textContent ?? '',
        }));
      return {
        says: text('[data-testid="live-says"]'),
        ok: document.querySelector(one) !== null,
        cancel: document.querySelector(two) !== null,
        me: text('[data-testid="player"][data-viewer] .seat__name').trim(),
        hand: cardsIn(document, '[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]'),
        anywhere: cardsIn(document, '[data-board-card][data-selectable]').map((c) => ({ id: c.id })),
        opponentSelectable: document.querySelector('[data-testid="player"]:not([data-viewer])[data-selectable] .seat__select') !== null,
        ask: document.querySelector('[data-testid="live-prompt"]') !== null,
        playOrDraw: document.querySelector('[data-testid="live-play-or-draw-play"]') !== null,
        confirmYes: document.querySelector('[data-testid="prompt-confirm-yes"]') !== null,
        counts: {
          battlefield: Number(document.querySelector('[data-zone="battlefield"][data-owner="you"]')?.getAttribute('data-count') ?? -1),
          hand: Number(document.querySelector('[data-zone="hand"][data-owner="you"]')?.getAttribute('data-count') ?? -1),
        },
      };
    }, [BUTTON_ONE, BUTTON_TWO] as const);
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
    log.push(`${new Date().toISOString()} seat ${seat}: ${why} [${s.says.replace(/\s+/g, ' ').slice(0, 100)}] bf=${s.counts.battlefield} hand=${s.counts.hand}`);
    try {
      await click();
    } catch (err) {
      // The offer can be replaced under the click (a drag's can too); the next tick looks again.
      log.push(`  (click did not land: ${String(err).split('\n')[0]})`);
      // What the hand's offered cards looked like at that moment: the attributes the gesture layer writes, and visibility.
      const seen = await f.page
        .evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="hand"] li[data-selectable]')).map(
            (li) => `${li.getAttribute('data-card-id')}:${Array.from(li.attributes).filter((x) => x.name.startsWith('data-cast') || x.name === 'style').map((x) => `${x.name}=${x.value}`).join(',')}:${getComputedStyle(li).visibility}/${getComputedStyle(li.querySelector('button') ?? li).visibility}`,
          ),
        )
        .catch(() => []);
      log.push(`  (offered hand: ${seen.join(' | ')})`);
      return false;
    }
    hands.acts += 1;
    return true;
  };
  // Forge's button one or two wherever the page draws it (wave 51: `board.ts`'s `BUTTON_ONE`/`BUTTON_TWO`).
  const press = (which: 'ok' | 'cancel') => () =>
    f.page.locator(which === 'ok' ? BUTTON_ONE : BUTTON_TWO).first().click({ timeout: 2_000 });
  const pressPlayOrDraw = () => f.page.getByTestId('live-play-or-draw-play').click({ timeout: 2_000 });
  /**
   * Click a card to play/cast/choose it: a press lifts it (the Arena
   * gesture, for any card in the viewer's own hand), and a second press at
   * the release point is what actually sends it — nothing reaches Forge
   * before that release — delegates to `board.ts`'s `clickHandCard`
   * (the "why" for the two-press release, the `row` placement, and the
   * one-jump-not-animated fix all live there now). This bot plays lands and
   * casts spells by clicking hand cards as its two most basic acts
   * (`decide()`, below), so without that second press, every pre-existing
   * spec that drives a real game via `connectHands` (most of
   * `table-fit.spec.ts`, `play.spec.ts`, and the w31-w36 files that call it)
   * would stall the instant it tried to play a land or cast anything, having
   * done nothing Forge or the server would ever see.
   *
   * The short timeout is this bot's own: a spec driving its OWN precision
   * mouse work concurrently (`w31.spec.ts`'s combat-rail test hovers a log
   * name on the SAME page this bot runs on) is a real, measured race this
   * halves but does not fully remove (4 of 5 runs — `wave35-evidence/e-runs.md`);
   * such a spec still needs to `pause()`/`resume()` this bot around its own
   * window, same as it already must for a board measurement (this file's
   * own header).
   */
  // A click that lifts nothing (or finds no row to release on) is a click that did not land: logged with the hand's state, like a timeout.
  const clickCard = (id: number, row?: 'back' | 'front') => async (): Promise<void> => {
    if (!(await clickHandCard(f.page, id, { row, timeout: 2_000 }))) {
      const lift = await f.page.locator(`[data-board-card="${id}"]`).getAttribute('data-cast-lift').catch(() => null);
      throw new Error(`hand card ${id} did not lift (data-cast-lift=${lift})`);
    }
  };

  async function decide(s: Look): Promise<void> {
    const msg = s.says;
    const turn = /Turn: (\d+)/.exec(msg)?.[1] ?? '?';
    // Wave 35 R2: the coin toss is answered through its own pop-up, never
    // Forge's button one anywhere else (`s.ok` is false the whole time this is showing), so it needs its own
    // branch ahead of everything below — without it, this seat's `decide()`
    // fell through every later check, found nothing pressable, and did
    // nothing at all, forever.
    if (s.playOrDraw) {
      await act('Play (the coin toss)', s, pressPlayOrDraw);
      return;
    }
    // Wave 36 T4: a yes/no confirm (the opening mulligan's Keep/Mulligan,
    // a shockland's pay-2-life, any other InputConfirm) is answered the way
    // this bot always defaulted when it still rode the bar's OK: the
    // first ("yes") button — never Mulligan, never No, on purpose (the file's
    // own header: this bot keeps whatever hand it is dealt).
    if (s.confirmYes) {
      await act('Confirm: yes (default)', s, () => f.page.getByTestId('prompt-confirm-yes').click({ timeout: 2_000 }));
      return;
    }
    if (s.me !== '' && msg.startsWith(`Priority: ${s.me}`)) {
      if (msg.includes(`(${s.me})`) && msg.includes('Main phase, precombat') && msg.includes('Stack: Empty')) {
        const land = s.hand.find((c) => /\bland\b/i.test(c.type));
        if (land !== undefined && !tried.has(`${turn}:land`)) {
          tried.add(`${turn}:land`);
          if (await act(`play land ${land.name}`, s, clickCard(land.id, 'back'))) return;
        }
        // Not a Pact: it is free now and loses the game at the next upkeep
        // unless its cost is paid then, which this bot cannot plan for
        // (Slaughter Pact ended table-fit's match on CI 37171407975 and 37182810018).
        const spell = s.hand.find((c) => !/\bland\b/i.test(c.type) && !/\bPact\b/.test(c.name) && !tried.has(`${turn}:${c.id}`));
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
      const targetKey = (which: string) => `${turn}:target:${msg}:${which}`;
      /*
       * Forge's own refusal wording ("Cannot target this player…") replaces
       * the ask's text but does NOT clear the face's `data-selectable` —
       * it is still offered, still true, even though it is the thing that
       * was just refused. Keying "already tried the face" by the message
       * text alone (which changes between the ask and its own refusal) is
       * not enough: the refusal is itself a new message, so without this
       * check the face gets clicked a SECOND time, against the message that
       * is already telling us it cannot be targeted, before anything ever
       * tries a card.
       */
      const faceRefused = /cannot target/i.test(msg);
      if (!faceRefused && s.opponentSelectable && !tried.has(targetKey('face'))) {
        tried.add(targetKey('face'));
        if (
          await act('target the opponent', s, () =>
            f.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable] .seat__select').first().click({ timeout: 2_000 }),
          )
        )
          return;
      }
      /*
       * The face was never offered, Forge refused it, or `faceRefused` just
       * skipped straight past it (most target asks are a CARD, not a player
       * — "Destroy target nonblack creature" never offers one). Forge
       * disables BOTH buttons for a mandatory target with legal candidates
       * still on the board (`InputSelectTargets`), so once the face is
       * refused, falling straight through to them below does nothing,
       * forever, instead of trying an actual card. Their own battlefield
       * first (the common case, an opponent's creature), then anywhere Look
       * already found selectable — each exactly once per distinct message,
       * so a refusal is never retried against the same candidate.
       */
      if (!tried.has(targetKey('theirs'))) {
        tried.add(targetKey('theirs'));
        const theirs = f.page.locator('.seat:not([data-viewer]) [data-board-card][data-selectable] button').first();
        if ((await theirs.count()) > 0 && (await act('target their card', s, () => theirs.click({ timeout: 2_000 })))) return;
      }
      if (!tried.has(targetKey('any')) && s.anywhere.length > 0) {
        tried.add(targetKey('any'));
        const cardId = s.anywhere[0]!.id;
        if (await act(`target card ${cardId}`, s, () => f.page.locator(`[data-board-card="${cardId}"] button`).first().click({ timeout: 2_000 })))
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
