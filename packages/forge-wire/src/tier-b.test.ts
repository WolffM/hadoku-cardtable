/*
 * Tier B — 23 methods that carry entity references.
 *
 * The generated battery again, then the claims that make this tier more
 * than a transcription:
 *
 *   1. A reference's KIND is load-bearing. Handing `selectPlayer` a card id is
 *      a parse error, because that is the whole reason the kind travels with
 *      the id instead of a bare int crossing the wire.
 *   2. `YieldUpdate` has exactly twelve arms and they are closed.
 *   3. `openZones` carries a player SET, not Forge's `Map<PlayerView, Object>`.
 *   4. `sideboard` uses `@hadoku/deck`'s pool model — asserted at RUNTIME by
 *      pushing parsed wire entries through that package and writing a `.dck`,
 *      not just by a type alias that a refactor could quietly widen.
 *   5. `setHighlighted` carries a GameEntityView and a boolean — not a card
 *      list, and not a replacement set.
 */

import { describe, expect, it } from 'vitest';
import { newDeck, toDeckFile, totalCards, writeDck } from '@hadoku/deck';

import { CLIENT_FRAME_EXAMPLES, SERVER_FRAME_EXAMPLES } from './examples.ts';
import { malformedTable } from './malformed.ts';
import { safeParseClientFrame, safeParseServerFrame } from './envelope.ts';
import {
  ApplyYieldUpdateSchema,
  OpenZonesSchema,
  SelectPlayerSchema,
  SendYieldUpdateSchema,
  SetHighlightedSchema,
  SetSelectablesSchema,
  SideboardSchema,
  TIER_B_CLIENT_FRAMES,
  TIER_B_METHODS,
  YieldUpdateSchema,
} from './tier-b.ts';
import { GameEntityRefSchema } from './refs.ts';
import { asDeckEntry, flattenEntries } from './sideboard.ts';

const TIER_B = new Set<string>(TIER_B_METHODS);

const serverExamples = Object.fromEntries(
  Object.entries(SERVER_FRAME_EXAMPLES).filter(([method]) => TIER_B.has(method)),
);
const clientExamples = Object.fromEntries(
  Object.entries(CLIENT_FRAME_EXAMPLES).filter(([method]) => TIER_B.has(method)),
);

describe('Tier B — the 23 reference-carrying methods', () => {
  it('models exactly 23 methods, 20 server and 3 client', () => {
    expect(TIER_B_METHODS).toHaveLength(23);
    expect(Object.keys(serverExamples)).toHaveLength(20);
    expect(Object.keys(clientExamples)).toHaveLength(3);
  });

  it.each(Object.keys(serverExamples))('%s parses as a server frame', (method) => {
    const result = safeParseServerFrame(serverExamples[method]);
    expect(result.ok ? null : result.errors).toBeNull();
  });

  it.each(Object.keys(clientExamples))('%s parses as a client frame', (method) => {
    const result = safeParseClientFrame(clientExamples[method]);
    expect(result.ok ? null : result.errors).toBeNull();
  });

  it.each(malformedTable(serverExamples))(
    'rejects a server $method with $label',
    ({ input }) => {
      expect(safeParseServerFrame(input).ok).toBe(false);
    },
  );

  it.each(malformedTable(clientExamples))(
    'rejects a client $method with $label',
    ({ input }) => {
      expect(safeParseClientFrame(input).ok).toBe(false);
    },
  );
});

describe('Tier B — a reference’s kind is load-bearing', () => {
  it('selectPlayer refuses a card id wearing a player’s place', () => {
    const ok = SelectPlayerSchema.safeParse({
      kind: 'act',
      method: 'selectPlayer',
      player: { kind: 'player', id: 1 },
      triggerEvent: null,
    });
    expect(ok.success).toBe(true);

    const wrong = SelectPlayerSchema.safeParse({
      kind: 'act',
      method: 'selectPlayer',
      player: { kind: 'card', id: 1 },
      triggerEvent: null,
    });
    expect(wrong.success).toBe(false);
  });

  it('a bare int is not a reference', () => {
    expect(GameEntityRefSchema.safeParse(7).success).toBe(false);
    expect(GameEntityRefSchema.safeParse({ id: 7 }).success).toBe(false);
  });

  it('GameEntityView is exactly CardView or PlayerView', () => {
    expect(GameEntityRefSchema.safeParse({ kind: 'card', id: 1 }).success).toBe(true);
    expect(GameEntityRefSchema.safeParse({ kind: 'player', id: 1 }).success).toBe(true);
    expect(GameEntityRefSchema.safeParse({ kind: 'spellAbility', id: 1 }).success).toBe(false);
    expect(GameEntityRefSchema.safeParse({ kind: 'stackItem', id: 1 }).success).toBe(false);
  });
});

/**
 * Forge's twelve permitted `YieldUpdate` records, one example each. Module-level
 * because BOTH directions carry them: `applyYieldUpdate` (S→C) and, since wave
 * 24, `sendYieldUpdate` (C→S). A thirteenth arm must fail in both places, which
 * is what keeps the "closed" claim honest rather than half-checked.
 */
const YIELD_ARMS: ReadonlyArray<Record<string, unknown>> = [
  { update: 'setMarker', phaseOwner: { kind: 'player', id: 1 }, phase: 'MAIN1', atOrPastAtClick: true },
  { update: 'clearMarker', player: { kind: 'player', id: 1 } },
  { update: 'stackYield', player: { kind: 'player', id: 1 }, active: true, respectsInterrupts: false },
  { update: 'setAutoPassUntilEndOfTurn', player: { kind: 'player', id: 1 }, active: false },
  { update: 'cardAutoYield', cardKey: 'Lightning Bolt', active: true },
  { update: 'triggerDecision', storageKey: 'k', decision: 'ACCEPT' },
  { update: 'setDisableYields', disabled: true },
  { update: 'setDisableTriggers', disabled: false },
  { update: 'skipPhase', turnPlayer: { kind: 'player', id: 1 }, phase: 'UPKEEP', skip: true },
  { update: 'setYieldPref', pref: 'UI_AUTO_DECISION_MODE', value: 'true' },
  {
    update: 'seedFromClient',
    snapshot: {
      cardYields: ['a'],
      abilityYields: [],
      cardTriggerDecisions: [{ key: 'a', decision: 'DECLINE' }],
      abilityTriggerDecisions: [],
      autoYieldsDisabled: false,
      autoTriggersDisabled: false,
      skipPhases: [{ player: { kind: 'player', id: 1 }, phases: ['CLEANUP'] }],
      prefOverrides: [{ pref: 'UI_AUTO_DECISION_MODE', value: 'false' }],
    },
  },
  { update: 'clearAbilityOrders' },
];

describe('Tier B — YieldUpdate’s twelve arms', () => {
  const arms = YIELD_ARMS;

  it('covers all twelve permitted records', () => {
    expect(arms).toHaveLength(12);
  });

  it.each(arms.map((arm) => [String(arm.update), arm] as const))('%s parses', (_name, arm) => {
    const result = YieldUpdateSchema.safeParse(arm);
    expect(result.success ? null : result.error.issues).toBeNull();
  });

  it('refuses an arm Forge does not permit', () => {
    expect(YieldUpdateSchema.safeParse({ update: 'setEverything' }).success).toBe(false);
  });

  it('refuses an unknown PhaseType', () => {
    expect(
      YieldUpdateSchema.safeParse({
        update: 'skipPhase',
        turnPlayer: { kind: 'player', id: 1 },
        phase: 'MAIN3',
        skip: true,
      }).success,
    ).toBe(false);
  });
});

/*
 * `sendYieldUpdate` — the client→server half of the yield model (wave 24 §E).
 *
 * `ProtocolMethod.java:101` declares it `Mode.CLIENT, Void.TYPE,
 * YieldUpdate.class` and `IGameController.java:84-86` routes it straight to
 * `applyYieldUpdate`, so it is an `act` carrying the SAME twelve-arm payload as
 * the notify. Everything below says that in a way a later "tidy" cannot quietly
 * narrow: the arms are closed in this direction too, the kind is an act and not
 * a notify, and the method name is the one Forge looks up.
 *
 * It is NOT in the tier's census arrays, and that boundary gets an assertion of
 * its own rather than a comment — see the module header in `tier-b.ts` for the
 * five edits that would move it in.
 */
describe('sendYieldUpdate — the same twelve arms, the other way', () => {
  const frame = (update: unknown) => ({ kind: 'act', method: 'sendYieldUpdate', update });

  it('carries every one of Forge’s twelve arms', () => {
    for (const arm of YIELD_ARMS) {
      const result = SendYieldUpdateSchema.safeParse(frame(arm));
      expect(result.success ? null : result.error.issues, String(arm.update)).toBeNull();
    }
  });

  it('refuses a thirteenth arm in this direction too — the union is closed both ways', () => {
    expect(SendYieldUpdateSchema.safeParse(frame({ update: 'setEverything' })).success).toBe(false);
    expect(ApplyYieldUpdateSchema.safeParse({
      kind: 'notify',
      method: 'applyYieldUpdate',
      update: { update: 'setEverything' },
    }).success).toBe(false);
  });

  it('is an act, not a notify: a Mode.CLIENT method returns void and never blocks', () => {
    // ProtocolMethod.java:84-86 — "these should all return void, to avoid
    // awkward situations in which client and server wait for one another".
    expect(SendYieldUpdateSchema.safeParse({ ...frame(YIELD_ARMS[0]), kind: 'notify' }).success).toBe(false);
    expect(SendYieldUpdateSchema.safeParse({ ...frame(YIELD_ARMS[0]), kind: 'ask', callId: 'c-1' }).success).toBe(false);
  });

  it('is named for the ProtocolMethod, because Forge looks it up by name', () => {
    expect(SendYieldUpdateSchema.safeParse({ ...frame(YIELD_ARMS[0]), method: 'applyYieldUpdate' }).success).toBe(false);
  });

  it('refuses a field nobody agreed to, and a missing payload', () => {
    expect(SendYieldUpdateSchema.safeParse({ ...frame(YIELD_ARMS[0]), player: { kind: 'player', id: 1 } }).success).toBe(false);
    expect(SendYieldUpdateSchema.safeParse({ kind: 'act', method: 'sendYieldUpdate' }).success).toBe(false);
  });

  it('shares the payload with applyYieldUpdate — a direction is not a shape', () => {
    for (const arm of YIELD_ARMS) {
      expect(SendYieldUpdateSchema.safeParse(frame(arm)).success).toBe(true);
      expect(
        ApplyYieldUpdateSchema.safeParse({ kind: 'notify', method: 'applyYieldUpdate', update: arm }).success,
      ).toBe(true);
    }
  });

  it('is deliberately outside the census — and this is the boundary, recorded', () => {
    // `envelope.test.ts` pins TIER_B_METHODS at 23 and REQUIRED_METHODS at 41,
    // and `examples.ts` would need an entry. Wave 24 lane E owns neither file.
    expect(TIER_B_METHODS as readonly string[]).not.toContain('sendYieldUpdate');
    expect(TIER_B_CLIENT_FRAMES).toHaveLength(3);
    expect(TIER_B_METHODS).toHaveLength(23);
  });
});

/*
 * `setHighlighted` is the third entity frame, and the only two-way one.
 *
 * The battery above proves the shape is closed. These four say what the shape
 * MEANS, and they are the assertions a later "tidy this up into a card list
 * like the other two" would break.
 */
describe('setHighlighted — an entity and a direction', () => {
  const base = SERVER_FRAME_EXAMPLES.setHighlighted as Record<string, unknown>;

  it('takes a player among the entities — the argument is Iterable<GameEntityView>', () => {
    expect(SetHighlightedSchema.safeParse(base).success).toBe(true);
    expect(
      SetHighlightedSchema.safeParse({ ...base, entities: [{ kind: 'player', id: 1 }] }).success,
    ).toBe(true);
    // The contrast: setSelectables really is cards only (IGuiGame.java:272).
    expect(
      SetSelectablesSchema.safeParse({
        kind: 'notify',
        method: 'setSelectables',
        cards: [{ kind: 'player', id: 1 }],
        min: 0,
        max: 1,
      }).success,
    ).toBe(false);
  });

  it('carries the un-highlight call, which is the same frame with on false', () => {
    expect(safeParseServerFrame({ ...base, on: false }).ok).toBe(true);
  });

  it('refuses an empty-entity frame no more than Forge does — an empty list is legal', () => {
    expect(safeParseServerFrame({ ...base, entities: [] }).ok).toBe(true);
  });

  it('is not a selection: it has no min/max and refuses one', () => {
    expect(safeParseServerFrame({ ...base, min: 1 }).ok).toBe(false);
    expect(
      SetHighlightedSchema.safeParse({ ...base, entities: [{ kind: 'spellAbility', id: 9 }] })
        .success,
    ).toBe(false);
  });
});

describe('Tier B — openZones carries a player set, not a map', () => {
  const base = SERVER_FRAME_EXAMPLES.openZones as Record<string, unknown>;

  it('takes an array of player refs', () => {
    expect(OpenZonesSchema.safeParse(base).success).toBe(true);
  });

  it('refuses Forge’s Map<PlayerView, Object> shape', () => {
    expect(
      OpenZonesSchema.safeParse({
        ...base,
        players: [{ player: { kind: 'player', id: 1 }, value: null }],
      }).success,
    ).toBe(false);
  });

  it('refuses a zone Forge does not have', () => {
    expect(OpenZonesSchema.safeParse({ ...base, zones: ['Pocket'] }).success).toBe(false);
  });
});

describe('Tier B — sideboard is @hadoku/deck’s pool model, at runtime', () => {
  const frame = SideboardSchema.parse(SERVER_FRAME_EXAMPLES.sideboard);

  it('parsed wire entries are usable as @hadoku/deck DeckEntry values', () => {
    const pool = [...frame.main, ...frame.sideboard].map(asDeckEntry);
    expect(totalCards(pool)).toBe(8);

    // `newDeck` puts the whole pool in the sideboard and `toDeckFile` merges
    // the two four-card entries, so this is Forge `.dck` text for 8 Bolts.
    const deck = newDeck('game 2', pool);
    expect(writeDck(toDeckFile(deck))).toBe(
      '[metadata]\nName=game 2\n[Sideboard]\n8 Lightning Bolt|lea\n',
    );
  });

  it('a CardPool flattens to Forge’s List<PaperCard>', () => {
    expect(flattenEntries(frame.main)).toHaveLength(4);
  });

  it('a count of zero is not a card line', () => {
    expect(
      SideboardSchema.safeParse({
        ...(SERVER_FRAME_EXAMPLES.sideboard as Record<string, unknown>),
        main: [{ count: 0, card: frame.main[0].card }],
      }).success,
    ).toBe(false);
  });

  it('a pool entry cannot smuggle an extra field past the schema', () => {
    expect(
      SideboardSchema.safeParse({
        ...(SERVER_FRAME_EXAMPLES.sideboard as Record<string, unknown>),
        main: [{ count: 1, card: { ...frame.main[0].card, imageUrl: 'https://example/x.jpg' } }],
      }).success,
    ).toBe(false);
  });
});

/*
 * `getAbilityToPlay` carries its own label (Wave 19 lane B).
 *
 * The picker used to draw "ability #243" because no `SpellAbilityView` is ever
 * on the wire; the label is what the bridge sends instead. The battery above
 * cannot cover it — `malformed.ts` mutates a frame's TOP-LEVEL keys, and the
 * label lives inside `abilities[]` — so these are hand-written, positive and
 * negative both.
 */
describe('getAbilityToPlay — the label travels with the offer', () => {
  const offer = SERVER_FRAME_EXAMPLES.getAbilityToPlay as Record<string, unknown>;
  const labelled = { kind: 'spellAbility', id: 9001, label: '{1}, Sacrifice Pyrite Spellbomb: Draw a card.' };
  const reply = (result: unknown) =>
    safeParseClientFrame({ kind: 'reply', callId: 'c-5', method: 'getAbilityToPlay', result });

  it('parses an offer whose abilities carry labels', () => {
    expect(safeParseServerFrame({ ...offer, abilities: [labelled] }).ok).toBe(true);
  });

  it('parses an offer with none — the shape a bridge that predates the label sends', () => {
    expect(safeParseServerFrame({ ...offer, abilities: [{ kind: 'spellAbility', id: 9001 }] }).ok).toBe(true);
  });

  it('a reply may echo the label it was offered, or answer with the bare ref', () => {
    expect(reply(labelled).ok).toBe(true);
    expect(reply({ kind: 'spellAbility', id: 9001 }).ok).toBe(true);
  });

  it('rejects a label that is not a string, in the offer and in the reply', () => {
    const bad = { ...labelled, label: 42 };
    expect(safeParseServerFrame({ ...offer, abilities: [bad] }).ok).toBe(false);
    expect(reply(bad).ok).toBe(false);
  });

  it('rejects an ability object with a field nobody agreed to', () => {
    expect(safeParseServerFrame({ ...offer, abilities: [{ ...labelled, power: '3' }] }).ok).toBe(false);
  });
});
