/**
 * The kinds a "one of each" choice asks for (a `slots` rule, `search-rules.ts`), drawn as chips that
 * light up as the picks answer them, and the same symbols on each ticked card for the kinds it
 * answers. The seat never says what a card is for: `slotCovers` works it out on every tick.
 */

import { slotCovers, type SearchRule, type SlotCover } from '@hadoku/forge-wire';

import { ManaPip } from '../../components/ManaPip.tsx';

type SlotRule = Extract<SearchRule, { kind: 'slots' }>;

const LAND_MANA: Readonly<Record<string, string>> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
const COLOR_MANA: Readonly<Record<string, string>> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };
const TYPE_GLYPH = new Set(['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery']);
/** Who owns or controls it, and where it came from: not part of what kind it is. */
const QUALIFIER = /^(You|Opp)(Own|Ctrl)$|^IsRemembered$|^Basic$/;

/** What a slot's kind draws as: a mana symbol, a card type's glyph, or its name. */
export type KindFace = { mana: string } | { glyph: string; name: string } | { name: string };

/**
 * A kind as the ability names it (`ChosenSet.named` in the fork) → its face. `Creature.YouOwn` is a
 * creature; `Card.nonCreature+nonLand` is "other"; `Plains` is white mana's symbol, `Card.Black`
 * black's; a colour pair's letters (`WU`) its hybrid symbol; anything else (a power, a party
 * role, an Aura) its own name.
 */
export function kindFace(kind: string): KindFace {
  if (/^[WUBRG]{2}$/.test(kind)) return { mana: `${kind[0]}/${kind[1]}` };
  const [base = kind, ...rest] = kind.split('.');
  const props = rest
    .join('.')
    .split('+')
    .filter((p) => p !== '' && !QUALIFIER.test(p));
  if (base === 'Card' || base === 'Permanent') {
    if (props.length > 0 && props.every((p) => p.startsWith('non'))) return { name: 'other' };
    const color = props.length === 1 ? COLOR_MANA[props[0]!] : undefined;
    if (color !== undefined) return { mana: color };
    return { name: props.join(' ') || base.toLowerCase() };
  }
  const land = LAND_MANA[base];
  if (land !== undefined) return { mana: land };
  if (TYPE_GLYPH.has(base)) return { glyph: base.toLowerCase(), name: base.toLowerCase() };
  return { name: base };
}

function KindSymbol({ kind }: { kind: string }) {
  const face = kindFace(kind);
  if ('mana' in face) return <ManaPip token={face.mana} titled={false} />;
  if ('glyph' in face) return <i className={`ms ms-${face.glyph}`} role="img" aria-label={face.name} />;
  return <span className="prompt__kind-name">{face.name}</span>;
}

const stateOf = (cover: SlotCover) => (cover.none ? 'none' : cover.by.length === 0 ? 'open' : cover.either ? 'either' : 'held');

/** The rule's kinds, each lit while a pick answers it. */
export function SlotChips({ rule, picks }: { rule: SlotRule; picks: readonly number[] }) {
  return (
    <ul className="prompt__kinds" data-testid="slot-kinds">
      {slotCovers(rule, picks).map((cover, i) => (
        <li key={i} className="prompt__kind" data-testid="slot-kind" data-kind={cover.kind} data-state={stateOf(cover)} data-by={cover.by.join(' ') || undefined}>
          <KindSymbol kind={cover.kind} />
        </li>
      ))}
    </ul>
  );
}

/** On a ticked card: the kinds it answers (`either` ones dashed). */
export function SlotBadges({ rule, picks, id }: { rule: SlotRule; picks: readonly number[]; id: number }) {
  const mine = slotCovers(rule, picks).filter((c) => c.by.includes(id));
  if (mine.length === 0) return null;
  return (
    <span className="prompt__answers" data-testid="slot-answers">
      {mine.map((cover, i) => (
        <span key={i} className="prompt__answer" data-kind={cover.kind} data-state={stateOf(cover)}>
          <KindSymbol kind={cover.kind} />
        </span>
      ))}
    </span>
  );
}

/** The ask's one "one of each" rule, if it has one. */
export const slotRuleOf = (rules: readonly SearchRule[] | undefined): SlotRule | undefined =>
  rules?.find((r): r is SlotRule => r.kind === 'slots');
