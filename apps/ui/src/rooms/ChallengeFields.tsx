/*
 * Create a room's Challenge fields: which real event, the field it replays (its top 8 as a
 * bracket, or everyone, Swiss then the cut), and whose seat the creator takes. The server seats
 * every other player as an AI on their own list (`games/magic/server/src/room/challenge.ts`).
 */

import type { ChallengeEvent, ChallengeField } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';

export interface ChallengeChoice {
  collection: string;
  player: string;
  field: ChallengeField;
}

const TOP = 8;

const FIELD_CARDS: readonly RadioCard<ChallengeField>[] = [
  { value: 'top8', label: 'Top 8' },
  { value: 'full', label: 'Full field' },
];

/** The players a field seats, best finish first. */
export function fieldOf(event: ChallengeEvent, field: ChallengeField): ChallengeEvent['standings'] {
  return field === 'top8' ? event.standings.slice(0, TOP) : event.standings;
}

/** The first choice an event offers: its top 8, as its champion. */
export function firstChoice(event: ChallengeEvent): ChallengeChoice {
  return { collection: event.collection, player: event.standings[0]!.player, field: 'top8' };
}

/**
 * `next` with its player kept when the field still seats them, else the field's champion: narrowing
 * to the top 8, or moving to another event, never leaves a player the server would refuse.
 */
export function settled(events: readonly ChallengeEvent[], next: ChallengeChoice): ChallengeChoice {
  const event = events.find((e) => e.collection === next.collection) ?? events[0]!;
  const seated = fieldOf(event, next.field);
  return { collection: event.collection, field: next.field, player: seated.some((s) => s.player === next.player) ? next.player : seated[0]!.player };
}

export function ChallengeFields({
  idPrefix,
  events,
  value,
  onChange,
}: {
  idPrefix: string;
  events: readonly ChallengeEvent[];
  value: ChallengeChoice;
  onChange: (next: ChallengeChoice) => void;
}) {
  const event = events.find((e) => e.collection === value.collection) ?? events[0]!;
  const set = (patch: Partial<ChallengeChoice>): void => onChange(settled(events, { ...value, ...patch }));
  return (
    <>
      <label htmlFor={`${idPrefix}-challenge`}>Challenge</label>
      <select id={`${idPrefix}-challenge`} data-testid={`${idPrefix}-challenge`} value={event.collection} onChange={(e) => set({ collection: e.target.value })}>
        {events.map((e) => (
          <option key={e.collection} value={e.collection}>
            {e.name}, {e.date}
          </option>
        ))}
      </select>

      <span className="rooms__caption">Field</span>
      <RadioCards name={`${idPrefix}-field`} label="Field" options={FIELD_CARDS} value={value.field} onChange={(field) => set({ field })} testId={`${idPrefix}-field`} />

      <label htmlFor={`${idPrefix}-player`}>Play as</label>
      <select id={`${idPrefix}-player`} data-testid={`${idPrefix}-player`} value={value.player} onChange={(e) => set({ player: e.target.value })}>
        {fieldOf(event, value.field).map((s) => (
          <option key={s.rank} value={s.player}>
            {s.rank}. {s.player}
          </option>
        ))}
      </select>
    </>
  );
}
