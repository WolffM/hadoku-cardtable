/**
 * Clip: a Swiss tournament. Eight entrants (four friends, four AI) in a Gauntlet tournament; everyone
 * readies, the field locks and pairs, the hero is carried to their table where the opponent is revealed,
 * and the hub shows the round's bracket.
 */
import { test } from '@playwright/test';

import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { deliberateClick } from './drive.ts';
import { HERO, openPromoFriend, RIVAL, startFilm } from './rig.ts';

const PREFIX = '/cardtable';

test('tournament: eight entrants, the field pairs', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const film = await startFilm('tournament');
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const base = `${stack.origin}${PREFIX}/api`;
    const hero = await openPromoFriend(film.hero, HERO, { filmed: true });
    const friends = [hero, await openPromoFriend(browser, RIVAL), await openPromoFriend(browser, 'vexmoor'), await openPromoFriend(browser, 'lumen')];
    const call = async (f: (typeof friends)[number], method: 'POST' | 'PATCH', path: string, data: unknown): Promise<unknown> => {
      const res = await f.context.request.fetch(`${base}${path}`, { method, data });
      if (!res.ok()) throw new Error(`promo: ${method} ${path} ${res.status()} ${await res.text()}`);
      return res.json();
    };
    const { id: roomId } = (await call(hero, 'POST', '/rooms', { name: 'Saturday Swiss — Modern Gauntlet', gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' }, clientMode: 'builtin' })) as { id: string };
    await call(hero, 'PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } });
    const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
    for (const f of friends.slice(1)) await call(f, 'POST', `/rooms/${roomId}/join`, {});
    for (const f of friends) await f.page.goto(roomUrl);
    await hero.page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    await film.beat(1_500);
    await film.roll();
    film.mark('lobby');
    await film.beat(1_200);

    // The field fills in on camera: friends sit, then the AI seats.
    film.mark('seats');
    for (const [seat, f] of friends.entries()) {
      await call(f, 'POST', `/rooms/${roomId}/pod/sit`, { seat });
      await film.beat(450);
    }
    for (const seat of [4, 5, 6, 7]) {
      await call(hero, 'POST', `/rooms/${roomId}/pod/ai`, { seat, on: true });
      await film.beat(300);
    }
    await film.beat(1_000);
    for (const f of friends.slice(1)) await call(f, 'POST', `/rooms/${roomId}/ready`, { ready: true });
    await film.beat(800);

    film.mark('ready');
    await deliberateClick(hero.page, hero.page.getByTestId('ready-toggle'), { hover: 500 });
    await hero.page.getByTestId('table-page').waitFor({ timeout: 30_000 });
    film.mark('paired');
    await hero.page.getByTestId('table-seats').waitFor({ timeout: 30_000 });
    await film.beat(3_500);

    film.mark('bracket');
    await deliberateClick(hero.page, hero.page.getByTestId('table-hub'), { hover: 400 });
    await hero.page.getByTestId('pod-tables').waitFor({ timeout: 30_000 });
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await film.stop();
    await stack?.stop();
  }
});
