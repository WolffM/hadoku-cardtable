/*
 * Tier B — 21 methods that carry entity references.
 *
 * The generated battery again, then the four claims that make this tier more
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
 */

import { describe, expect, it } from 'vitest';
import { newDeck, toDeckFile, totalCards, writeDck } from '@hadoku/deck';

import { CLIENT_FRAME_EXAMPLES, SERVER_FRAME_EXAMPLES } from './examples.ts';
import { malformedTable } from './malformed.ts';
import { safeParseClientFrame, safeParseServerFrame } from './envelope.ts';
import {
  OpenZonesSchema,
  SelectPlayerSchema,
  SideboardSchema,
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

describe('Tier B — the 21 reference-carrying methods', () => {
  it('models exactly 21 methods, 18 server and 3 client', () => {
    expect(TIER_B_METHODS).toHaveLength(21);
    expect(Object.keys(serverExamples)).toHaveLength(18);
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

describe('Tier B — YieldUpdate’s twelve arms', () => {
  const arms: ReadonlyArray<Record<string, unknown>> = [
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
