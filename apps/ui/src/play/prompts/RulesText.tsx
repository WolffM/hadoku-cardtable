/*
 * Forge's own words with its `{…}` symbols drawn as symbols.
 *
 * The operator, 2026-10-06: *"when showing costs in the decision boxes lets show
 * the actual mana cost icons not 'B'"*. `plainRulesText` flattens `{1}{B}` to
 * `1B` because it feeds strings: aria-labels, keys, the log. A decision box's
 * VISIBLE text renders through this instead, and keeps those strings as they are.
 *
 * A token the Mana font has a glyph for (colours, generic numbers, hybrid,
 * Phyrexian, tap/untap, snow, X…) is a `ManaPip`, the same component card costs
 * and the mana pool use (D20). Anything else falls back to `plainRulesText`'s
 * own words, so nothing reads worse than before.
 */

import { Fragment } from 'react';

import { colorWordToken, ManaPip, readManaToken } from '../../components/ManaPip.tsx';

import { plainRulesText, promptText } from './lookup.ts';

const SYMBOL = /\{([^}]{1,5})\}/g;

export function RulesText({ text }: { text: string }) {
  const src = promptText(text);
  // A caller whose WHOLE label is one of Forge's colour words — a bare
  // `getChoices` option ("Black") beside a card tile's own `RulesText` fall-
  // through (`ChoicePrompts.tsx`'s `GetChoicesPrompt`, `GetAbilityToPlayPrompt`)
  // — draws the symbol, not the word (the operator, repeated: Z10, Y23, AD6,
  // 2026-10-08, Underground River). Exact-match only: prose that merely
  // MENTIONS a colour ("target black creature") is never this.
  const bareColour = colorWordToken(src);
  if (bareColour !== null) return <ManaPip token={bareColour} />;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of src.matchAll(SYMBOL)) {
    const i = m.index ?? 0;
    if (i > at) parts.push(src.slice(at, i));
    const token = m[1]!;
    parts.push(readManaToken(token).mana !== null ? <ManaPip key={`${i}-${token}`} token={token} /> : plainRulesText(m[0]));
    at = i + m[0].length;
  }
  if (at < src.length) parts.push(src.slice(at));
  return <>{parts.map((p, i) => (typeof p === 'string' ? <Fragment key={`t${i}`}>{p}</Fragment> : p))}</>;
}
