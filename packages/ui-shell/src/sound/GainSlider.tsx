/*
 * A cell's gain, 0..2 (1 is as recorded). It moves freely while dragged and
 * commits once on release, so a drag is one save rather than fifty.
 */

import { useEffect, useState } from 'react';

export interface GainSliderProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

export function GainSlider({ label, value, onCommit }: GainSliderProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const commit = (): void => {
    if (local !== value) onCommit(local);
  };

  return (
    <span className="sound-gain">
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={local}
        aria-label={`${label} gain`}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <output>{local.toFixed(2)}</output>
    </span>
  );
}
