/*
 * The sound section of cardtable's settings (`./Settings.tsx`): mute, overall
 * volume, the music's level under everything else, and the track the music
 * plays: its name, and a choice among the role's tracks when it has more than
 * one (the operator, 2026-10-20). The values live in `../sound/mute.ts`;
 * `../sound/index.ts` applies a change to the mixer at once, music included,
 * so a slider is heard as it moves and a new track crossfades in.
 */

import { useSyncExternalStore } from 'react';
import { Icon } from '@wolffm/themes';

import {
  LEVEL_DEFAULTS,
  getLevel,
  getMusicTrack,
  isMuted,
  playRole,
  setLevel,
  setMusicPick,
  setMuted,
  subscribeMusicTrack,
  subscribeSound,
  type LevelName,
} from '../sound/index.ts';
import { trackName } from '../sound/match-music.ts';
import { uiLength } from './ui-scale.ts';

function MusicTrackPicker({ disabled }: { disabled: boolean }) {
  const now = useSyncExternalStore(subscribeMusicTrack, getMusicTrack, () => null);
  if (now === null) return null;
  const current = now.tracks.find((t) => t.file === now.file)?.name ?? now.file;
  return (
    <label className="ct-settings__level">
      <span>Track</span>
      {now.tracks.length > 1 ? (
        <select
          data-testid="settings-music-track"
          value={now.file}
          disabled={disabled}
          onChange={(event) => setMusicPick(now.role, event.currentTarget.value)}
        >
          {now.tracks.map((t) => (
            <option key={t.file} value={t.file}>
              {trackName(t.name)}
            </option>
          ))}
        </select>
      ) : (
        <output data-testid="settings-music-track">{trackName(current)}</output>
      )}
    </label>
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
        <Icon name={muted ? 'volume-mute' : 'volume-high'} size={uiLength('1rem')} />
        Sound on
      </label>
      <LevelSlider name="volume" label="Volume" disabled={muted} />
      <LevelSlider name="music" label="Music" disabled={muted} />
      <MusicTrackPicker disabled={muted} />
    </fieldset>
  );
}
