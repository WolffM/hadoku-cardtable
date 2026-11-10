/*
 * Gauntlet's options: a format family or Random, and a year or Random (the operator, 2026-10-21:
 * *"the leader will optionally select standard/modern/legacy and the year or allow random"*). The
 * two are independent, and the year is always drawn: a year with Random for the family draws one of
 * the families that have an era that year (the operator, 2026-11-10). Only years the server offers
 * are on the slider — each era it offers holds the ten decks a Gauntlet is drawn from. Leaving both
 * random is `{}`: the server draws the era when both are ready.
 *
 * Drawn as Classic draws its pool: the format tabs, then the year slider, with the slider's one stop
 * that is not a year, left of the oldest, for Random.
 */

import type { GauntletOptions as Options } from '@hadoku/shared';

import { YearSlider, type YearStop } from '../../components/YearSlider.tsx';
import { formatEraYear } from '../../front/formatLabel.ts';
import { FORMAT_TABS, type FormatFamily, type GauntletEraOption } from '../tables.ts';
import { FormatTabs, type FormatTab } from './FormatTabs.tsx';

type FamilyTab = FormatFamily | 'random';

/** The year stop that is not a year: the server draws one. */
const RANDOM_YEAR: YearStop = { id: '', label: 'Random', year: null };

/** The years `eras` cover, oldest first. */
function yearsOf(eras: readonly GauntletEraOption[]): number[] {
  return [...new Set(eras.map((e) => Number(formatEraYear(e.id))).filter(Number.isInteger))].sort((a, b) => a - b);
}

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
  const { family, year } = options;
  const yearsFor = (f: FormatFamily | undefined): number[] => yearsOf(f === undefined ? eras : eras.filter((e) => e.family === f));
  const locked = !leader || disabled;
  return (
    <>
      <FormatTabs
        tabs={families}
        value={family ?? 'random'}
        disabled={locked}
        testId="gauntlet"
        onChoose={(next) => {
          const to = next === 'random' ? undefined : next;
          if (to === family) return;
          // The year stays when the new family has it; otherwise it goes back to Random.
          const kept = year !== undefined && yearsFor(to).includes(year) ? year : undefined;
          onChange({ ...(to === undefined ? {} : { family: to }), ...(kept === undefined ? {} : { year: kept }) });
        }}
      />
      <YearSlider
        testId="gauntlet-era"
        label={`${families.find((t) => t.id === (family ?? 'random'))!.label} year`}
        stops={[RANDOM_YEAR, ...yearsFor(family).map((y) => ({ id: String(y), label: String(y), year: y }))]}
        value={year === undefined ? '' : String(year)}
        disabled={locked}
        onChange={(id) => onChange({ ...(family === undefined ? {} : { family }), ...(id === '' ? {} : { year: Number(id) }) })}
      />
    </>
  );
}
