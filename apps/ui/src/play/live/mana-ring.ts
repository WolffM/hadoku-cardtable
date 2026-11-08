/**
 * The mana ring's model: which of Forge's questions about a mana source the ring answers, what it
 * draws for each, and the reply each pick sends. Pure; `ManaRing.tsx` draws it.
 *
 * Forge asks about a mana source in up to two steps (probed in real Forge, runs 42132000056 and
 * 42137472274: a probe suite that clicked 31 kinds of source on a claw):
 *
 * 1. `getAbilityToPlay`: which of the source's abilities (a dual's W and U, a pain land's {C} and
 *    W-or-U). The bridge puts each mana ability's results on the offer (`mana`, `PlayBridge.java`'s
 *    `manaFacts`), so the ring draws every result at once: one disc per colour an ability can make.
 * 2. The colour inside the chosen ability: `getChoices` of colours (three or more), a yes/no whose two
 *    buttons are colours (exactly two: the prompt's `manaColors`), or `assignGenericAmount` over
 *    colours (a filter land's pair, a five-mana combination).
 *
 * A pick in step 1 answers step 1 with the ability and carries the colour it showed ({@link
 * RingAnswer}'s `then`); when step 2 arrives, {@link answerFromIntent} answers it with that colour,
 * so one click on a disc is the whole conversation. A step 2 with no pick behind it (City of Brass,
 * whose single ability the server takes itself) draws its own ring.
 */

import type { ManaFacts, OfferedAbility } from '@hadoku/forge-wire';

import type { AskOf, ReplyOf } from '../prompts/types.ts';

export type Mana = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const MANA: readonly Mana[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** `MagicColor`'s colour bits, as `assignGenericAmount`'s `manaColor` keys carry them. */
const COLOR_BIT: Readonly<Record<number, Mana>> = { 1: 'W', 2: 'U', 4: 'B', 8: 'R', 16: 'G' };

/** What a disc says about its cost and its result besides the mana: drawn as small marks on it. */
export interface RingMarks {
  /** Life paid. */
  life?: number;
  /** Damage the source deals its controller. */
  damage?: number;
  /** Mana paid first, Forge's notation (`{1}`, `{W/U}`). */
  cost?: string;
  /** The counter type removed. */
  counter?: string;
  /** `self`, or the type sacrificed. */
  sacrifice?: string;
  /** The type of permanent tapped. */
  tapType?: string;
  spendOnly?: 'creature' | 'other';
}

export type RingAnswer =
  /** Step 1: the ability; `then` is the colours the disc showed, for step 2 (null: nothing to carry). */
  | { readonly to: 'ability'; readonly ability: OfferedAbility | null; readonly then: readonly Mana[] | null }
  | { readonly to: 'choice'; readonly key: string }
  | { readonly to: 'button'; readonly which: 'ok' | 'cancel' }
  /** One more pip of a combination ({@link Ring.tally}); the whole combination is the reply. */
  | { readonly to: 'tally' };

export interface RingOption {
  readonly key: string;
  /** The mana the disc shows: one pip, a pair, or none (a source that makes nothing now). */
  readonly syms: readonly Mana[];
  /** How many of {@link syms} the disc makes; 1 draws no count. */
  readonly times: number;
  /** A combination: {@link syms} are the colours the total is split among, asked next. */
  readonly split?: number;
  /** The colours come from other lands and are asked next. */
  readonly reflects?: boolean;
  readonly marks: RingMarks;
  readonly answer: RingAnswer;
  /** Inside a payment, it pays nothing owed (`ManaFacts.paysNothing`): drawn greyed, not pickable. */
  readonly dim?: boolean;
}

/** A non-mana ability of the source: an outer chip, named by its label on hover. */
export interface RingChip {
  readonly key: string;
  readonly label: string;
  readonly answer: RingAnswer;
}

/** A combination to build one pip at a time (`assignGenericAmount` over colours). */
export interface RingTally {
  readonly total: number;
  /** Each colour's most, in Forge's order. */
  readonly max: ReadonlyMap<Mana, number>;
  readonly reply: (counts: ReadonlyMap<Mana, number>) => ReplyOf<'assignGenericAmount'>;
}

export interface Ring {
  readonly options: readonly RingOption[];
  readonly chips: readonly RingChip[];
  /** Escape and a click away answer "none" (`getAbilityToPlay`'s null); a colour Forge needs cannot be cancelled. */
  readonly cancellable: boolean;
  readonly tally?: RingTally;
}

function letters(s: string | undefined): Mana[] {
  return [...(s ?? '')].filter((c): c is Mana => (MANA as readonly string[]).includes(c));
}

function marksOf(f: Pick<ManaFacts, keyof RingMarks>): RingMarks {
  const m: { -readonly [K in keyof RingMarks]: RingMarks[K] } = {};
  if (f.life !== undefined) m.life = f.life;
  if (f.damage !== undefined) m.damage = f.damage;
  if (f.cost !== undefined) m.cost = f.cost;
  if (f.counter !== undefined) m.counter = f.counter;
  if (f.sacrifice !== undefined) m.sacrifice = f.sacrifice;
  if (f.tapType !== undefined) m.tapType = f.tapType;
  if (f.spendOnly !== undefined) m.spendOnly = f.spendOnly;
  return m;
}

/** Every unordered pick of `n` from `colors`, repeats allowed, in `colors`' order: WU → WW, WU, UU. */
function multisets(colors: readonly Mana[], n: number): Mana[][] {
  if (n === 0) return [[]];
  const out: Mana[][] = [];
  colors.forEach((c, i) => {
    for (const rest of multisets(colors.slice(i), n - 1)) out.push([c, ...rest]);
  });
  return out;
}

/** The discs one mana ability draws. */
function optionsOf(ability: OfferedAbility, f: ManaFacts): RingOption[] {
  return optionsOfFacts(ability, f).map((o) => (f.paysNothing === true ? { ...o, dim: true } : o));
}

function optionsOfFacts(ability: OfferedAbility, f: ManaFacts): RingOption[] {
  const base = `a${ability.id}`;
  const marks = marksOf(f);
  const pick = (then: readonly Mana[] | null): RingAnswer => ({ to: 'ability', ability, then });
  if (f.reflects === true) return [{ key: base, syms: [], times: 1, reflects: true, marks, answer: pick(null) }];
  if (f.choose !== undefined) {
    const colors = letters(f.choose);
    if (f.combination === true) {
      if (f.amount === 2 && colors.length > 1) {
        return multisets(colors, 2).map((pair) => ({ key: `${base}:${pair.join('')}`, syms: pair, times: 1, marks, answer: pick(pair) }));
      }
      return [{ key: base, syms: colors, times: 1, split: f.amount, marks, answer: pick(null) }];
    }
    if (colors.length === 0) return [{ key: base, syms: [], times: 1, marks, answer: pick(null) }];
    return colors.map((c) => ({ key: `${base}:${c}`, syms: [c], times: f.amount, marks, answer: pick(colors.length > 1 ? [c] : null) }));
  }
  const made = letters(f.makes);
  if (made.length === 1 && f.amount === 2) return [{ key: base, syms: [made[0]!, made[0]!], times: 1, marks, answer: pick(null) }];
  return [{ key: base, syms: made, times: made.length === 1 ? f.amount : 1, marks, answer: pick(null) }];
}

/** The ring for a source's abilities, or null when none of them makes mana (the generic picker asks). */
export function abilityRing(ask: Pick<AskOf<'getAbilityToPlay'>, 'abilities'>): Ring | null {
  if (!ask.abilities.some((a) => a.mana !== undefined)) return null;
  const options: RingOption[] = [];
  const chips: RingChip[] = [];
  for (const ability of ask.abilities) {
    if (ability.mana !== undefined) options.push(...optionsOf(ability, ability.mana));
    else chips.push({ key: `a${ability.id}`, label: ability.label ?? `Ability ${ability.id}`, answer: { to: 'ability', ability, then: null } });
  }
  return { options, chips, cancellable: true };
}

/**
 * The ring a press on a mana source draws before anything is sent (the offer's `manaRings`), or null
 * when it gives no choice. A pick then sends the click, and {@link intentReply} answers Forge's questions.
 */
export function pressRing(abilities: readonly OfferedAbility[]): Ring | null {
  const ring = abilityRing({ abilities: [...abilities] });
  return ring === null || ring.options.length + ring.chips.length < 2 ? null : ring;
}

/**
 * A pick on the mana ring carried into the questions Forge asks after it: the ability, when the ring
 * was drawn on the press before Forge asked for it, and the colours the disc showed.
 */
export interface ManaIntent {
  readonly colors: readonly Mana[];
  readonly source: number;
  readonly ability?: number;
}

/** The intent a pick on a press's ring sends its click with. */
export function intentOf(answer: RingAnswer, source: number): ManaIntent | null {
  if (answer.to !== 'ability' || answer.ability === null) return null;
  return { colors: answer.then ?? [], source, ability: answer.ability.id };
}

/** The ring for a list of colours (`getChoices` the bridge marked with `colors`), or null for any other list. */
export function colorRing(ask: AskOf<'getChoices'>): Ring | null {
  const colors = ask.colors;
  if (colors === undefined || colors.length !== ask.choices.length || ask.max !== 1) return null;
  const marks = ask.manaMarks === undefined ? {} : marksOf(ask.manaMarks);
  const options = ask.choices.map((choice, i) => ({
    key: `c:${colors[i]!}`,
    syms: [colors[i]!],
    times: 1,
    marks,
    answer: { to: 'choice', key: choice.key } as const,
  }));
  return { options, chips: [], cancellable: ask.min === 0 };
}

/** The ring for Forge's two-colour yes/no (the prompt's `manaColors`): OK is the first colour, Cancel the second. */
export function promptRing(colors: readonly [Mana, Mana], marks: RingMarks = {}): Ring {
  const options = colors.map((c, i) => ({
    key: `p:${c}`,
    syms: [c],
    times: 1,
    marks,
    answer: { to: 'button', which: i === 0 ? 'ok' : 'cancel' } as const,
  }));
  return { options, chips: [], cancellable: false };
}

/** The colours of an `assignGenericAmount` keyed by colour, or null when any key is not a colour. */
function splitColors(ask: AskOf<'assignGenericAmount'>): Map<Mana, number> | null {
  const max = new Map<Mana, number>();
  for (const entry of ask.target) {
    if (entry.key.target !== 'manaColor') return null;
    const c = COLOR_BIT[entry.key.color];
    if (c === undefined) return null;
    max.set(c, entry.amount);
  }
  return max.size === 0 ? null : max;
}

/** The ring for a mana combination (`assignGenericAmount` over colours), or null for any other split. */
export function tallyRing(ask: AskOf<'assignGenericAmount'>): Ring | null {
  const max = splitColors(ask);
  if (max === null) return null;
  const options = [...max.keys()].map((c) => ({ key: `t:${c}`, syms: [c], times: 1, marks: {}, answer: { to: 'tally' } as const }));
  const reply = (counts: ReadonlyMap<Mana, number>): ReplyOf<'assignGenericAmount'> =>
    ask.target.map((entry) => ({ key: entry.key, amount: entry.key.target === 'manaColor' ? (counts.get(COLOR_BIT[entry.key.color]!) ?? 0) : 0 }));
  return { options, chips: [], cancellable: false, tally: { total: ask.amount, max, reply } };
}

/** Whether `counts` is a whole, legal combination for `tally`. */
export function tallyDone(tally: RingTally, counts: ReadonlyMap<Mana, number>): boolean {
  let sum = 0;
  for (const [c, n] of counts) {
    if (n > (tally.max.get(c) ?? 0)) return false;
    sum += n;
  }
  return sum === tally.total;
}

/**
 * The answer to step 2 from a step-1 pick's colours, or null when they do not answer it (the ring
 * then draws the question). Each colour Forge asks for is the next of `intent`.
 */
export function answerFromIntent(
  ask: AskOf<'getChoices'> | AskOf<'assignGenericAmount'> | { readonly manaColors: readonly [Mana, Mana] },
  intent: readonly Mana[],
): { readonly kind: 'reply'; readonly reply: unknown } | { readonly kind: 'button'; readonly which: 'ok' | 'cancel' } | null {
  if ('manaColors' in ask) {
    const i = ask.manaColors.indexOf(intent[0]!);
    return i < 0 ? null : { kind: 'button', which: i === 0 ? 'ok' : 'cancel' };
  }
  if (ask.method === 'getChoices') {
    const ring = colorRing(ask);
    const option = ring?.options.find((o) => o.syms[0] === intent[0]);
    return option === undefined || option.answer.to !== 'choice' ? null : { kind: 'reply', reply: [option.answer.key] };
  }
  const ring = tallyRing(ask);
  if (ring?.tally === undefined) return null;
  const counts = new Map<Mana, number>();
  for (const c of intent) counts.set(c, (counts.get(c) ?? 0) + 1);
  return tallyDone(ring.tally, counts) ? { kind: 'reply', reply: ring.tally.reply(counts) } : null;
}

/**
 * The option a typed key picks: a digit by position, a colour letter by the disc that makes just
 * that colour, a pair by its two letters in turn (`typed` is what was typed since the ring opened).
 * `pending` when `typed` begins some pair and picks nothing yet.
 */
export function optionForKeys(options: readonly RingOption[], typed: string): { readonly index: number } | 'pending' | null {
  const t = typed.toUpperCase();
  if (/^[1-9]$/.test(t)) {
    const i = Number(t) - 1;
    return i < options.length && options[i]!.dim !== true ? { index: i } : null;
  }
  const live = (o: RingOption): boolean => o.dim !== true && o.split === undefined;
  const exact = options.findIndex((o) => live(o) && o.syms.join('') === t);
  if (exact >= 0) return { index: exact };
  const single = t.length === 1 ? options.findIndex((o) => live(o) && o.syms.length === 1 && o.syms[0] === t) : -1;
  if (single >= 0) return { index: single };
  return options.some((o) => o.dim !== true && o.syms.join('').startsWith(t)) ? 'pending' : null;
}

/** Where each disc sits around the ring's centre, in px, for a disc of `size` (a pair is wider). */
export function ringLayout(options: readonly RingOption[], size: number): { readonly dx: number; readonly dy: number; readonly radius: number }[] {
  const n = options.length;
  if (n === 0) return [];
  const wide = options.some((o) => o.syms.length > 1 && o.split === undefined);
  const step = wide ? size * 1.95 : size * 1.35;
  const radius = n === 1 ? size * 1.1 : Math.max(size * 1.15, (n * step) / (2 * Math.PI));
  // An even count sits either side of the centre; an odd one has a disc straight up.
  const a0 = n % 2 === 0 ? -Math.PI / 2 + Math.PI / n : -Math.PI / 2;
  return options.map((_, i) => {
    const a = n === 1 ? -Math.PI / 2 : a0 + (i * 2 * Math.PI) / n;
    return { dx: radius * Math.cos(a), dy: radius * Math.sin(a), radius };
  });
}

/** Where the outer chips sit: below the ring, outside it. */
export function chipLayout(count: number, radius: number, size: number): { readonly dx: number; readonly dy: number }[] {
  const r = radius + size * 1.05;
  return Array.from({ length: count }, (_, j) => {
    const a = Math.PI / 2 + (j - (count - 1) / 2) * 0.55;
    return { dx: r * Math.cos(a), dy: r * Math.sin(a) };
  });
}

/** The counter types the Mana font draws (`../../symbols/mana.css`'s `ms-counter-*`). */
const COUNTER_GLYPHS: ReadonlySet<string> = new Set(['charge', 'mining', 'lore', 'time', 'gold', 'plus', 'minus', 'loyalty', 'flood', 'fungus', 'ki', 'verse', 'void', 'doom', 'devotion']);

/** The Mana font glyphs (`ms-…` classes) a disc's cost and rule marks draw, in the order drawn; mana and life are drawn apart. */
export function markGlyphs(marks: RingMarks): { readonly cost: readonly string[]; readonly rule: string | null } {
  const cost: string[] = [];
  if (marks.counter !== undefined) cost.push(`ms-counter-${COUNTER_GLYPHS.has(marks.counter) ? marks.counter : 'charge'}`);
  if (marks.tapType !== undefined) cost.push('ms-creature', 'ms-tap');
  if (marks.sacrifice !== undefined) cost.push(...(marks.sacrifice === 'self' ? [] : ['ms-creature']), 'ms-graveyard');
  const rule = marks.spendOnly === undefined ? null : marks.spendOnly === 'creature' ? 'ms-creature' : 'ms-ability-activated';
  return { cost, rule };
}

/** Forge's cost notation as Mana tokens: `{1}{W/U}` → `1`, `W/U`. */
export function costTokens(cost: string): string[] {
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

type AnyAsk = AskOf<'getAbilityToPlay'> | AskOf<'getChoices'> | AskOf<'assignGenericAmount'> | { readonly method: string };

/**
 * Each disc's key in the DOM: the mana it shows, and which of the discs showing that mana it is. A
 * press's ring and the ring Forge's question takes it over as key a disc of the same mana alike, so the
 * disc stays the same element and does not bloom again.
 */
export function discKeys(options: readonly RingOption[]): string[] {
  const seen = new Map<string, number>();
  return options.map((o) => {
    const mana = o.split === undefined ? o.syms.join('') : `split:${o.syms.join('')}`;
    const n = seen.get(mana) ?? 0;
    seen.set(mana, n + 1);
    return `${mana}#${n}`;
  });
}

/** `ring` with its discs in the order `order` (earlier {@link discKeys}) drew them; discs it never drew go last. */
export function inOrderOf(ring: Ring, order: readonly string[]): Ring {
  const keys = discKeys(ring.options);
  const rank = (i: number): number => {
    const at = order.indexOf(keys[i]!);
    return at < 0 ? order.length + i : at;
  };
  const options = ring.options.map((o, i) => ({ o, r: rank(i) })).sort((a, b) => a.r - b.r).map((x) => x.o);
  return { ...ring, options };
}

/** The ring for an open ask, or null when the ring does not answer it (the generic prompt does). */
export function ringFor(ask: AnyAsk): { readonly ring: Ring; readonly kind: 'abilities' | 'colors' | 'tally' } | null {
  const shape = (ring: Ring | null, kind: 'abilities' | 'colors' | 'tally') => (ring === null ? null : { ring, kind });
  if (ask.method === 'getAbilityToPlay') return shape(abilityRing(ask as AskOf<'getAbilityToPlay'>), 'abilities');
  if (ask.method === 'getChoices') return shape(colorRing(ask as AskOf<'getChoices'>), 'colors');
  if (ask.method === 'assignGenericAmount') return shape(tallyRing(ask as AskOf<'assignGenericAmount'>), 'tally');
  return null;
}

/** The reply a pick's carried colours make to an open colour ask, or null (`answerFromIntent` for an ask). */
export function intentReply(
  ask: AnyAsk,
  intent: ManaIntent | null,
): { readonly method: 'getAbilityToPlay' | 'getChoices' | 'assignGenericAmount'; readonly reply: unknown } | null {
  if (intent === null) return null;
  if (ask.method === 'getAbilityToPlay') {
    const offer = ask as AskOf<'getAbilityToPlay'>;
    if (intent.ability === undefined || offer.hostCard.id !== intent.source) return null;
    const ability = offer.abilities.find((a) => a.id === intent.ability);
    return ability === undefined ? null : { method: 'getAbilityToPlay', reply: ability };
  }
  if (ask.method !== 'getChoices' && ask.method !== 'assignGenericAmount') return null;
  const answer = answerFromIntent(ask as AskOf<'getChoices'> | AskOf<'assignGenericAmount'>, intent.colors);
  return answer === null || answer.kind !== 'reply' ? null : { method: ask.method, reply: answer.reply };
}
