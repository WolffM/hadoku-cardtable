/*
 * The 17 GameEvent classes Forge declares and no captured match has fired —
 * each one REFUSED by name.
 *
 * `forge-game/src/main/java/forge/game/event/` declares 58 `public record
 * GameEvent…` types. 100 captured AI-vs-AI constructed games fired 41 of them
 * (`modelled.ts`); no run of this lane's (1, 12, 40, 60 and an aimed 2-game
 * run) fired any of these 17. Wave 8's brief said "the other 22": five of those
 * 22 turned up in the larger capture and moved to `modelled.ts`.
 *
 * A schema here would be transcribed from a record declaration, and nobody
 * would have seen what the decoder actually writes for it — which is exactly
 * how the first capture of this lane got `GameEventAddLog` wrong (its `type`
 * component overwrote the discriminator; see `modelled.ts`). So each arm is
 * REACHABLE and REFUSING, in the style `tier-c.ts` used while the state channel
 * was unresolved: the name is recognised, and parsing one fails with a
 * sentence that says what fired it in Forge and what capture would settle it.
 *
 * The rejected alternative — `z.unknown()` or a loose object — would accept
 * every malformed instance of these 17 silently and look finished in a diff.
 *
 * Fire sites are `grep -rlE "new GameEvent<Name>\(" forge-game/src/main
 * forge-gui/src/main` at the pinned fork, 2ad70eb4.
 */

import { z } from 'zod';

/** Where the capture that would settle any of these lives. */
export const EVENTS_CAPTURE = 'packages/forge-wire/src/events/capture/run.sh';

interface Unseen {
  /** The Forge code that fires it — where a capture has to reach. */
  readonly firedBy: string;
  /** What a capture needs to do to see one. */
  readonly settle: string;
}

/**
 * The 17, with where each is fired. Keyed by the `event` discriminator, i.e.
 * the record's simple class name.
 */
export const REFUSED_EVENTS = {
  GameEventAnteCardsSelected: {
    firedBy: 'Match.java:89, when a match plays for ante',
    settle: 'a capture with ante enabled',
  },
  GameEventCardPhased: {
    firedBy: 'Card.java (phasing)',
    settle: 'a deck with a phasing card',
  },
  GameEventCardPlotted: {
    firedBy: 'AlterAttributeEffect, CardFactoryUtil (the Plot keyword)',
    settle: 'a deck with a Plot card',
  },
  GameEventCombatUpdate: {
    firedBy:
      'forge-gui InputAttack.java:359 and InputBlock.java:88 — HUMAN attack/block input only',
    settle:
      'a capture with a human-driven seat. AI-vs-AI can never fire it, so no number of games settles this one',
  },
  GameEventDayTimeChanged: {
    firedBy: 'Game.java:1418 (day/night), SubgameEffect.java:187',
    settle: 'a deck with a daybound/nightbound card',
  },
  GameEventDoorChanged: {
    firedBy: 'Card.java (Room doors)',
    settle: 'a deck with a Room card',
  },
  GameEventGameRestarted: {
    firedBy: 'PhaseHandler.java:1153',
    settle: 'a card that restarts the game',
  },
  GameEventManaBurn: {
    firedBy:
      'Player.java:528 (loseLife with manaBurn), reached from PhaseHandler.java:464 when the pool hasBurn() and from DrainManaEffect.java:44',
    settle: 'a capture with mana burn in effect, or a deck with a drain-mana card',
  },
  GameEventPlayerRadiation: {
    firedBy: 'Player.java (rad counters)',
    settle: 'a deck with a radiation card',
  },
  GameEventPlayerShardsChanged: {
    firedBy: 'Player.java (shards — an Adventure-mode currency)',
    settle: 'an Adventure-mode game; likely never relevant to this app',
  },
  GameEventRandomLog: {
    firedBy: 'CleanUpEffect, VoteEffect, CountersPutEffect, RemoveFromMatchEffect',
    settle: 'a deck with a voting or random-choice card',
  },
  GameEventSnapshotRestored: {
    firedBy: 'GameSnapshot.java:67,69 (undo)',
    settle: 'a capture that exercises undo',
  },
  GameEventSpeedChanged: {
    firedBy: 'Player.java (the Start your engines! speed mechanic)',
    settle: 'a deck with a speed card',
  },
  GameEventSprocketUpdate: {
    firedBy: 'Card.java (Contraptions)',
    settle: 'a deck with Contraptions',
  },
  GameEventSubgameEnd: {
    firedBy: 'SubgameEffect.java:185',
    settle:
      'NOTHING on the wire as it stands: its `maingame` component is a forge.game.Game, which is not Serializable (Game.java:63), so TrackableSerializer.wrapEvents catches the IOException and DROPS the event (TrackableSerializer.java:188). Expressing it needs a Java-side change, not a capture. Read from source, not observed',
  },
  GameEventSubgameStart: {
    firedBy: 'SubgameEffect.java:146',
    settle:
      'NOTHING on the wire as it stands: its `subgame` component is a forge.game.Game, which is not Serializable (Game.java:63), so TrackableSerializer.wrapEvents catches the IOException and DROPS the event (TrackableSerializer.java:188). Expressing it needs a Java-side change, not a capture. Read from source, not observed',
  },
  GameEventSurveil: {
    firedBy: 'Player.java (surveil)',
    settle: 'a deck with a surveil card',
  },
} as const satisfies Record<string, Unseen>;

export type RefusedEventName = keyof typeof REFUSED_EVENTS;

export const REFUSED_EVENT_NAMES = Object.keys(REFUSED_EVENTS) as RefusedEventName[];

/**
 * The sentence a consumer sees when it parses one of the 17.
 *
 * Exported so a bridge can surface it verbatim, and so a test can assert that
 * every refusal names its event and where to go next.
 */
export function eventRefusal(name: RefusedEventName): string {
  const { firedBy, settle } = REFUSED_EVENTS[name];
  return (
    `${name} is a Forge GameEvent that NO captured match has fired, so no schema is ` +
    `shipped for it — one written from the record declaration alone would be a guess ` +
    `dressed as a contract. Fired by: ${firedBy}. Settle it with: ${settle}. ` +
    `Capture harness: ${EVENTS_CAPTURE}.`
  );
}

/**
 * A recognised, refusing arm. Loose rather than strict on purpose: a real
 * instance carries its own components, and the ONE issue it should raise is the
 * refusal, not a list of unrecognised keys that buries it.
 */
function refusedEvent<N extends RefusedEventName>(name: N) {
  return z.looseObject({
    event: z.literal(name),
    refused: z.never({ error: () => eventRefusal(name) }),
  });
}

export const REFUSED_EVENT_SCHEMAS = REFUSED_EVENT_NAMES.map((name) => refusedEvent(name));
