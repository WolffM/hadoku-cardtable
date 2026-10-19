/*
 * The sound section of cardtable's settings (`./Settings.tsx`): mute, overall
 * volume, the music's level under everything else, and the match music's style
 * (normal or 16-bit; a switch mid-match plays the same slot's other track). The values live in
 * `../sound/mute.ts`; `../sound/index.ts` applies a change to the mixer at
 * once, music included, so a slider is heard as it moves.
 */

import { useSyncExternalStore } from 'react';
import { Icon } from '@wolffm/themes';

import { MUSIC_STYLES, type MusicStyle } from '@hadoku/shared';

import {
  LEVEL_DEFAULTS,
  getLevel,
  getMusicStyle,
  isMuted,
  playRole,
  setLevel,
  setMusicStyle,
  setMuted,
  subscribeSound,
  type LevelName,
} from '../sound/index.ts';

const STYLE_LABEL: Record<MusicStyle, string> = { normal: 'Normal', chiptune: '16-bit' };

function MusicStylePicker({ disabled }: { disabled: boolean }) {
  const style = useSyncExternalStore(subscribeSound, getMusicStyle, () => 'normal' as const);
  return (
    <div className="ct-settings__level">
      <span id="ct-settings-music-style">Style</span>
      <div className="segmented" role="group" aria-labelledby="ct-settings-music-style" data-testid="settings-music-style">
        {MUSIC_STYLES.map((s) => (
          <button
            key={s}
            type="button"
            className={style === s ? 'segmented__on' : ''}
            aria-pressed={style === s}
            data-style={s}
            disabled={disabled}
            onClick={() => setMusicStyle(s)}
          >
            {STYLE_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

function LevelSlider({ name, label, disabled }: { name: LevelName; label: string; disabled: boolean }) {
  const value = useSyncExternalStore(subscribeSound, () => getLevel(name), () => LEVEL_DEFAULTS[name]);
  return (
    <label className="ct-settings__level">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        disabled={disabled}
        data-testid={`settings-${name}`}
        onChange={(event) => setLevel(name, Number(event.currentTarget.value) / 100)}
        // A sample at the new level once the slider is let go, not on every step of the drag.
        onPointerUp={() => playRole('ui.select')}
        onKeyUp={() => playRole('ui.select')}
      />
    </label>
  );
}

export function SoundSettings() {
  const muted = useSyncExternalStore(subscribeSound, isMuted, () => false);
  return (
    <fieldset className="ct-settings__section" data-testid="settings-sound">
      <legend>Sound</legend>
      <label className="ct-settings__option">
        <input
          type="checkbox"
          data-testid="settings-sound-on"
          checked={!muted}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            setMuted(!on);
            // Unmuting makes a noise, so the state you hear is the state you are in.
            if (on) playRole('ui.select');
          }}
        />
        <Icon name={muted ? 'volume-mute' : 'volume-high'} size="1rem" />
        Sound on
      </label>
      <LevelSlider name="volume" label="Volume" disabled={muted} />
      <LevelSlider name="music" label="Music" disabled={muted} />
      <MusicStylePicker disabled={muted} />
    </fieldset>
  );
}
