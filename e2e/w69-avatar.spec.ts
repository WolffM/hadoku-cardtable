/**
 * Your own face stays a circle while it is the way into the settings — the
 * operator, 2026-10-10: *"small bug, i notice that when clicking on my avatar to
 * bring up the settings it causes it to become square instead of circular. why
 * does the circle mask break?"*
 *
 * There is no mask: the circle is the turn ring (`.seat__ring`) around the
 * mark, and a watchparty character is a picture with transparent edges. What
 * drew the square was the face button's own focus outline. The press that
 * closes the settings leaves focus on the face, and the next key the player
 * presses turns that into keyboard focus — which outlined the BUTTON, a column
 * holding the mark and the life number under it: a tall box with straight
 * sides around the face.
 *
 * Alice wears a character; bob keeps the drawn mark. Each opens and closes the
 * settings from their own face every way the popover closes, presses a key
 * after the press that closed it, and focuses the face from the keyboard with
 * the turn ring off and on. Every state's screenshot of the face is compared,
 * pixel for pixel, with the face before it was touched — in the mark box's
 * four CORNERS, outside the circle, where a circle (and a round focus ring
 * around it) paints nothing and a box does.
 *
 * `[w69-avatar]` lines are the evidence: what painted each state, where focus
 * was, and the computed outline, radius, background and shadow of every box
 * over the mark.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { enterMatch, makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, RUN_DIR, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SHOTS = resolve(RUN_DIR, 'w69-avatar');

/** Around the mark's square: room for a focus ring, and the corners a square box would paint. */
const PAD = 14;
/** How far outside the mark a round ring may reach: the lit turn ring is 6px, focus steps 8px past the mark plus its 2px line. */
const RING = 12;
/** A corner pixel counts as painted when its colour moved this far (sum of |ΔR|+|ΔG|+|ΔB|) from the untouched face. */
const DELTA = 60;
/** How far the popover's own shadow reaches past its box. */
const SHADOW = 24;

/**
 * A watchparty character as their server draws one: a square image whose
 * corners are transparent (theirs are figures; this is a disc). An SVG stands
 * in for their PNG so no image bytes enter this repo; what matters is the alpha.
 */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84"><circle cx="42" cy="42" r="42" fill="#d0b070"/><circle cx="42" cy="34" r="14" fill="#503018"/></svg>`;

/**
 * Alice has picked a character. In production her room screen asserts it from
 * watchparty's prefs (`room/RoomShell.tsx`'s `useAvatarAssert`); this harness's
 * edge answers no `whoami`, so the spec makes the same call that hop makes —
 * `POST /api/rooms/:id/identity` with the match id, which the server resolves to
 * its room and carries to the running match's seat (Q6). Their sprite server is
 * stood in for by `SPRITE`.
 */
async function wearCharacter(f: Friend, origin: string, matchId: string, sprite: string): Promise<void> {
  await f.context.route('**/watchparty/media/sprites/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SPRITE }));
  const res = await f.context.request.post(`${origin}/cardtable/api/rooms/${matchId}/identity`, { data: { avatarId: sprite } });
  expect(res.ok(), `${f.name}: the room takes her character (${res.status()} ${await res.text()})`).toBe(true);
}

const trigger = (f: Friend): Locator => f.page.getByTestId('seat-settings');
const popover = (f: Friend): Locator => f.page.getByTestId('settings');

/** Somewhere on the page that is neither the face nor the popover, and presses nothing. */
async function mouseAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
}

interface Look {
  /** Painted pixels in the mark box's corners, outside the circle, against the untouched face. */
  corners: number;
  /** Painted pixels in the ring band just outside the circle (where a circular focus ring goes). */
  band: number;
  file: string;
}

/** The mark's own square, in page pixels. */
async function markBox(f: Friend): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await trigger(f).locator('.face__art').boundingBox();
  if (box === null) throw new Error(`${f.name}: no mark on the screen`);
  return box;
}

/** Every box over the mark that could paint: the button, the mark, the ring. */
async function painters(f: Friend): Promise<string> {
  return trigger(f).evaluate((btn) => {
    const els = [btn, ...Array.from(btn.querySelectorAll('.face__art, .seat__ring'))];
    const one = (el: Element): string => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ').join('.')} ${Math.round(r.width)}x${Math.round(r.height)} outline=${s.outlineStyle}/${s.outlineWidth}/${s.outlineColor}+${s.outlineOffset} radius=${s.borderRadius} bg=${s.backgroundColor} shadow=${s.boxShadow} clip=${s.clipPath}`;
    };
    const active = document.activeElement;
    const focus = active === null ? 'none' : `${active.tagName.toLowerCase()}[testid=${active.getAttribute('data-testid') ?? '-'}]`;
    return `focus=${focus} focusVisible=${btn.matches(':focus-visible')} | ${els.map(one).join(' | ')}`;
  });
}

/** One state of the face, screenshot and all, against the untouched face. */
async function look(f: Friend, state: string, base: Uint8Array | null, box: { x: number; y: number; width: number; height: number }): Promise<{ png: Buffer; look: Look }> {
  const clip = { x: box.x - PAD, y: box.y - PAD, width: box.width + 2 * PAD, height: box.height + 2 * PAD };
  await f.page.waitForTimeout(300); // transitions settle
  const png = await f.page.screenshot({ clip });
  // The popover (and its shadow) can sit inside the clip: what it covers is not the face.
  const over = await popover(f)
    .boundingBox()
    .catch(() => null);
  const skip = over === null ? null : { x0: over.x - clip.x - SHADOW, y0: over.y - clip.y - SHADOW, x1: over.x + over.width - clip.x + SHADOW, y1: over.y + over.height - clip.y + SHADOW };
  mkdirSync(SHOTS, { recursive: true });
  const file = resolve(SHOTS, `${test.info().repeatEachIndex}-${f.name}-${state}.png`);
  writeFileSync(file, png);
  const counted = await f.page.evaluate(
    async ({ b64, baseB64, pad, ring, delta, skip }) => {
      const pixels = async (data: string): Promise<{ d: Uint8ClampedArray; w: number; h: number }> => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        return { d: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
      };
      const now = await pixels(b64);
      if (baseB64 === null) return { corners: 0, band: 0 };
      const was = await pixels(baseB64);
      const cx = now.w / 2;
      const cy = now.h / 2;
      const r = now.w / 2 - pad;
      let corners = 0;
      let band = 0;
      for (let y = 0; y < now.h; y += 1) {
        for (let x = 0; x < now.w; x += 1) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const dist = Math.hypot(dx, dy);
          if (skip !== null && x >= skip.x0 && x < skip.x1 && y >= skip.y0 && y < skip.y1) continue;
          const i = (y * now.w + x) * 4;
          const moved = Math.abs(now.d[i]! - was.d[i]!) + Math.abs(now.d[i + 1]! - was.d[i + 1]!) + Math.abs(now.d[i + 2]! - was.d[i + 2]!);
          if (moved < delta) continue;
          // The diagonal corners only: the life number sits below the mark's middle.
          if (Math.abs(dx) > r * 0.6 && Math.abs(dy) > r * 0.6 && dist > r + ring) corners += 1;
          else if (dist > r + 1 && dist <= r + ring) band += 1;
        }
      }
      return { corners, band };
    },
    { b64: png.toString('base64'), baseB64: base === null ? null : Buffer.from(base).toString('base64'), pad: PAD, ring: RING, delta: DELTA, skip },
  );
  console.log(`[w69-avatar] ${f.name} ${state}: corners=${counted.corners} band=${counted.band} file=${file} | ${await painters(f)}`);
  return { png, look: { ...counted, file } };
}

/** Keyboard focus on the face draws a round ring around the mark, and nothing in its corners. */
async function keyboardFocus(f: Friend, box: { x: number; y: number; width: number; height: number }, base: Uint8Array, state: string): Promise<void> {
  await trigger(f).focus();
  expect(await trigger(f).evaluate((b) => b.matches(':focus-visible')), `${f.name}: keyboard focus on the face is visible focus`).toBe(true);
  const l = (await look(f, state, base, box)).look;
  expect(l.band, `${f.name} ${state}: keyboard focus draws a ring around the mark — ${l.file}`).toBeGreaterThan(20);
  expect(l.corners, `${f.name} ${state}: and the ring is round — ${l.file}`).toBe(0);
}

/** Opens and closes `f`'s settings every way they close; the face's corners stay untouched throughout. */
async function everyWay(f: Friend): Promise<void> {
  const page = f.page;
  await expect(trigger(f)).toBeVisible({ timeout: 30_000 });
  await mouseAway(page);
  await page.waitForTimeout(500);
  const box = await markBox(f);
  const base = (await look(f, '0-untouched', null, box)).png;
  const states: [string, Look][] = [];
  const at = async (state: string): Promise<void> => {
    states.push([state, (await look(f, state, base, box)).look]);
  };
  const press = async (): Promise<void> => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  // A click opens it; the pointer is still on the face, as the operator's is.
  await press();
  await expect(popover(f), `${f.name}: the face opens the settings`).toBeVisible();
  await at('1-open-pointer-on-face');
  await mouseAway(page);
  await at('2-open-pointer-away');

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(popover(f)).toHaveCount(0);
  await at('3-closed-by-escape');

  // A press elsewhere closes it: the seat's own panel just left of the face, which presses nothing.
  await press();
  await expect(popover(f)).toBeVisible();
  await page.mouse.click(box.x - 12, box.y + box.height / 2);
  await expect(popover(f)).toHaveCount(0);
  await mouseAway(page);
  await at('4-closed-by-click-away');

  // The face again closes it.
  await press();
  await expect(popover(f)).toBeVisible();
  await press();
  await expect(popover(f)).toHaveCount(0);
  await mouseAway(page);
  await at('5-closed-by-face-again');
  // The face keeps focus from that press; the next key the player presses makes it keyboard focus.
  await page.keyboard.press('Escape');
  await at('5b-then-a-key');

  // The popover's own close button.
  await press();
  await expect(popover(f)).toBeVisible();
  await page.getByTestId('settings-close').click();
  await expect(popover(f)).toHaveCount(0);
  await mouseAway(page);
  await at('6-closed-by-close-button');

  for (const [state, l] of states) {
    expect(l.corners, `${f.name} ${state}: nothing paints the mark's square corners (the face stays a circle) — ${l.file}`).toBe(0);
  }

  // A keyboard user still sees where focus is: a round ring around the mark — on their turn too, outside the lit ring.
  await page.keyboard.press('Escape');
  await keyboardFocus(f, box, base, '7-keyboard-focus');
  await trigger(f).evaluate((b) => (b as HTMLElement).blur());
  // Their turn, whatever Forge's turn is right now: the seat's own attribute, which is all `card.css` reads.
  await trigger(f).evaluate((b) => b.closest('[data-testid="player"]')!.setAttribute('data-active', ''));
  const lit = (await look(f, '8-turn-ring-lit', null, box)).png;
  await keyboardFocus(f, box, lit, '9-keyboard-focus-turn-ring-lit');
  await trigger(f).evaluate((b) => (b as HTMLElement).blur());
  await trigger(f).evaluate((b) => b.closest('[data-testid="player"]')!.removeAttribute('data-active'));
}

test(titled("your own face stays a circle when it opens and closes the settings, with a character and with the drawn mark"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await wearCharacter(alice, stack.origin, matchId, 'rogue');
    await expect(trigger(alice).getByTestId('seat-avatar'), "alice's face is her character").toBeVisible({ timeout: 30_000 });
    await expect(trigger(alice).getByTestId('seat-avatar')).toHaveJSProperty('complete', true);
    await expect(trigger(bob).locator('svg.face__art'), "bob's face is the drawn mark").toBeVisible();
    await everyWay(alice);
    await everyWay(bob);
  } finally {
    await stack.stop();
  }
});
