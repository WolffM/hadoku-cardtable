/**
 * A minimal `GameBundleModule` (`@wolffm/rooms-protocol`) standing in for a configured external
 * game's real embed, for `e2e/external-game-room.spec.ts`. A toy, not bomberman's own fixture:
 * this proves the GENERIC mechanism (`@hadoku/game-ui/rooms/external-games.tsx`'s `EXTERNAL_GAMES`
 * loop, and `RoomTableScreen`'s generic room-join — wave 119 §U's 1a) rather than anything
 * bomberman-specific, even though the one configured entry it rides on today happens to be
 * bomberman's (`apps/server/src/plugins/external-games.ts`).
 *
 * Served same-origin by intercepting the configured entry's own embed path with Playwright's
 * `page.route`/`context.route` and fulfilling with this file's own bytes — no server or harness
 * change needed, since `BundleSlot.tsx` loads its bundle by a plain `import(src)` the browser
 * resolves as an ordinary same-origin request. It echoes the `GameBundleContext` it is handed
 * into the DOM, inside the host element `mountGameBundle` gives it, so the spec asserts the real
 * context a room produced (roomKey, seats, isLeader) rather than merely "something mounted".
 *
 * It reads `ctx.channel` the way a real external-game embed would in a cardtable room: Send puts
 * a message on it, every message `on()` delivers is listed, and Over sends the leader's
 * `{ t: 'over', winners }` with `window.__externalGameFixture.overWinners` (default `[0]`).
 */

window.__externalGameFixture = { mounts: 0, updates: 0, unmounts: 0, received: [], overWinners: [0] };

function render(el, ctx) {
  el.innerHTML = '';
  const panel = document.createElement('div');
  panel.setAttribute('data-testid', 'external-game-fixture');
  panel.dataset.roomKey = ctx.roomKey;
  panel.dataset.isLeader = String(ctx.isLeader);
  panel.dataset.mySeat = ctx.match.seat === null ? '' : String(ctx.match.seat);
  panel.textContent = `external game fixture in ${ctx.roomKey}`;

  const seats = document.createElement('ul');
  seats.setAttribute('data-testid', 'external-game-fixture-seats');
  for (const seat of ctx.match.seats) {
    const li = document.createElement('li');
    li.setAttribute('data-testid', 'external-game-fixture-seat');
    li.dataset.seat = String(seat.seat);
    li.textContent = seat.name;
    seats.append(li);
  }
  panel.append(seats);
  panel.dataset.hasChannel = String(ctx.channel !== undefined);

  const send = document.createElement('button');
  send.setAttribute('data-testid', 'external-game-fixture-send');
  send.textContent = 'Send';
  send.addEventListener('click', () => ctx.channel?.send({ t: 'hello', from: ctx.match.seat }));
  panel.append(send);

  const over = document.createElement('button');
  over.setAttribute('data-testid', 'external-game-fixture-over');
  over.textContent = 'Over';
  over.addEventListener('click', () => ctx.channel?.send({ t: 'over', winners: window.__externalGameFixture.overWinners }));
  panel.append(over);

  const received = document.createElement('ul');
  received.setAttribute('data-testid', 'external-game-fixture-received');
  for (const msg of window.__externalGameFixture.received) {
    const li = document.createElement('li');
    li.setAttribute('data-testid', 'external-game-fixture-message');
    li.textContent = JSON.stringify(msg);
    received.append(li);
  }
  panel.append(received);
  el.append(panel);
}

function subscribe(el, channel, latest) {
  return (
    channel?.on((msg) => {
      window.__externalGameFixture.received.push(msg);
      render(el, latest());
    }) ?? null
  );
}

export async function mount(el, ctx) {
  window.__externalGameFixture.mounts++;
  window.__externalGameFixture.received = [];
  let current = ctx;
  let unsubscribe = subscribe(el, ctx.channel, () => current);
  render(el, ctx);
  return {
    update(next) {
      window.__externalGameFixture.updates++;
      // The channel arrives a moment after the first context; resubscribe only when it changes.
      if (next.channel !== current.channel) {
        unsubscribe?.();
        unsubscribe = subscribe(el, next.channel, () => current);
      }
      current = next;
      render(el, next);
    },
    unmount() {
      window.__externalGameFixture.unmounts++;
      unsubscribe?.();
      unsubscribe = null;
      el.innerHTML = '';
    },
  };
}
