/*
 * What each card of a set is expected to ask, and the check against it.
 *
 * A sweep with no flag says nothing got stuck. It does not say the card still asks what it should:
 * a gift that is promised without asking, an offspring cost the server pays for the seat, a "may"
 * that stopped being one all play through cleanly. So each card's play is reduced to a signature
 * (how the cast ended, the questions the seat was asked while playing it and whether it refused
 * each, and what the server answered in its place) and compared with the one recorded for the set
 * in `expected/<SET>.json`. `--update` records; a difference fails the run and prints both sides.
 *
 * Only the questions asked while the card was cast and used are in the signature. The turns played
 * on afterwards depend on what Forge's AI does with them, and their flags are checked all the same.
 */
import type { CardResult } from './run-cards.ts';

export interface CardSignature {
  cast: CardResult['cast'];
  /** `method: words` per question, in order, `(declined)` after one the seat refused. The same question asked again straight away is listed once: how many times is Forge's pacing, not the card's. */
  asks: string[];
  /** `evt method: why` per answer the server gave for the seat, in order. */
  server: string[];
}

/** A set's signatures: card name, then variant. */
export type Expected = Record<string, Partial<Record<CardResult['variant'], CardSignature>>>;

/** Forge writes a card's game id after its name ("Parting Gust (102)"); it is not part of what was asked. */
const words = (text: unknown): string => String(text ?? '').replace(/ \(\d+\)/g, '').trim();

/** Forge asking which of a clicked card's abilities to play, and the server's two standing answers to it, are in every play and say nothing of the card. */
const EVERY_PLAY = 'getAbilityToPlay';

export function signatureOf(result: CardResult): CardSignature {
  return {
    cast: result.cast,
    asks: result.asks
      .filter((a) => a.during === 'play' && a.method !== EVERY_PLAY)
      .map((a) => `${a.method}: ${words(a.shape.message ?? a.shape.title)}${a.declined ? ' (declined)' : ''}`)
      .filter((ask, i, all) => ask !== all[i - 1]),
    server: result.server.filter((s) => s.method !== EVERY_PLAY).map((s) => `${s.evt} ${s.method ?? '-'}: ${s.why ?? ''}`),
  };
}

export function expectedOf(results: readonly CardResult[]): Expected {
  const out: Expected = {};
  for (const r of [...results].sort((a, b) => a.card.localeCompare(b.card) || a.variant.localeCompare(b.variant))) (out[r.card] ??= {})[r.variant] = signatureOf(r);
  return out;
}

export interface Difference {
  card: string;
  variant: CardResult['variant'];
  /** Null: the set's expectations have no entry for this card and variant. */
  expected: CardSignature | null;
  got: CardSignature;
}

/** Each run whose signature is not the recorded one. */
export function differences(results: readonly CardResult[], expected: Expected): Difference[] {
  const out: Difference[] = [];
  for (const r of results) {
    const want = expected[r.card]?.[r.variant] ?? null;
    const got = signatureOf(r);
    if (want === null || JSON.stringify(want) !== JSON.stringify(got)) out.push({ card: r.card, variant: r.variant, expected: want, got });
  }
  return out;
}

/** A difference as the log prints it. */
export function differenceText(d: Difference): string {
  const side = (s: CardSignature | null): string => (s === null ? '    (nothing recorded)' : [`    cast: ${s.cast}`, ...s.asks.map((a) => `    ask: ${a}`), ...s.server.map((a) => `    server: ${a}`)].join('\n'));
  return `${d.card} (${d.variant})\n  expected:\n${side(d.expected)}\n  got:\n${side(d.got)}`;
}
