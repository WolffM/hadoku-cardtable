/*
 * A room's format pick, as every Constructed mode draws it: a row of tabs (Standard, Modern,
 * Legacy, and whatever else that mode adds) and, under the chosen tab, its years on a `YearSlider`.
 * Classic's pool, Free pick's browse and Gauntlet's era all use these two pieces, so the three read
 * as one control (the operator, 2026-11-09: "please unify the year selector to use the same slider
 * mechanic so we can get rid of duplicate code and unify the UI").
 */

import type { YearStop } from '../../components/YearSlider.tsx';
import { formatEraYear } from '../../front/formatLabel.ts';

export interface FormatTab<T extends string> {
  id: T;
  label: string;
}

/** Eras as a slider's stops: oldest on the left, each at its year. An id with no year is left off. */
export function eraStops(eras: readonly { id: string }[]): YearStop[] {
  return [...eras]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((e) => {
      const year = Number(formatEraYear(e.id));
      return Number.isInteger(year) ? [{ id: e.id, label: String(year), year }] : [];
    });
}

export function FormatTabs<T extends string>({
  tabs,
  value,
  disabled = false,
  testId,
  onChoose,
}: {
  tabs: readonly FormatTab<T>[];
  value: T | null;
  disabled?: boolean;
  /** The row is `<testId>-tabs`, each tab `<testId>-tab-<id>`. */
  testId: string;
  onChoose: (id: T) => void;
}) {
  return (
    <div className="lobby__format-tabs" role="tablist" data-testid={`${testId}-tabs`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="ct-toggle"
          role="tab"
          aria-selected={value === tab.id}
          data-testid={`${testId}-tab-${tab.id}`}
          disabled={disabled}
          onClick={() => onChoose(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
