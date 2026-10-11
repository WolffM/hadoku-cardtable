/**
 * A player who never picked a character still has one — the operator,
 * 2026-10-11: *"just had a game with 'rhomancer' and they had no avatar
 * selected. in watchparty there is logic to auto-select an avatar we should
 * probably port that into the generic functionality as well."*
 *
 * Alice and bob are fresh browsers with no saved avatar anywhere (no prefs
 * cache row, and the harness's prefs route holds nothing for them). Alice makes
 * a room, bob joins it, both ready, the match starts. The room gives each of
 * them a character on joining, and not the same one: the room's members list
 * says so, and both boards draw both faces with it.
 *
 * `[yy-avatar]` lines are the evidence: each member's avatar as the room
 * reports it, and each face's avatar as each screen draws it.
 */
import { expect, test, type Locator } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';

/** Their sprite server, stood in for by a disc so no image bytes enter this repo. */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84"><circle cx="42" cy="42" r="42" fill="#70a0d0"/></svg>`;

const ownFace = (f: Friend): Locator => f.page.locator('[data-player-face][data-viewer]');
const theirFace = (f: Friend): Locator => f.page.locator('[data-player-face]:not([data-viewer])');

test(titled('a player with no saved avatar is given one on joining a room, and two such players get different ones'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    for (const f of [alice, bob]) {
      await f.context.route('**/watchparty/media/sprites/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SPRITE }));
    }
    const { roomUrl } = await enterMatch(alice, bob, stack.origin);
    const roomId = /#\/room\/(r-[0-9a-f]{12})$/.exec(roomUrl)?.[1];
    if (roomId === undefined) throw new Error(`no room id in ${roomUrl}`);

    const res = await alice.context.request.get(`${stack.origin}${PREFIX}/api/rooms/${roomId}`);
    expect(res.ok(), `the room answers (${res.status()})`).toBe(true);
    const members = ((await res.json()) as { members: { name: string; avatarId?: string }[] }).members;
    for (const m of members) console.log(`[yy-avatar] room ${roomId} member ${m.name} avatarId=${m.avatarId ?? '(none)'}`);
    expect(members, 'both players are in the room').toHaveLength(2);
    for (const m of members) expect(m.avatarId, `${m.name} was given an avatar on joining`).toBeTruthy();
    expect(members[0]!.avatarId, 'the two players were given different avatars').not.toBe(members[1]!.avatarId);

    // Member names are the edge's user ids, not the friends' names, so each face
    // is checked against the room's set and against the other screen's drawing of it.
    const given = new Set(members.map((m) => m.avatarId));
    const drawn = async (face: Locator): Promise<string | null> => face.getAttribute('data-avatar', { timeout: 30_000 }).catch(() => null);
    const faces: string[] = [];
    for (const [f, other] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const own = await drawn(ownFace(f));
      const seen = await drawn(theirFace(other));
      console.log(`[yy-avatar] ${f.name}'s face: on their screen data-avatar=${own ?? '(none)'}, on ${other.name}'s data-avatar=${seen ?? '(none)'}`);
      if (own === null) throw new Error(`${f.name}'s own screen draws no avatar on their face`);
      expect(given.has(own), `${f.name}'s face is one the room gave (${[...given].join(', ')})`).toBe(true);
      await expect(theirFace(other), `${other.name}'s screen draws ${f.name}'s face with the same avatar`).toHaveAttribute('data-avatar', own);
      for (const face of [ownFace(f), theirFace(other)]) {
        await expect(face.getByTestId('seat-avatar'), `${f.name}'s face is that character's image`).toHaveAttribute('src', new RegExp(`square_${own}\\.png$`));
      }
      faces.push(own);
    }
    expect(faces[0], "alice's and bob's faces differ").not.toBe(faces[1]);
  } finally {
    await stack.stop();
  }
});
