/*
 * The transport envelope.
 *
 * Three properties are load-bearing and each is asserted as a NEGATIVE, because
 * every one of them is a rule about what must be impossible rather than about
 * what works:
 *
 *   1. A client cannot state its own identity — `participantId` on a pick is a
 *      parse ERROR, not a stripped field.
 *   2. The envelope's cursor cannot disagree with the payload's. There is one
 *      `{epoch, seq}` pair on the wire, not two.
 *   3. Nothing on an envelope can carry another seat's cards, and nothing can
 *      carry an image — the payload rules apply through the wrapper.
 */

import { describe, expect, it } from 'vitest';
import { classifySeq, needsResync } from '@wolffm/rooms-protocol';

import type { DraftCard, DraftView } from './draft.ts';
import {
  ClientMessageSchema,
  DRAFT_CHANNEL,
  PICK_REJECTION_CODES,
  TRANSPORT_ERROR_CODES,
  asSeqCursor,
  carriesView,
  cursorOf,
  errorMessage,
  isPickRejection,
  joinDraft,
  leaveDraft,
  parseClientMessage,
  parseServerMessage,
  pickCard,
  resyncRequest,
  safeParseClientMessage,
  safeParseServerMessage,
  stateMessage,
  updateMessage,
} from './wire.ts';

function card(id: string, name: string): DraftCard {
  return {
    cardId: id,
    name,
    manaCost: ['1', 'U'],
    manaValue: 2,
    colors: ['U'],
    typeLine: 'Instant',
    oracleText: 'Draw a card.',
    setCode: 'tst',
    collectorNumber: '1',
    rarity: 'common',
  };
}

/** A minimal, legal seat payload: 2 seats, one human at 0, one bot at 1. */
function view(overrides: Partial<DraftView> = {}): DraftView {
  return {
    draftId: 'draft:wire-test',
    epoch: 'e1',
    seq: 7,
    packNumber: 1,
    pickNumber: 2,
    packCount: 3,
    packSize: 15,
    passDirection: 'left',
    capacity: 2,
    seats: [
      { id: 0, occupant: { kind: 'human', participantId: 'dev:you' }, displayName: 'Drafter', pickedCount: 1, queueDepth: 0 },
      { id: 1, occupant: { kind: 'bot', botId: 'bot:1' }, displayName: 'Bot 1', pickedCount: 1, queueDepth: 0 },
    ],
    waitingOn: [0],
    viewer: { kind: 'seat', seatId: 0, pack: [card('c2', 'Counterspell')], pool: [card('c1', 'Brainstorm')] },
    ...overrides,
  };
}

describe('event names', () => {
  it('is one channel per direction, not one per message type', () => {
    expect(DRAFT_CHANNEL.clientToServer).toBe('draft:c2s');
    expect(DRAFT_CHANNEL.serverToClient).toBe('draft:s2c');
    expect(DRAFT_CHANNEL.clientToServer).not.toBe(DRAFT_CHANNEL.serverToClient);
  });
});

describe('client → server', () => {
  it('accepts join, leave, pick and resync', () => {
    expect(parseClientMessage(joinDraft('d1')).type).toBe('join');
    expect(parseClientMessage(leaveDraft('d1')).type).toBe('leave');
    expect(parseClientMessage(pickCard('d1', 'c2')).type).toBe('pick');
    expect(parseClientMessage(resyncRequest('d1', { epoch: 'e1', seq: 4 })).type).toBe('resync');
    expect(parseClientMessage(resyncRequest('d1', null)).type).toBe('resync');
  });

  it('REJECTS a client that supplies its own identity', () => {
    const result = safeParseClientMessage({
      type: 'pick',
      draftId: 'd1',
      cardId: 'c2',
      participantId: 'fk:someone-else',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not merely "an error" — the message has to say what the mistake was.
    const text = result.errors.map((e) => `${e.path} ${e.message}`).join('\n');
    expect(text).toContain('participantId');
    expect(text).toMatch(/never supplies its own identity/);
  });

  it('does not SILENTLY STRIP an extra key — the strictness is the mechanism', () => {
    // Zod's default would parse this clean and hand the server a seatId-free
    // object, leaving the raw one available to anything that kept a reference.
    const parsed = ClientMessageSchema.safeParse({ type: 'join', draftId: 'd1', seatId: 3 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty draft id and an empty card id', () => {
    expect(safeParseClientMessage({ type: 'join', draftId: '' }).ok).toBe(false);
    expect(safeParseClientMessage({ type: 'pick', draftId: 'd1', cardId: '' }).ok).toBe(false);
  });

  it('rejects junk without a cast', () => {
    for (const junk of [null, 42, 'pick', [], {}, { type: 'nope' }]) {
      expect(safeParseClientMessage(junk).ok).toBe(false);
    }
    expect(() => parseClientMessage({ type: 'nope' })).toThrow(/not a valid ClientMessage/);
  });

  it('has no message shape that could carry a seat, a name or a token', () => {
    const json = JSON.stringify([
      joinDraft('d1'),
      leaveDraft('d1'),
      pickCard('d1', 'c2'),
      resyncRequest('d1', { epoch: 'e1', seq: 4 }),
    ]);
    for (const forbidden of ['participantId', 'seatId', 'displayName', 'token']) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('server → client', () => {
  it('derives the cursor from the payload, so the two cannot disagree', () => {
    const v = view();
    expect(stateMessage(v).cursor).toEqual({ epoch: 'e1', seq: 7 });
    expect(updateMessage(v).cursor).toEqual(cursorOf(v));
  });

  it('REJECTS an envelope whose cursor disagrees with its payload', () => {
    const bad = { ...updateMessage(view()), cursor: { epoch: 'e1', seq: 9 } };
    const result = safeParseServerMessage(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain('$.cursor.seq');
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/one cursor, not two/);

    const wrongEpoch = { ...updateMessage(view()), cursor: { epoch: 'e2', seq: 7 } };
    const second = safeParseServerMessage(wrongEpoch);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.errors.map((e) => e.path)).toContain('$.cursor.epoch');
  });

  it('runs the payload rules THROUGH the wrapper — D13 images are rejected', () => {
    const leaky = view();
    const pack = (leaky.viewer as { pack: DraftCard[] }).pack;
    (pack[0] as unknown as Record<string, unknown>).image_uris = { normal: 'https://cards.scryfall.io/x.jpg' };
    const result = safeParseServerMessage(updateMessage(leaky));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.map((e) => `${e.path} ${e.message}`).join('\n');
    expect(text).toMatch(/image reference \(D13\)/);
    // The path is rewritten through the envelope so it is findable.
    expect(text).toContain('$.view.viewer.pack[0].image_uris');
  });

  /**
   * The live incident (2026-10-22): a realistic booster's foil card
   * (`PaperCard.isFoil()`, carried onto the wire by `DraftCardSchema.foil`)
   * made EVERY state message holding it fail `safeParseServerMessage` —
   * `semantics.ts`'s `checkCard` runs over the RAW payload, by design,
   * because Zod strips an unknown key before a hand-rolled check ever sees
   * it (this file's own header), so `draft.ts` growing a field means
   * nothing until `semantics.ts`'s `CARD_FIELDS` allowlist grows with it.
   * `apps/ui/src/draft/socket.ts`'s `ingest()` drops a schema-invalid
   * message silently (counted in `stats.invalid`, nothing on screen), which
   * is why this looked exactly like the production incident
   * `docs/planning/wave74-2026-10-21.md` logged as an unconfirmed stall: a
   * draft room whose dealt packs happen to include a foil freezes every
   * seat the instant that foil's own pack/pool state is sent, with no
   * error anywhere — reproduced live via `draft-sets.spec.ts`'s "a custom
   * plan..." test, which deals enough ALA/ARB realistic packs (~21% foil
   * chance each) that one shows up in nearly every run.
   */
  it('a card’s own foil (D22) is a known field, not a leak — unlike a face carrying one', () => {
    const foiled = view();
    const pack = (foiled.viewer as { pack: DraftCard[] }).pack;
    pack[0] = { ...pack[0]!, foil: true };
    const result = safeParseServerMessage(updateMessage(foiled));
    expect(result.ok).toBe(true);
    if (result.ok) expect(((result.value as { view: DraftView }).view.viewer as { pack: DraftCard[] }).pack[0]!.foil).toBe(true);

    // A FACE carrying foil is still a real finding — only the physical card is foil or not.
    const facedFoil = view();
    const facedPack = (facedFoil.viewer as { pack: DraftCard[] }).pack;
    const back = { ...card('x2', 'Some Back'), foil: true } as Record<string, unknown>;
    delete back.cardId;
    facedPack[0] = { ...facedPack[0]!, faces: [back as never] };
    const rejected = safeParseServerMessage(updateMessage(facedFoil));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.errors.map((e) => e.path)).toContain('$.view.viewer.pack[0].faces[0].foil');
  });

  it('carries a card’s other faces, and holds each face to a card’s own field rules', () => {
    const faced = view();
    const pack = (faced.viewer as { pack: DraftCard[] }).pack;
    const back = { ...card('x2', 'Etali, Primal Sickness'), scryfallId: '95c14c4d-6c16-4826-8d93-d89ad04aee09#back' } as Record<string, unknown>;
    delete back.cardId;
    pack[0] = { ...pack[0]!, faces: [back as never] };
    const ok = safeParseServerMessage(updateMessage(faced));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(((ok.value as { view: DraftView }).view.viewer as { pack: DraftCard[] }).pack[0]!.faces?.map((f) => f.name)).toEqual(['Etali, Primal Sickness']);

    back.image_uris = { normal: 'https://cards.scryfall.io/x.jpg' };
    const leaky = safeParseServerMessage(updateMessage(faced));
    expect(leaky.ok).toBe(false);
    if (leaky.ok) return;
    expect(leaky.errors.map((e) => e.path)).toContain('$.view.viewer.pack[0].faces[0].image_uris');
  });

  it('runs the hidden-information rules through the wrapper too', () => {
    const leaky = view();
    (leaky.seats[1] as unknown as Record<string, unknown>).picked = [card('x1', 'Ancestral Recall')];
    const result = safeParseServerMessage(updateMessage(leaky));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain('$.view.seats[1].picked');
  });

  it('carries a full-state response, optionally naming the cube', () => {
    const snap = stateMessage(view(), { name: 'Vintage Cube', size: 540 });
    expect(parseServerMessage(snap).type).toBe('state');
    expect(snap.cube).toEqual({ name: 'Vintage Cube', size: 540 });
    // And works with no cube at all — the server may not know one.
    expect(parseServerMessage(stateMessage(view()))).toBeTruthy();
  });

  it('distinguishes a payload-bearing message from a rejection', () => {
    expect(carriesView(stateMessage(view()))).toBe(true);
    expect(carriesView(updateMessage(view()))).toBe(true);
    expect(carriesView(errorMessage({ epoch: 'e1', seq: 7 }, 'not-seated'))).toBe(false);
  });
});

describe('errors are values', () => {
  it('can represent every PickRejection the engine returns', () => {
    // Pinned literally: `packages/draft/src/engine.ts` owns this union and this
    // package cannot import it (the dependency runs the other way).
    expect([...PICK_REJECTION_CODES]).toEqual([
      'draft-complete',
      'unknown-seat',
      'empty-pack',
      'already-picked',
      'card-not-in-pack',
    ]);
    for (const code of PICK_REJECTION_CODES) {
      const msg = errorMessage({ epoch: 'e1', seq: 7 }, code);
      expect(parseServerMessage(msg)).toBeTruthy();
      expect(isPickRejection(code)).toBe(true);
    }
  });

  it('carries the transport-level codes too, and tells them apart', () => {
    expect([...TRANSPORT_ERROR_CODES]).toEqual([
      'not-seated',
      'rate-limited',
      'unknown-draft',
      'not-your-turn',
      'malformed-message',
    ]);
    for (const code of TRANSPORT_ERROR_CODES) {
      expect(parseServerMessage(errorMessage({ epoch: 'e1', seq: 7 }, code))).toBeTruthy();
      expect(isPickRejection(code)).toBe(false);
    }
  });

  it('refuses a free-string error with no code', () => {
    expect(safeParseServerMessage({ type: 'error', cursor: { epoch: 'e1', seq: 7 }, error: 'nope' }).ok).toBe(false);
    expect(
      safeParseServerMessage({
        type: 'error',
        cursor: { epoch: 'e1', seq: 7 },
        error: { code: 'something-went-wrong' },
      }).ok,
    ).toBe(false);
  });

  it('cannot carry a card in a rejection', () => {
    const smuggled = {
      type: 'error',
      cursor: { epoch: 'e1', seq: 7 },
      error: { code: 'card-not-in-pack', card: card('c9', 'Black Lotus') },
    };
    expect(safeParseServerMessage(smuggled).ok).toBe(false);
  });
});

describe('the cursor is rooms-protocol’s, not a lookalike', () => {
  it('feeds classifySeq directly', () => {
    const first = updateMessage(view({ seq: 1 }));
    const second = updateMessage(view({ seq: 2 }));
    expect(classifySeq(null, asSeqCursor(first.cursor))).toBe('ok');
    expect(classifySeq(asSeqCursor(first.cursor), asSeqCursor(second.cursor))).toBe('ok');
    expect(classifySeq(asSeqCursor(second.cursor), asSeqCursor(first.cursor))).toBe('duplicate');
    expect(classifySeq(asSeqCursor(first.cursor), { epoch: 'e1', seq: 9 })).toBe('gap');
    expect(classifySeq(asSeqCursor(first.cursor), { epoch: 'e2', seq: 2 })).toBe('epoch-change');
  });

  it('an error envelope classifies as a duplicate, so it never asks for a resync', () => {
    const applied = { epoch: 'e1', seq: 7 };
    const err = errorMessage(applied, 'already-picked');
    const verdict = classifySeq(applied, asSeqCursor(err.cursor));
    expect(verdict).toBe('duplicate');
    expect(needsResync(verdict)).toBe(false);
  });

  it('rejects seq 0 — a payload is never seq 0', () => {
    expect(safeParseServerMessage({ ...updateMessage(view()), cursor: { epoch: 'e1', seq: 0 } }).ok).toBe(false);
  });
});

describe('an update says whether it is self-contained', () => {
  it('carries the marker only when the builder is told, and it survives a parse', () => {
    expect(updateMessage(view())).not.toHaveProperty('carries');
    const full = parseServerMessage(updateMessage(view(), 'full-state'));
    expect(full.type === 'update' && full.carries).toBe('full-state');
    const delta = parseServerMessage(updateMessage(view(), 'delta'));
    expect(delta.type === 'update' && delta.carries).toBe('delta');
    const unmarked = parseServerMessage(updateMessage(view()));
    expect(unmarked.type === 'update' && unmarked.carries).toBeUndefined();
  });

  it('refuses a marker that is neither', () => {
    expect(safeParseServerMessage({ ...updateMessage(view()), carries: 'partial' }).ok).toBe(false);
  });

  it('does not relax the one-cursor rule — a full-state envelope still agrees with its view', () => {
    const bad = { ...updateMessage(view(), 'full-state'), cursor: { epoch: 'e1', seq: 9 } };
    expect(safeParseServerMessage(bad).ok).toBe(false);
  });

  it('leaves the cursor exactly as classifySeq sees it — a jump is still a gap', () => {
    const next = updateMessage(view({ seq: 14 }), 'full-state');
    expect(classifySeq({ epoch: 'e1', seq: 7 }, asSeqCursor(next.cursor))).toBe('gap');
  });
});
