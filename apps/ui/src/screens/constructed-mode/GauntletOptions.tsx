/*
 * Gauntlet's options: a format family or Random, then a year of it or Random
 * (the operator, 2026-10-21: *"the leader will optionally select
 * standard/modern/legacy and the year or allow random"*). Only eras the server
 * offers are listed — each holds the ten decks a Gauntlet is drawn from.
 * Leaving both random is `{}`: the server draws the era when both are ready.
 *
 * Drawn as Classic draws its pool: the format tabs, then the year slider, with
 * the slider's one stop that is not a year, left of the oldest, for Random.
 */

import type { GauntletOptions as Options } from '@hadoku/shared';

import { YearSlider, type YearStop } from '../../components/YearSlider.tsx';
import { FORMAT_TABS, type FormatFamily, type GauntletEraOption } from '../tables.ts';
import { eraStops, FormatTabs, type FormatTab } from './FormatTabs.tsx';

type FamilyTab = FormatFamily | 'random';

/** The year stop that is not a year: the server draws one. */
const RANDOM_YEAR: YearStop = { id: '', label: 'Random', year: null };

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
  const families: readonly FormatTab<FamilyTab>[] = [...FORMAT_TABS.filter((tab) => eras.some((e) => e.family === tab.id)), { id: 'random', label: 'Random' }];
  const family = options.family ?? null;
  const locked = !leader || disabled;
  return (
    <>
      <FormatTabs
        tabs={families}
        value={family ?? 'random'}
        disabled={locked}
        testId="gauntlet"
        onChoose={(next) => {
          if (next !== (family ?? 'random')) onChange(next === 'random' ? {} : { family: next });
        }}
      />
      {family !== null && (
        <YearSlider
          testId="gauntlet-era"
          label={`${FORMAT_TABS.find((t) => t.id === family)!.label} year`}
          stops={[RANDOM_YEAR, ...eraStops(eras.filter((e) => e.family === family))]}
          value={options.era ?? ''}
          disabled={locked}
          onChange={(era) => onChange(era === '' ? { family } : { family, era })}
        />
      )}
    </>
  );
}
