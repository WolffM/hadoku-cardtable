/*
 * The draft room's pick timer (wave 83 D3; the operator, 2026-10-30: "allow
 * this to be configurable"): the rope on or off, and its speed over MTR
 * Appendix B's times. The room's `settings.pickTimer`, which freezes once the
 * draft is dealt. The leader moves it; everyone else reads it, disabled — the
 * same switch and cards a constructed room's Match rules draw.
 */

import type { PickTimer } from '@hadoku/shared';

import { ActionButton } from '../components/ActionButton.tsx';
import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';

type Speed = '0.5' | '1' | '2' | '4';
const SPEEDS: readonly RadioCard<Speed>[] = [
  { value: '0.5', label: '½×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '4', label: '4×' },
];

export function PickTimerRule({ timer, leader, disabled, onChange }: { timer: PickTimer; leader: boolean; disabled: boolean; onChange: (timer: PickTimer) => void }) {
  const off = !leader || disabled;
  const speed = SPEEDS.find((s) => Number(s.value) === timer.speed)?.value ?? null;
  return (
    <div className="lobby__rules-list pick-timer-rule">
      <ActionButton
        action={timer.on ? 'pick-timer-off' : 'pick-timer-on'}
        className="lobby__free-pick ct-toggle"
        aria-pressed={timer.on}
        data-testid="pick-timer"
        disabled={off}
        onPress={() => onChange({ ...timer, on: !timer.on })}
      >
        Pick timer
      </ActionButton>
      {timer.on && (
        <RadioCards
          name="pick-timer-speed"
          label="Pick timer speed"
          options={SPEEDS}
          value={speed}
          disabled={off}
          onChange={(value) => onChange({ ...timer, speed: Number(value) })}
          testId="pick-timer-speed"
        />
      )}
    </div>
  );
}
