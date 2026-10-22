/*
 * Where a pod's waiting packs go (`pack-queue.ts`): along the arrow into the
 * seat where it holds four, anywhere near its head where it does not. Measured
 * on the ring's own geometry, the way `SeatBar` measures a real table: 40px
 * faces with a name line under each, in a 264px ring.
 */
import { describe, expect, it } from 'vitest';

import { CLEAR, IN_VIEW, PACK, packSlot, pileRoom, ring, type Room } from './pack-queue.ts';

const PX = 264 / 100;

/** A pod of `n` passing left, seat 0 at the bottom, the arrow into seat 0 lit. */
function pod(n: number): Room & { line: (at: number) => { x: number; y: number }[] } {
  const t = ring();
  const s = (at: number) => (at * t.length) / n;
  const faces = Array.from({ length: n }, (_, at) => t.at(s(at)));
  const arrows = Array.from({ length: n }, (_, at) => ({ points: t.points(s(at) + CLEAR, s(at + 1) - CLEAR), width: at === n - 1 ? 1.2 : 0.9 }));
  const inbound = faces.map((_, at) => (at - 1 + n) % n);
  return {
    faces,
    sides: faces.map((f) => (Math.abs(f.x - 50) < 1 ? (f.y > 50 ? 1 : -1) : f.x < 50 ? 1 : -1)),
    heads: faces.map((_, at) => t.at(s(at) - CLEAR)),
    faceHalf: (20 * 1.1) / PX,
    names: faces.map((f) => ({ left: f.x - 24 / PX, top: f.y + 22 / PX, right: f.x + 24 / PX, bottom: f.y + 35 / PX })),
    centre: { left: 112 / PX, top: 112 / PX, right: 152 / PX, bottom: 136 / PX },
    arrows,
    inbound,
    hub: t.centre,
    bounds: { left: -9 / PX, top: -9 / PX, right: 273 / PX, bottom: 273 / PX },
    line: (at) => arrows[inbound[at]!]!.points,
  };
}

/** How far `p` is from a polyline, and the polyline's direction of travel there, in degrees. */
function nearest(p: { x: number; y: number }, line: readonly { x: number; y: number }[]): { d: number; heading: number; k: number } {
  let best = { d: Infinity, heading: 0, k: 0 };
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]!, b = line[k]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const f = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L)));
    const d = Math.hypot(a.x + (b.x - a.x) * f - p.x, a.y + (b.y - a.y) * f - p.y);
    if (d < best.d) best = { d, heading: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, k };
  }
  return best;
}

describe('a pile is a queue along the arrow into its seat', () => {
  it('in a pod of four, every seat’s four packs line its arrow’s outside, stepping back from the head, each turned with it', () => {
    const room = pod(4);
    const piles = pileRoom(room);
    expect(piles.map((p) => p.along)).toEqual(['arrow', 'arrow', 'arrow', 'arrow']);
    piles.forEach((pile, at) => {
      const face = room.faces[at]!;
      const sx = room.sides[at]!;
      const line = room.line(at);
      const width = room.arrows[room.inbound[at]!]!.width;
      const spots = pile.places.map((p) => ({ x: face.x + p.x * sx * PACK, y: face.y + p.y * PACK, turn: p.turn * sx }));
      const hub = room.hub;
      let last = -1;
      for (const [i, spot] of spots.entries()) {
        const { d, heading, k } = nearest(spot, line);
        // Against the stroke: clear of it, and no further than a pack's length past it.
        expect(d, `seat ${at} pack ${i} off its arrow`).toBeGreaterThan(width / 2 + (PACK * 0.5));
        expect(d, `seat ${at} pack ${i} off its arrow`).toBeLessThan(width / 2 + PACK * 2.2);
        // On the ring's outside.
        expect(Math.hypot(spot.x - hub.x, spot.y - hub.y), `seat ${at} pack ${i} outside`).toBeGreaterThan(Math.hypot(line[k]!.x - hub.x, line[k]!.y - hub.y));
        // Turned with the arrow (a back is the same either way up).
        const off = ((((spot.turn - heading) % 180) + 270) % 180) - 90;
        expect(Math.abs(off), `seat ${at} pack ${i} turned with its arrow`).toBeLessThan(6);
        // Each further back from the head than the one before.
        const back = line.length - 1 - k;
        expect(back, `seat ${at} pack ${i} behind the one before`).toBeGreaterThanOrEqual(last);
        last = back;
      }
      expect(Math.hypot(spots[3]!.x - room.heads[at]!.x, spots[3]!.y - room.heads[at]!.y)).toBeGreaterThan(Math.hypot(spots[0]!.x - room.heads[at]!.x, spots[0]!.y - room.heads[at]!.y));
    });
  });

  it('where an arrow is shorter than four packs (a pod of eight), the queue still lines it: as many as fit against the stroke, the rest in files further out, each turned with the arrow', () => {
    const room = pod(8);
    const piles = pileRoom(room);
    const along = piles.flatMap((pile, at) => (pile.along === 'arrow' ? [at] : []));
    expect(along.length, 'most seats queue on their arrow').toBeGreaterThanOrEqual(5);
    for (const at of along) {
      const pile = piles[at]!;
      const face = room.faces[at]!;
      const sx = room.sides[at]!;
      const line = room.line(at);
      const width = room.arrows[room.inbound[at]!]!.width;
      const spots = pile.places.map((p) => ({ x: face.x + p.x * sx * PACK, y: face.y + p.y * PACK, turn: p.turn * sx }));
      const offs = spots.map((spot) => Math.hypot(spot.x - room.hub.x, spot.y - room.hub.y));
      for (const [i, spot] of spots.entries()) {
        // Turned with the ring the arrow runs on, also where a file runs on past its tail.
        const heading = (Math.atan2(spot.y - room.hub.y, spot.x - room.hub.x) * 180) / Math.PI + 90;
        expect(offs[i]!, `seat ${at} pack ${i} outside its arrow`).toBeGreaterThan(Math.hypot(line[0]!.x - room.hub.x, line[0]!.y - room.hub.y) + width / 2);
        const off = ((((spot.turn - heading) % 180) + 270) % 180) - 90;
        expect(Math.abs(off), `seat ${at} pack ${i} turned with its arrow`).toBeLessThan(6);
        // A pack is never in a nearer file than the one before it: the queue only moves out.
        if (i > 0) expect(offs[i]!, `seat ${at} pack ${i} in the same file or further out`).toBeGreaterThan(offs[i - 1]! - 0.5);
      }
      expect(new Set(offs.map((o) => Math.round(o * 2))).size, `seat ${at} needs more than one file`).toBeGreaterThan(1);
    }
  });

  it('jostles a queue only a little as it fills: a crowded queue, still a queue', () => {
    const pile = pileRoom(pod(4))[0]!;
    for (let depth = 1; depth <= IN_VIEW; depth++) {
      for (let i = 0; i < depth; i++) {
        const slot = packSlot(i, depth, pile);
        expect(Math.abs(slot.r - pile.places[i]!.turn), `depth ${depth} pack ${i}`).toBeLessThanOrEqual(depth <= 2 ? 2 : 8);
      }
    }
  });
});
