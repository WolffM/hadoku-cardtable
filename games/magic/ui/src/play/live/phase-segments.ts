/*
 * Wave 89 §B. The portrait phase bar shows 5 segments (Settled 2: Begin, Main,
 * Combat, Main 2, End) instead of the desktop rail's thirteen (sometimes
 * eight, with combat collapsed — `LiveBoard.tsx`'s `railRows`) rows. This is a
 * SEPARATE grouping from `railRows`, not a replacement of it: `railRows`
 * decides what the DESKTOP rail draws (and must keep doing, unchanged, so its
 * one-shot-stop clicks stay per-step), while this file decides what the
 * portrait bar's five boxes say. Both read the same `PHASE_ORDER` — the one
 * list of Forge's `PhaseType` constants in turn order — so the two never
 * drift apart on what step belongs to what part of the turn.
 *
 * Pure and framework-free on purpose: `LiveBoard.tsx`'s `PhaseRail` is the only
 * caller, and it hands this the view's current phase and its own `rowLabel`
 * (so the step's NAME stays the one place that already knows Forge's wording,
 * `../adapter.ts`'s `PHASE_LABEL` — this file invents no words of its own).
 */

/**
 * Forge's `PhaseType` constants in turn order, grouped the way a turn is.
 *
 * Moved here from `LiveBoard.tsx` (wave 89 §B) so the portrait segmenting and
 * the desktop rail read one list rather than two that could disagree about
 * which step is in which part of the turn. The constant names are Forge's
 * (`PhaseType.java:16-28`); the words for them are `PHASE_LABEL`'s, in
 * `../adapter.ts`.
 */
export const PHASE_ORDER: ReadonlyArray<{ phase: string; group: string }> = [
  { phase: 'UNTAP', group: 'begin' },
  { phase: 'UPKEEP', group: 'begin' },
  { phase: 'DRAW', group: 'begin' },
  { phase: 'MAIN1', group: 'main1' },
  { phase: 'COMBAT_BEGIN', group: 'combat' },
  { phase: 'COMBAT_DECLARE_ATTACKERS', group: 'combat' },
  { phase: 'COMBAT_DECLARE_BLOCKERS', group: 'combat' },
  { phase: 'COMBAT_FIRST_STRIKE_DAMAGE', group: 'combat' },
  { phase: 'COMBAT_DAMAGE', group: 'combat' },
  { phase: 'COMBAT_END', group: 'combat' },
  { phase: 'MAIN2', group: 'main2' },
  { phase: 'END_OF_TURN', group: 'end' },
  { phase: 'CLEANUP', group: 'end' },
];

/** The five groups the portrait bar always shows, in turn order — never more, never fewer. */
const SEGMENT_GROUPS = ['begin', 'main1', 'combat', 'main2', 'end'] as const;

export type SegmentGroup = (typeof SEGMENT_GROUPS)[number];

/** Settled 2's own words for the five segments. */
const SEGMENT_LABEL: Readonly<Record<SegmentGroup, string>> = {
  begin: 'Begin',
  main1: 'Main',
  combat: 'Combat',
  main2: 'Main 2',
  end: 'End',
};

/** One of the portrait phase bar's five boxes. */
export interface PhaseSegment {
  group: SegmentGroup;
  /** "Begin" / "Main" / "Combat" / "Main 2" / "End" — Settled 2's words, never Forge's. */
  label: string;
  /** This segment's steps, in turn order (1 for Begin's none — wait, see note: Begin has 3, Main 1, Combat 6, Main 2 1, End 2). */
  steps: readonly string[];
  /** Whether the view's current phase is one of this segment's steps. Exactly one segment is current, or none (an unknown phase, or no view yet). */
  current: boolean;
  /** The current step's own name (`rowLabel`'s), only when this segment is current — Settled 2: "the current one widened to show its step name". */
  stepLabel: string | null;
  /** How many steps this segment has — the tick count Settled 2 asks for ("ticks for its sub-steps"). */
  tickCount: number;
  /** The current step's position within `steps`, or -1 when this segment is not current. */
  tickIndex: number;
}

/**
 * The portrait phase bar's five segments, always in the same order, for the
 * view's current phase (`null` before a view exists). A phase Forge sends
 * that is not one of the thirteen (or no phase yet) leaves every segment
 * `current: false` — the bar shows all five labels and nothing is widened,
 * same honesty `PhaseRail`'s `at < 0` case already keeps for the desktop rail.
 *
 * `rowLabel` is the caller's own step-name function (`LiveBoard.tsx`'s), so
 * this file never duplicates `PHASE_LABEL`'s wording.
 */
export function phaseSegmentsOf(currentPhase: string | null, rowLabel: (phase: string) => string): PhaseSegment[] {
  return SEGMENT_GROUPS.map((group) => {
    const steps = PHASE_ORDER.filter((p) => p.group === group).map((p) => p.phase);
    const tickIndex = currentPhase === null ? -1 : steps.indexOf(currentPhase);
    const current = tickIndex >= 0;
    return {
      group,
      label: SEGMENT_LABEL[group],
      steps,
      current,
      stepLabel: current ? rowLabel(currentPhase as string) : null,
      tickCount: steps.length,
      tickIndex,
    };
  });
}
