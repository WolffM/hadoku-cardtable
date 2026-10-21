/*
 * Gauntlet's options: a format family or Random, then a year of it or Random
 * (the operator, 2026-10-21: *"the leader will optionally select
 * standard/modern/legacy and the year or allow random"*). Only eras the server
 * offers are listed — each holds the ten decks a Gauntlet is drawn from.
 * Leaving both random is `{}`: the server draws the era when both are ready.
 */

import type { GauntletOptions as Options } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../../components/RadioCards.tsx';
import { FORMAT_TABS, type FormatFamily, type GauntletEraOption } from '../tables.ts';

type FamilyCard = FormatFamily | 'random';

/** An era id's year: a Standard id is its `YYYY-MM-DD`, a Modern or Legacy one `<family>-YYYY-MM-DD`. */
const yearOf = (id: string): string => /(\d{4})-\d{2}-\d{2}$/.exec(id)?.[1] ?? id;

export function GauntletOptions({
  eras,
  options,
  leader,
  disabled,
  onChange,
}: {
  /** The server's Gauntlet eras, in its order. */
  eras: readonly GauntletEraOption[];
  options: Options;
  /** Only the leader sets them; everybody else sees the same controls, disabled. */
  leader: boolean;
  disabled: boolean;
  onChange: (options: Options) => void;
}) {
  const families: readonly RadioCard<FamilyCard>[] = [
    ...FORMAT_TABS.filter((tab) => eras.some((e) => e.family === tab.id)).map((tab) => ({ value: tab.id, label: tab.label })),
    { value: 'random', label: 'Random' },
  ];
  const family = options.family ?? null;
  const years = family === null ? [] : eras.filter((e) => e.family === family);
  return (
    <>
      <RadioCards
        name="gauntlet-family"
        label="Gauntlet format"
        options={families}
        value={family ?? 'random'}
        disabled={!leader || disabled}
        onChange={(next) => onChange(next === 'random' ? {} : { family: next })}
        testId="gauntlet-family"
      />
      {family !== null && (
        <select
          data-testid="gauntlet-era"
          aria-label={`${family} year`}
          value={options.era ?? ''}
          disabled={!leader || disabled}
          onChange={(e) => onChange(e.target.value === '' ? { family } : { family, era: e.target.value })}
        >
          <option value="">Random</option>
          {years.map((e) => (
            <option key={e.id} value={e.id} title={e.title}>
              {yearOf(e.id)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
