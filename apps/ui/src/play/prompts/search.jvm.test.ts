// @vitest-environment jsdom
/*
 * A library SEARCH, against a real Forge match — wave 24 §D items 2 and 3.
 *
 * The operator's complaints were two: *"library search: valid targets at top,
 * rest greyed"* (#3) and *"'looking at cards in your library' shows cards with
 * no art"* (#9). Both are claims about ONE ask, and neither could be settled
 * from a synthetic fixture: the fixtures carry ids from a committed match whose
 * cards have no rows in the art-id table, so "no art" is expected there and
 * says nothing about production.
 *
 * So this drives a real match (one JVM, one scenario) in which both seats cast
 * Rampant Growth — `ChangeZoneEffect`'s library search
 * (`forge-game/.../ability/effects/ChangeZoneEffect.java:1042-1062`), which is
 * the same call that Scalding Tarn's fetch makes. Forge builds:
 *
 *   - `fetchList`  → the ask's `optionList`: the cards that may be CHOSEN,
 *     already filtered by `ChangeType` (`ChangeZoneEffect.java:1096-1099`);
 *   - `toReveal`   → the ask's `delayedReveal.cards`: the WHOLE library
 *     (`:1047-1052`), captioned "<source> - Looking at cards in …" (`:1062`).
 *
 * That pair is Forge's own answer to "which of these is choosable", and it is
 * what `rules.ts`' `searchRows` draws from. This test proves the pair is really
 * there, that the reveal really is a superset, and — the #9 question — records
 * whether the tiles the seat draws while the ask is open carry art.
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, like
 * every other jar-gated suite here. `CARDTABLE_PLAY_DUMP=<dir>` keeps the
 * observation, which is how `docs/planning/w24-d-evidence.md` was written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';

import { createDriver, drive, type Plan } from '../live/game-driver.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness } from '../live/jvm-harness.ts';
import { searchRows } from './rules.ts';
import type { AskOf } from './types.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'a library search against a real Forge match'
  : `a library search against a real Forge match — SKIPPED: ${available.reason}`;

function deck(name: string, lines: readonly string[]): string {
  return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

function dump(label: string, payload: unknown): void {
  const dir = process.env.CARDTABLE_PLAY_DUMP;
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `w24-d-${label}.json`), JSON.stringify(payload, null, 1));
}

/** What one open search prompt looked like in the DOM, before it was answered. */
interface Seen {
  seat: number;
  method: string;
  title: string;
  /** Every tile in the sheet: its forge id, its name text, and whether art loaded. */
  tiles: { cardId: string | undefined; choosable: boolean; text: string; art: string | null }[];
}

function snapshotOpenPrompt(root: Element, seat: number): Seen | null {
  const sheet = root.querySelector<HTMLElement>('[data-testid="live-prompt"]');
  if (sheet === null) return null;
  const method = sheet.dataset.method ?? '';
  if (method !== 'chooseSingleEntityForEffect' && method !== 'chooseEntitiesForEffect') return null;
  const tiles = [...sheet.querySelectorAll<HTMLElement>('li[data-card-id]')].map((li) => ({
    cardId: li.dataset.cardId,
    choosable: li.dataset.choosable !== 'false',
    text: (li.textContent ?? '').trim().slice(0, 60),
    art: li.querySelector('img.card__art')?.getAttribute('src') ?? null,
  }));
  return { seat, method, title: sheet.querySelector('.prompt__title')?.textContent ?? '', tiles };
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
    'Forge sends the choosable list and the whole library separately, and the prompt sorts by Forge’s answer',
    async () => {
      const h = await startLiveMatch({
        seed: 24,
        seats: [
          { name: 'A', ai: false, deck: deck('Search A', ['26 Forest', '14 Rampant Growth']) },
          { name: 'B', ai: false, deck: deck('Search B', ['26 Forest', '14 Rampant Growth']) },
        ],
      });
      running.push(h);

      const plan: Plan = { land: /Forest/, casts: [{ name: 'Rampant Growth', mana: 2 }] };
      const driver = createDriver(h, plan);
      const seen: Seen[] = [];
      const searches = () => h.asks.filter((a) => a.method === 'chooseSingleEntityForEffect');

      await drive(
        driver,
        () => {
          // Record the sheet BEFORE the driver answers it — the tick order is
          // observe, then step, so what is recorded is what a player would see.
          for (const [i, root] of driver.roots.entries()) {
            const shot = snapshotOpenPrompt(root, i);
            if (shot !== null) seen.push(shot);
          }
          return searches().some((a) => a.outcome?.ok === true);
        },
        180_000,
        () => JSON.stringify(h.asks.map((a) => [a.seat, a.method, a.outcome])),
      );

      const ask = searches()[0]!.ask as AskOf<'chooseSingleEntityForEffect'>;
      expect(ask.method).toBe('chooseSingleEntityForEffect');
      // Forge's own answer to "which are choosable", as two lists in one ask.
      expect(ask.optionList.length).toBeGreaterThan(0);
      expect(ask.delayedReveal).not.toBeNull();
      const reveal = ask.delayedReveal!;
      expect(reveal.zones).toContain('Library');
      // The reveal is the whole library, strictly larger than the filtered
      // fetch list; the rows are the fetch list alone, in Forge's order.
      expect(reveal.cards.length).toBeGreaterThan(ask.optionList.length);

      const rows = searchRows(ask);
      expect(rows.map((r) => r.ref)).toEqual([...ask.optionList]);
      expect(rows.every((r) => r.choosable)).toBe(true);

      const drawn = seen.filter((s) => s.tiles.length > 0);
      const anyArt = drawn.some((s) => s.tiles.some((t) => t.art !== null));
      const anyUnnamed = drawn.some((s) => s.tiles.some((t) => /^card #\d+$/.test(t.text)));
      console.log(
        `[search.jvm] optionList ${ask.optionList.length}, revealed ${reveal.cards.length}, ` +
          `sheets observed ${drawn.length}, art on some tile: ${anyArt}, an unnamed tile: ${anyUnnamed}`,
      );
      dump('search', {
        ask,
        rows: rows.map((r) => ({ ref: r.ref, choosable: r.choosable })),
        observed: drawn.slice(0, 4),
        askMethods: h.asks.map((a) => [a.seat, a.method, a.outcome]),
        promptMessages: h.seats.map((s) => s.notes.prompt?.message ?? null),
      });

      // #9, measured rather than assumed: the seat is told the names of the
      // cards Forge revealed to it (`tempShow` → `PlayerMayLook`, honoured by
      // `apps/server/src/play/visibility.ts`), so a tile is never "card #id",
      // and the art-id table resolves them.
      expect(drawn.length, 'a search sheet was drawn and observed').toBeGreaterThan(0);
      expect(anyUnnamed, 'no tile drew as "card #id"').toBe(false);
      expect(anyArt, 'at least one tile resolved art').toBe(true);
      h.stop();
    },
    300_000,
  );
});
