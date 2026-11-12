/**
 * A minimal `GameBundleModule` (`@wolffm/rooms-protocol`) standing in for a native relay game's
 * real embed, for `e2e/relay-fixture.spec.ts`. It exercises `ctx.channel`
 * (`apps/ui/src/rooms/relay-channel.ts`'s own contract): a button sends a message over it, every
 * message `on()` delivers is shown, and a `{ t: 'over' }` — sent or received — marks the match
 * ended, same as `bomberman-embed.fixture.js` echoes `ctx` itself for BundleSlot's own proof.
 * End's winners are `window.__relayFixture.overWinners` when set, else the sender's own seat.
 *
 * Served same-origin by intercepting `/relay-fixture/relay-test-embed.js` with Playwright's
 * `context.route` — no server or harness change needed, `BundleSlot.tsx` loads its bundle by a
 * plain `import(src)` the browser resolves as an ordinary same-origin request.
 */

window.__relayFixture = { mounts: 0, updates: 0, unmounts: 0, received: [], ended: false, overWinners: null };

function render(el, ctx) {
  el.innerHTML = '';
  const panel = document.createElement('div');
  panel.setAttribute('data-testid', 'relay-fixture');
  panel.dataset.roomKey = ctx.roomKey;
  panel.dataset.isLeader = String(ctx.isLeader);
  panel.dataset.mySeat = ctx.match.seat === null ? '' : String(ctx.match.seat);
  panel.dataset.hasChannel = String(ctx.channel !== undefined);
  panel.textContent = `relay fixture in ${ctx.roomKey}`;
  el.append(panel);

  const sendBtn = document.createElement('button');
  sendBtn.setAttribute('data-testid', 'relay-fixture-send');
  sendBtn.textContent = 'Send';
  sendBtn.addEventListener('click', () => {
    ctx.channel?.send({ t: 'hello', from: ctx.identity.userId });
  });
  panel.append(sendBtn);

  const endBtn = document.createElement('button');
  endBtn.setAttribute('data-testid', 'relay-fixture-end');
  endBtn.textContent = 'End';
  endBtn.addEventListener('click', () => {
    ctx.channel?.send({ t: 'over', winners: window.__relayFixture.overWinners ?? [ctx.match.seat ?? 0] });
    // The sender never hears its own send echoed back (the host's own rule) — this fixture's
    // leader tracks ending the match locally, exactly as a real bundle driving the game's own
    // end condition on both sides would.
    window.__relayFixture.ended = true;
    render(el, ctx);
  });
  panel.append(endBtn);

  const ended = document.createElement('div');
  ended.setAttribute('data-testid', 'relay-fixture-ended');
  ended.hidden = !window.__relayFixture.ended;
  ended.textContent = 'ended';
  panel.append(ended);

  const received = document.createElement('ul');
  received.setAttribute('data-testid', 'relay-fixture-received');
  for (const msg of window.__relayFixture.received) {
    const li = document.createElement('li');
    li.setAttribute('data-testid', 'relay-fixture-message');
    li.textContent = JSON.stringify(msg);
    received.append(li);
  }
  panel.append(received);
}

function subscribe(el, ctx) {
  return (
    ctx.channel?.on((msg) => {
      window.__relayFixture.received.push(msg);
      if (msg !== null && typeof msg === 'object' && msg.t === 'over') window.__relayFixture.ended = true;
      render(el, ctx);
    }) ?? null
  );
}

export async function mount(el, ctx) {
  window.__relayFixture.mounts++;
  window.__relayFixture.received = [];
  window.__relayFixture.ended = false;
  let unsubscribe = subscribe(el, ctx);
  render(el, ctx);
  return {
    update(next) {
      window.__relayFixture.updates++;
      unsubscribe?.();
      unsubscribe = subscribe(el, next);
      render(el, next);
    },
    unmount() {
      window.__relayFixture.unmounts++;
      unsubscribe?.();
      unsubscribe = null;
      el.innerHTML = '';
    },
  };
}
