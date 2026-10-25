/*
 * Board states and animation loops for the browser-fps harness, as Tier C `DeltaPacket`s.
 *
 * Everything starts from the committed real capture (`apps/ui/src/play/fixtures/tierc-game1-seq1-27.json`,
 * a real Forge match's first 27 packets). Bigger boards are that game plus one setup packet whose cards are
 * CLONES of the capture's own card and card-state objects — same properties, same tags, new ids — so every
 * value the client parses is one Forge really sent. What is synthetic: how many there are, and the deltas
 * the loops send (Tapped, Attacking, CombatView, Stack moves), each in the shape the capture uses.
 */
import game1 from '../../apps/ui/src/play/fixtures/tierc-game1-seq1-27.json';

type Tagged = Record<string, unknown>;
type Obj = { _type: number; _id: number } & Record<string, unknown>;
type Table = Record<string, Obj>;
export interface Packet {
  seq: number;
  checksum: number;
  checksumProperties: unknown[];
  newObjects: Table;
  objectDeltas: Record<string, Record<string, unknown>>;
  events: unknown[];
}

const CARD = 0;
const PLAYER = 1;
const STACK = 2;
const GAME = 3;
const STATE = 4;
const key = (type: number, id: number): string => String(((type << 28) | (id & 0x0fffffff)) >>> 0);
const stateKey = (id: number): string => key(STATE, id * 16);
const int = (v: number): Tagged => ({ t: 'int', v });
const list = (ids: readonly number[]): Tagged => ({ t: 'list', v: ids.map(int) });
const bool = (v: boolean): Tagged | null => (v ? { t: 'bool', v: true } : null);
const zone = (v: string): Tagged => ({ t: 'enum', c: 'forge.game.zone.ZoneType', v });
const phase = (v: string): Tagged => ({ t: 'enum', c: 'forge.game.phase.PhaseType', v });

const captured: Packet[] = (game1 as Record<string, unknown>[]).map((p) => {
  const { _truncatedTo: _, ...wire } = p;
  return wire as unknown as Packet;
});

/** The capture folded into one table: the templates clones are cut from. */
const world: Table = {};
for (const p of captured) {
  for (const [k, v] of Object.entries(p.newObjects)) world[k] = { ...world[k], ...v } as Obj;
  for (const [k, v] of Object.entries(p.objectDeltas)) world[k] = { ...world[k], ...v } as Obj;
}

/** Capture card ids with full objects, by role. */
const T = {
  island: 24,
  mountain: 87,
  furnace: 116,
  urchin: 21,
  boar: 99,
  replica: 67,
  whelp: 60, // Hellkite Whelp — Flying
  halberdier: 47,
  leapfrog: 54, // in hand at seq 27; the stack loop casts it
  talon: 65, // Talon of Pain — an artifact, attached by the setup
} as const;

export type BoardSize = 'early' | 'mid' | 'crowded' | 'huge';
export interface BoardOptions {
  size: BoardSize;
  flyers: boolean;
  hand: number;
  /**
   * Rename creature clones to cards the art table knows, so they draw with art as most cube cards do.
   * The capture's own creatures (GRN/MRD precons) have no art row and draw as text.
   */
  art: boolean;
}

/** A card in `apps/ui/src/draft/art-ids.json` (bare-name row) for each creature template. */
const ART_NAME: Partial<Record<number, string>> = {
  21: 'Grizzly Bears',
  99: 'Hill Giant',
  60: 'Air Elemental',
  47: 'Llanowar Elves',
};

/** Per side, on top of the capture's own permanents. */
const EXTRA: Record<BoardSize, { lands: number; creatures: number; tokens: number; attached: number }> = {
  early: { lands: 0, creatures: 0, tokens: 0, attached: 0 },
  mid: { lands: 0, creatures: 0, tokens: 0, attached: 0 },
  crowded: { lands: 7, creatures: 10, tokens: 4, attached: 2 },
  huge: { lands: 14, creatures: 20, tokens: 8, attached: 4 },
};

export interface Scenario {
  packets: Packet[];
  /** Each loop: one packet per step, sent in turn forever. */
  loops: Record<string, () => Packet>;
  counts: { p0: number; p1: number; hand: number; flyers: number };
}

export function buildScenario(options: BoardOptions): Scenario {
  let seq = 0;
  const packet = (newObjects: Table, objectDeltas: Packet['objectDeltas']): Packet => ({
    seq: ++seq,
    checksum: 0,
    checksumProperties: [],
    newObjects,
    objectDeltas,
    events: [],
  });

  if (options.size === 'early') {
    // Turn 5, main 1: three permanents a side, six cards in hand — the capture's packet 6.
    const packets = captured.slice(0, 6).map((p) => ({ ...p }));
    seq = packets.length;
    return finish(packets, 6, 3, 3, 6, 0);
  }

  const packets = captured.map((p) => ({ ...p }));
  seq = packets.length;

  // The state the loops mutate, mirrored here so each delta sends whole lists as Forge does.
  const lists = {
    bf: [world[key(PLAYER, 0)]!, world[key(PLAYER, 1)]!].map((p) => ((p['Battlefield'] as { v: { v: number }[] }).v.map((x) => x.v))),
    hand: (world[key(PLAYER, 0)]!['Hand'] as { v: { v: number }[] }).v.map((x) => x.v),
    gy0: (world[key(PLAYER, 0)]!['Graveyard'] as { v: { v: number }[] }).v.map((x) => x.v),
  };

  const fresh: Table = {};
  let nextId = 1000;
  let flyers = 0;
  const clone = (template: number, owner: number, where: string, extra: Record<string, unknown> = {}): number => {
    const id = nextId++;
    const card = world[key(CARD, template)];
    const face = world[stateKey(template)];
    if (card === undefined || face === undefined) throw new Error(`template ${template} has no card or state object in the capture`);
    const renamed = options.art ? ART_NAME[template] : undefined;
    const name = renamed === undefined ? {} : { Name: { t: 'str', v: renamed }, OracleName: { t: 'str', v: renamed } };
    const image = renamed === undefined ? {} : { ImageKey: { t: 'str', v: `c:${renamed}|GRN|1` } };
    fresh[key(CARD, id)] = { ...card, _id: id, Owner: int(owner), Controller: int(owner), Zone: zone(where), Tapped: null, Sickness: null, ...name, ...extra } as Obj;
    fresh[stateKey(id)] = { ...face, _id: id * 16, ...name, ...image } as Obj;
    return id;
  };

  const extra = EXTRA[options.size];
  const lands: number[][] = [[], []];
  const creatures: number[][] = [[], []];
  for (const owner of [0, 1]) {
    const bf = lists.bf[owner]!;
    for (let i = 0; i < extra.lands; i++) bf.push(clone(owner === 0 ? T.island : i % 2 ? T.furnace : T.mountain, owner, 'Battlefield'));
    const pool = options.flyers ? [T.urchin, T.boar, T.whelp, T.replica, T.halberdier] : [T.urchin, T.boar, T.replica, T.halberdier];
    for (let i = 0; i < extra.creatures; i++) {
      const template = pool[i % pool.length]!;
      if (template === T.whelp) flyers += 1;
      const counters = i % 3 === 0 ? { Counters: { t: 'multiset', v: [['P1P1', 1 + (i % 4)]] } } : {};
      const id = clone(template, owner, 'Battlefield', counters);
      creatures[owner]!.push(id);
      bf.push(id);
    }
    for (let i = 0; i < extra.tokens; i++) {
      const id = clone(T.replica, owner, 'Battlefield', { Token: { t: 'bool', v: true } });
      creatures[owner]!.push(id);
      bf.push(id);
    }
    for (let i = 0; i < extra.attached; i++) {
      const host = creatures[owner]![i];
      if (host === undefined) break;
      const gear = clone(T.talon, owner, 'Battlefield', { EntityAttachedTo: { t: 'ints', v: [0, host] } });
      fresh[key(CARD, host)]!['AttachedCards'] = list([gear]);
      bf.push(gear);
    }
    for (const id of bf) {
      const core = ((world[stateKey(id)] ?? fresh[stateKey(id)])?.['Type'] as { core?: string[] } | undefined)?.core ?? [];
      if (core.includes('Land')) lands[owner]!.push(id);
      else if (core.includes('Creature') && !creatures[owner]!.includes(id)) creatures[owner]!.push(id);
    }
  }
  while (lists.hand.length < options.hand) lists.hand.push(clone(lists.hand.length % 2 ? T.halberdier : T.urchin, 0, 'Hand'));

  // Setup: the capture's stack resolved away (Direct Current to the graveyard, the trigger gone), the
  // clones placed, the hand filled. Main 1, Bob's (the viewer's) turn, as the capture stands.
  lists.gy0.push(1);
  packets.push(
    packet(fresh, {
      [key(CARD, 1)]: { _type: CARD, _id: 1, Zone: zone('Graveyard') },
      [key(GAME, 1)]: { _type: GAME, _id: 1, Stack: list([]) },
      [key(PLAYER, 0)]: { _type: PLAYER, _id: 0, Battlefield: list(lists.bf[0]!), Hand: list(lists.hand), Graveyard: list(lists.gy0) },
      [key(PLAYER, 1)]: { _type: PLAYER, _id: 1, Battlefield: list(lists.bf[1]!) },
    }),
  );

  // ── loops ──
  let tapped = false;
  const tap = (): Packet => {
    tapped = !tapped;
    const d: Packet['objectDeltas'] = {};
    for (const id of [...lands[0]!, ...lands[1]!]) d[key(CARD, id)] = { _type: CARD, _id: id, Tapped: bool(tapped) };
    return packet({}, d);
  };

  // Bob attacks with up to six creatures, Alice blocks with up to four, damage, combat ends.
  const attackers = creatures[0]!.slice(0, 6);
  const blockers = creatures[1]!.slice(0, Math.min(4, attackers.length));
  const game = (p: string, combat: Tagged | null): Record<string, unknown> => ({ _type: GAME, _id: 1, Phase: phase(p), CombatView: combat });
  const combatView = (pblk: boolean): Tagged => ({
    t: 'combat',
    atk: attackers.map((a) => [a]),
    def: attackers.map(() => [1, 1]),
    blk: attackers.map(() => []),
    pblk: attackers.map((_, i) => (pblk && blockers[i] !== undefined ? [blockers[i]] : [])),
  });
  let combatStep = 0;
  const attack = (): Packet => {
    const step = combatStep++ % 4;
    const d: Packet['objectDeltas'] = {};
    if (step === 0) {
      d[key(GAME, 1)] = game('COMBAT_DECLARE_ATTACKERS', combatView(false));
      for (const a of attackers) d[key(CARD, a)] = { _type: CARD, _id: a, Attacking: bool(true), Tapped: bool(true) };
    } else if (step === 1) {
      d[key(GAME, 1)] = game('COMBAT_DECLARE_BLOCKERS', combatView(true));
      for (const b of blockers) d[key(CARD, b)] = { _type: CARD, _id: b, Blocking: bool(true) };
    } else if (step === 2) {
      d[key(GAME, 1)] = game('COMBAT_DAMAGE', combatView(true));
      for (const b of blockers) d[key(CARD, b)] = { _type: CARD, _id: b, Damage: int(1) };
      for (const a of attackers.slice(0, blockers.length)) d[key(CARD, a)] = { _type: CARD, _id: a, Damage: int(1) };
    } else {
      d[key(GAME, 1)] = game('MAIN2', null);
      for (const a of attackers) d[key(CARD, a)] = { _type: CARD, _id: a, Attacking: null, Tapped: null, Damage: null };
      for (const b of blockers) d[key(CARD, b)] = { _type: CARD, _id: b, Blocking: null, Damage: null };
    }
    return packet({}, d);
  };

  // Leapfrog: hand → stack → battlefield → back to hand (a bounce), one move per step.
  let stackStep = 0;
  let item = 900;
  const stack = (): Packet => {
    const step = stackStep++ % 3;
    const id = T.leapfrog;
    const without = (xs: number[]): number[] => xs.filter((x) => x !== id);
    if (step === 0) {
      lists.hand = without(lists.hand);
      item += 1;
      const si: Obj = {
        _type: STACK,
        _id: item,
        Description: { t: 'str', v: `Leapfrog (${id})` },
        Key: { t: 'str', v: `Leapfrog (${id}): cast` },
        SourceTrigger: int(-1),
        SourceCard: int(id),
        ActivatingPlayer: int(0),
        TargetCards: list([]),
        TargetPlayers: list([]),
      };
      return packet(
        { [key(STACK, item)]: si },
        {
          [key(CARD, id)]: { _type: CARD, _id: id, Zone: zone('Stack') },
          [key(PLAYER, 0)]: { _type: PLAYER, _id: 0, Hand: list(lists.hand) },
          [key(GAME, 1)]: { _type: GAME, _id: 1, Stack: list([item]) },
        },
      );
    }
    if (step === 1) {
      lists.bf[0]!.push(id);
      return packet(
        {},
        {
          [key(CARD, id)]: { _type: CARD, _id: id, Zone: zone('Battlefield') },
          [key(PLAYER, 0)]: { _type: PLAYER, _id: 0, Battlefield: list(lists.bf[0]!) },
          [key(GAME, 1)]: { _type: GAME, _id: 1, Stack: list([]) },
        },
      );
    }
    lists.bf[0] = without(lists.bf[0]!);
    lists.hand.push(id);
    return packet(
      {},
      {
        [key(CARD, id)]: { _type: CARD, _id: id, Zone: zone('Hand') },
        [key(PLAYER, 0)]: { _type: PLAYER, _id: 0, Battlefield: list(lists.bf[0]!), Hand: list(lists.hand) },
      },
    );
  };

  // The leak loop: every animation in turn, then life totals ticking.
  let mixStep = 0;
  let life = 20;
  const mix = (): Packet => {
    const which = mixStep++ % 4;
    if (which === 0) return tap();
    if (which === 1) return attack();
    if (which === 2) return stack();
    life = life === 1 ? 20 : life - 1;
    return packet({}, { [key(PLAYER, 1)]: { _type: PLAYER, _id: 1, Life: int(life) } });
  };

  return {
    packets,
    loops: { tap, attack, stack, mix },
    counts: { p0: lists.bf[0]!.length, p1: lists.bf[1]!.length, hand: lists.hand.length, flyers },
  };

  function finish(ps: Packet[], _turn: number, p0: number, p1: number, hand: number, fl: number): Scenario {
    return { packets: ps, loops: {}, counts: { p0, p1, hand, flyers: fl } };
  }
}
