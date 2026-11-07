/*
 * What the draft room's bots pick with (`settings.draftBots`): CubeCobra's
 * draft model, the cube's pick order, or a split pod (the model on the odd
 * seats, the pick order on the even). The leader moves it; everyone else reads
 * it, disabled, as `PickTimerRule` does.
 */

import type { DraftBots } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';

const BOTS: readonly RadioCard<DraftBots>[] = [
  { value: 'model', label: 'Model' },
  { value: 'pick-order', label: 'Pick order' },
  { value: 'split', label: 'Split' },
];

export function DraftBotsRule({ bots, leader, disabled, onChange }: { bots: DraftBots; leader: boolean; disabled: boolean; onChange: (bots: DraftBots) => void }) {
  return (
    <div className="lobby__rules-list">
      <span className="lobby__rules-label">Bots</span>
      <RadioCards
        name="draft-bots"
        label="Bots"
        options={BOTS}
        value={bots}
        disabled={!leader || disabled}
        onChange={onChange}
        className="lobby__rules-switch"
        testId="draft-bots"
      />
    </div>
  );
}
