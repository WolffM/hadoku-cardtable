/**
 * A minimal `GameBundleModule` (`@wolffm/rooms-protocol`) standing in for hadoku-bomberman's real
 * embed (private repo, no licence — never copied here) for `e2e/bomberman.spec.ts`.
 *
 * Served same-origin by intercepting `/bomberman/embed/bomberman-embed.js` with Playwright's
 * `page.route`/`context.route` and fulfilling with this file's own bytes — no server or harness
 * change needed, since `BundleSlot.tsx` loads its bundle by a plain `import(src)` the browser
 * resolves as an ordinary same-origin request. It echoes the `GameBundleContext` it is handed
 * into the DOM, inside the host element `mountGameBundle` gives it, so the spec asserts the real
 * context a room produced (roomKey, seats, isLeader) rather than merely "something mounted" —
 * the same shape `apps/ui/src/rooms/bundle-slot.fixture.ts` proves at the unit level.
 */

window.__bombermanFixture = { mounts: 0, updates: 0, unmounts: 0 };

function render(el, ctx) {
  el.innerHTML = '';
  const panel = document.createElement('div');
  panel.setAttribute('data-testid', 'bomberman-fixture');
  panel.dataset.roomKey = ctx.roomKey;
  panel.dataset.isLeader = String(ctx.isLeader);
  panel.dataset.mySeat = ctx.match.seat === null ? '' : String(ctx.match.seat);
  panel.textContent = `bomberman fixture in ${ctx.roomKey}`;

  const seats = document.createElement('ul');
  seats.setAttribute('data-testid', 'bomberman-fixture-seats');
  for (const seat of ctx.match.seats) {
    const li = document.createElement('li');
    li.setAttribute('data-testid', 'bomberman-fixture-seat');
    li.dataset.seat = String(seat.seat);
    li.textContent = seat.name;
    seats.append(li);
  }
  panel.append(seats);
  el.append(panel);
}

export async function mount(el, ctx) {
  window.__bombermanFixture.mounts++;
  render(el, ctx);
  return {
    update(next) {
      window.__bombermanFixture.updates++;
      render(el, next);
    },
    unmount() {
      window.__bombermanFixture.unmounts++;
      el.innerHTML = '';
    },
  };
}
