// @vitest-environment jsdom
/*
 * `handover-report.ts`: the telemetry a played card's two hand-overs send, on either screen —
 * the payload the server logs, and the copies-on-screen count behind `doubled`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientEventSchema } from '@hadoku/shared';

import { GLIDE_MS } from '../motion.ts';
import { drawnCopies, handoverData, PRESENCE_CARD_ATTR, reportHandover, visibleCopies, type HandoverFacts } from './handover-report.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

const facts: HandoverFacts & { readonly to: { x: number; y: number } | null } = {
  screen: 'receiver',
  card: 121,
  how: 'stack',
  from: { x: 440.4, y: 275.2 },
  to: { x: 454, y: 280 },
  glideStartedAt: 1_000,
  releasedAt: 900,
  stackFrameAt: 1_150,
  motion: true,
};

function drawn(el: HTMLElement, x: number, y: number): HTMLElement {
  el.getBoundingClientRect = () => ({ left: x - 30, top: y - 42, width: 60, height: 84, right: x + 30, bottom: y + 42, x: x - 30, y: y - 42, toJSON: () => null }) as DOMRect;
  document.body.append(el);
  return el;
}

describe('handoverData', () => {
  it('measures the stand-in against its replacement: rounded centres, the distance, how far into the glide, and since the release and the stack frame', () => {
    expect(handoverData(facts, ['placed'], 1_200)).toEqual({
      screen: 'receiver',
      how: 'stack',
      motion: true,
      doubled: false,
      card: 121,
      fromX: 440,
      fromY: 275,
      toX: 454,
      toY: 280,
      dist: 14,
      glideMs: 200,
      glideDone: false,
      msSinceRelease: 300,
      msSinceStackFrame: 50,
    });
    expect(handoverData(facts, ['placed'], 1_000 + GLIDE_MS).glideDone, 'a glide of GLIDE_MS is done').toBe(true);
  });

  it('leaves out what is not known — no stand-in drawn, no glide, no stack frame — and stays a valid client event', () => {
    const data = handoverData({ ...facts, how: 'motion-off', from: null, glideStartedAt: null, stackFrameAt: null }, ['zone:battlefield'], 1_200);
    expect(data).toEqual({ screen: 'receiver', how: 'motion-off', motion: true, doubled: false, card: 121, toX: 454, toY: 280, msSinceRelease: 300 });
    expect(ClientEventSchema.safeParse({ matchId: 'm', kind: 'landing', data: handoverData(facts, ['zone:battlefield', 'placed', 'back'], 1_200) }).success, 'within the schema’s 16 flat fields').toBe(true);
    expect(ClientEventSchema.safeParse({ matchId: 'm', kind: 'handover', data }).success).toBe(true);
  });
});

describe('visibleCopies', () => {
  it('counts the card in its row, its stack card and a stand-in — never one that is hidden or still pending', () => {
    const zone = document.createElement('ul');
    zone.setAttribute('data-zone', 'battlefield');
    document.body.append(zone);
    const field = drawn(document.createElement('li'), 454, 280);
    field.setAttribute('data-board-card', '121');
    zone.append(field);
    expect(visibleCopies(document, 121)).toBe(1);
    const placed = drawn(document.createElement('div'), 454, 280);
    placed.setAttribute('data-placed-card', '121');
    expect(visibleCopies(document, 121), 'the stack card still up beside the card in its row').toBe(2);
    placed.style.visibility = 'hidden';
    expect(visibleCopies(document, 121)).toBe(1);
    placed.style.visibility = '';
    placed.setAttribute('data-placed-pending', '');
    expect(visibleCopies(document, 121)).toBe(1);
    const back = drawn(document.createElement('div'), 450, 282);
    back.className = 'presence__back';
    back.setAttribute('data-waiting', '');
    expect(visibleCopies(document, 121), 'a back nobody has named is another card in flight, not this one').toBe(1);
    back.setAttribute(PRESENCE_CARD_ATTR, '121');
    expect(visibleCopies(document, 121), 'the receiver’s back for this card still standing in').toBe(2);
    expect(visibleCopies(document, 7), 'another card’s copies are not this one’s').toBe(0);
    const flight = drawn(document.createElement('div'), 300, 200);
    flight.className = 'presence__handoff';
    flight.setAttribute(PRESENCE_CARD_ATTR, '7');
    expect(visibleCopies(document, 121), 'another card’s flight landing meanwhile').toBe(2);
    expect(drawnCopies(document, 7)).toEqual(['handoff@300,200']);
  });

  it('names a resolved spell’s stack card fading out, and does not call it a second copy', () => {
    const zone = document.createElement('ul');
    zone.setAttribute('data-zone', 'graveyard');
    document.body.append(zone);
    const card = drawn(document.createElement('li'), 40, 600);
    card.setAttribute('data-board-card', '15');
    zone.append(card);
    const placed = drawn(document.createElement('div'), 461, 500);
    placed.setAttribute('data-placed-card', '15');
    placed.setAttribute('data-placed-leaving', '');
    const copies = drawnCopies(document, 15);
    expect(copies).toEqual(['zone:graveyard', 'placed:leaving']);
    expect(handoverData({ ...facts, card: 15 }, copies, 1_200)).toMatchObject({ doubled: false, copies: 'zone:graveyard,placed:leaving' });
    placed.removeAttribute('data-placed-leaving');
    expect(handoverData({ ...facts, card: 15 }, drawnCopies(document, 15), 1_200).doubled, 'still on the stack: two copies').toBe(true);
  });
});

describe('reportHandover', () => {
  it('reports once, on the next frame, with doubled read off what that frame draws', async () => {
    const report = vi.fn();
    const field = drawn(document.createElement('div'), 454, 280);
    field.setAttribute('data-placed-card', '121');
    const ghost = drawn(document.createElement('div'), 454, 280);
    ghost.setAttribute('data-cast-ghost', '121');
    // The replacement is measured on the report's frame: a stack card drawn this instant has no box yet.
    const placed = document.createElement('div');
    document.body.append(placed);
    reportHandover(report, 'landing', document, { ...facts, screen: 'caster', how: 'swap', to: placed });
    drawn(placed, 454, 280);
    expect(report, 'not before the frame').not.toHaveBeenCalled();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toBe('landing');
    expect(report.mock.calls[0]![1]).toMatchObject({ screen: 'caster', how: 'swap', card: 121, doubled: true, copies: 'placed,ghost', toX: 454, toY: 280 });
  });

  it('sends nothing without a reporter', () => {
    expect(() => reportHandover(undefined, 'handover', document, facts)).not.toThrow();
  });
});
