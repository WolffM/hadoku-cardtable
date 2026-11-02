/**
 * The operator, 2026-11-01: *"can you ban alchemy cards from cardtable? i dont wnat to see anything
 * alchemy related anymore. i dont want to see alchemy sets, or alchemy cards."*
 *
 * Forge has an edition, most with a draft booster, for every Alchemy set (YMID … YFRA, HBG) and for
 * J21's Alchemy designs. Against the real jar: the draft set list names none, Rally's Sets catalogue
 * finds none, and asking for one's cards or a pack of it is refused. The e2e catalog fixture carries
 * one Alchemy card on purpose (`fixtures/build-sets-catalog.ts`'s `ALCHEMY_PROBE`, Gutmorn of YMID),
 * and no answer here ever holds it.
 *
 * Every step prints one `[no-alchemy]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const PREFIX = '/cardtable';
const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[no-alchemy] ${JSON.stringify({ step, data })}`);

/** Forge's codes for Alchemy sets with an edition in the pinned jar's res, and J21. */
const ALCHEMY_CODES = ['YMID', 'Y22', 'YNEO', 'YSNC', 'YDMU', 'YBRO', 'YONE', 'YWOE', 'YLCI', 'YMKM', 'YOTJ', 'YBLB', 'YDSK', 'YDFT', 'HBG', 'J21'];

/** Every answer the spec read, so the last step can check none of them holds the probe card. */
const answers: string[] = [];

async function get(request: APIRequestContext, origin: string, path: string): Promise<{ status: number; text: string }> {
  const res = await request.get(`${origin}${PREFIX}/api${path}`);
  const text = await res.text();
  answers.push(text);
  return { status: res.status(), text };
}

test(titled('no Alchemy set is listed, found or opened, and the Alchemy card in the catalog is never served'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const request = alice.context.request;

    const sets = await get(request, stack.origin, '/pools/sets');
    expect(sets.status, 'the set list answers').toBe(200);
    const listed = JSON.parse(sets.text) as { code: string; name: string }[];
    const alchemyListed = listed.filter((s) => /alchemy/i.test(s.name) || ALCHEMY_CODES.includes(s.code));
    log('sets', { count: listed.length, alchemyListed });
    expect(listed.some((s) => s.code === 'ISD'), 'the paper sets are still there').toBe(true);
    expect(alchemyListed, 'no Alchemy set').toEqual([]);

    for (const q of ['alchemy', 'innistrad', 'baldur', 'jumpstart']) {
      const found = await get(request, stack.origin, `/rally/options/set?q=${q}`);
      log(`rally options ${q}`, { status: found.status, text: found.text.slice(0, 400) });
      expect(found.status, `Rally answers ${q}`).toBe(200);
      const options = (JSON.parse(found.text) as { data: { suggestions: { id: string; label: string }[] } }).data.suggestions;
      expect(options.filter((o) => /alchemy/i.test(o.label) || ALCHEMY_CODES.includes(o.id)), `Rally finds no Alchemy set for ${q}`).toEqual([]);
    }

    for (const code of ['YMID', 'HBG', 'J21']) {
      for (const view of ['cards', 'pack']) {
        const opened = await get(request, stack.origin, `/rally/views/set/${code}/${view}`);
        log(`rally ${code} ${view}`, { status: opened.status, text: opened.text.slice(0, 200) });
        expect(opened.status, `${code}'s ${view} is refused`).toBeGreaterThanOrEqual(400);
      }
    }

    const isd = await get(request, stack.origin, '/rally/views/set/ISD/cards');
    log('rally ISD cards', { status: isd.status, bytes: isd.text.length });
    expect(isd.status, "a paper set's cards still open").toBe(200);

    log('probe', { answers: answers.length, served: answers.filter((a) => a.includes('Gutmorn')).length });
    for (const answer of answers) expect(answer, 'the probe card is never served').not.toContain('Gutmorn');
  } finally {
    await stack.stop();
  }
});
