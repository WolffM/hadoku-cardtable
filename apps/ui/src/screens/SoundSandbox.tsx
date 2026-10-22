/*
 * `#/sounds/sandbox` — scripted scenarios played through the real mixer.
 *
 * Pick a scenario and the two seats' colour identities, press play, and every
 * beat fires through `sound/mixer.ts` exactly as a game will fire it: role
 * plus colour layer, the opponent quieter, bursts collapsed. Each beat's row
 * lights as it fires and says which take played, or why nothing did. A row
 * re-fires on its own ▶, and its gain sliders save straight to the
 * assignments, so a level is tuned here by ear and the builder and the game
 * hear the same number.
 *
 * Mixer levels (bus volumes, the opponent level) are this browser's own, kept
 * in localStorage: they are the listener's preference, not the assignment.
 *
 * Friend tier and above, the same way as the builder: nothing renders until the
 * server's `/api/sounds` has answered (`canView`). Anyone may play a scenario;
 * the gain column, which saves to the assignments, is an admin's (`canEdit`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { REVERSED_ROLES, SOUND_MATRIX, SOUND_ROLES, type CellId, type SoundBus } from '@hadoku/shared';

import { soundsClient, type SoundsClient } from '../sound/builderClient.ts';
import { useSoundAssignments } from '../sound/useSoundAssignments.ts';
import { GainSlider } from '../sound/GainSlider.tsx';
import { DEFAULT_MIX, type MixSettings, type PlanResult } from '../sound/mix.ts';
import { createMixer, type Mixer } from '../sound/mixer.ts';
import { beatEvent, SCENARIOS, type Beat, type Identities, type Scenario } from '../sound/scenarios.ts';
import './SoundBuilder.css';

export interface SoundSandboxProps {
  client?: SoundsClient;
  mixer?: Mixer;
}

const MIX_KEY = 'cardtable.sound.sandbox-mix';
const SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;
/** Fast Mode compresses the timeline and widens the collapse window. */
const FAST_SCALE = 0.4;
const FAST_COLLAPSE_MS = 200;

function loadMix(): MixSettings {
  try {
    const raw = localStorage.getItem(MIX_KEY);
    if (raw === null) return DEFAULT_MIX;
    const v = JSON.parse(raw) as Partial<MixSettings>;
    return { ...DEFAULT_MIX, ...v, bus: { ...DEFAULT_MIX.bus, ...v.bus } };
  } catch {
    return DEFAULT_MIX;
  }
}

function saveMix(mix: MixSettings): void {
  try {
    localStorage.setItem(MIX_KEY, JSON.stringify(mix));
  } catch {
    // Private window or blocked storage: the levels just don't persist.
  }
}

interface Fired {
  plan: PlanResult;
}

const BUS_LABEL: Record<SoundBus, string> = { ui: 'UI', game: 'Game', colour: 'Colour', music: 'Music' };

const SKIP_TEXT = { empty: '—', collapsed: 'collapsed', 'opponent-ui': 'not heard', 'unknown-role': '?' } as const;

export function SoundSandbox({ client: givenClient, mixer: givenMixer }: SoundSandboxProps) {
  const client = useMemo(() => givenClient ?? soundsClient(), [givenClient]);
  const mixer = useMemo(() => givenMixer ?? createMixer((f) => client.takeUrl(f)), [givenMixer, client]);

  const { loaded, canEdit, canView, takes, cells, gains, setGains } = useSoundAssignments(client);
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const [identities, setIdentities] = useState<Identities>({ me: 'RG', opp: 'UB' });
  const [speed, setSpeed] = useState(1);
  const [fast, setFast] = useState(false);
  const [loop, setLoop] = useState(false);
  const [music, setMusic] = useState(false);
  const [mix, setMix] = useState<MixSettings>(loadMix);
  const [playing, setPlaying] = useState(false);
  const [fired, setFired] = useState<ReadonlyMap<number, Fired>>(new Map());
  const [captured, setCaptured] = useState<Scenario | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Read when the run ends, not when it started, so ticking Loop mid-run counts.
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => mixer.planner.setAssignments(cells, gains), [mixer, cells, gains]);
  useEffect(() => {
    mixer.settings = { ...mix, collapseMs: fast ? FAST_COLLAPSE_MS : mix.collapseMs };
    saveMix(mix);
  }, [mixer, mix, fast]);

  const stop = (): void => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    mixer.loop(null);
    setPlaying(false);
  };
  useEffect(() => stop, []);

  const scenarios = captured === null ? SCENARIOS : [...SCENARIOS, captured];
  const scenario = scenarios.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
  const labelOf = useMemo(() => new Map(takes.map((t) => [t.file, t.label])), [takes]);

  const fire = (beat: Beat, index: number): void => {
    const plan = mixer.play(beatEvent(beat, identities));
    setFired((prev) => new Map(prev).set(index, { plan }));
  };

  const play = (): void => {
    stop();
    mixer.preload(Object.values(cells).flat());
    setFired(new Map());
    setPlaying(true);
    if (music) mixer.loop('music.match');
    const scale = (fast ? FAST_SCALE : 1) / speed;
    scenario.beats.forEach((beat, i) => {
      timers.current.push(setTimeout(() => fire(beat, i), beat.at * scale));
    });
    const end = (scenario.beats.at(-1)?.at ?? 0) * scale + 1200;
    timers.current.push(
      setTimeout(() => {
        if (loopRef.current) play();
        else stop();
      }, end),
    );
  };

  async function commitGain(cell: string, gain: number): Promise<void> {
    setGains((g) => ({ ...g, [cell]: gain }));
    await client.save(cell as CellId, cells[cell] ?? [], gain);
  }

  if (!loaded || !canView) return null;

  const setBus = (bus: SoundBus, v: number): void => setMix((m) => ({ ...m, bus: { ...m.bus, [bus]: v } }));

  return (
    <div className="sound-builder sound-sandbox">
      <header className="sound-builder__top">
        <h1>Sound Sandbox</h1>
        <nav className="sound-builder__tabs" aria-label="Sound screens">
          <a className="sound-builder__btn" href="#/sounds">
            Builder
          </a>
          <a className="sound-builder__btn" href="#/sounds/music">
            Music
          </a>
        </nav>
        <div className="sound-sandbox__controls">
          <button
            type="button"
            className="sound-builder__btn sound-builder__btn--primary"
            onClick={playing ? stop : play}
          >
            {playing ? 'Stop' : 'Play'}
          </button>
          <label>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
          </label>
          <label>
            <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /> Fast Mode
          </label>
          <label>
            <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} /> Music
          </label>
          <label>
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          {(['me', 'opp'] as const).map((seat) => (
            <label key={seat}>
              {seat === 'me' ? 'You' : 'Them'}
              <select
                value={identities[seat]}
                onChange={(e) => setIdentities((ids) => ({ ...ids, [seat]: e.target.value }))}
              >
                {SOUND_MATRIX.colour.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div className="sound-sandbox__controls" role="group" aria-label="Mixer">
          {(['ui', 'game', 'colour', 'music'] as const).map((bus) => (
            <Level key={bus} label={BUS_LABEL[bus]} value={mix.bus[bus]} onChange={(v) => setBus(bus, v)} />
          ))}
          <Level label="Opponent" value={mix.opponent} onChange={(v) => setMix((m) => ({ ...m, opponent: v }))} />
        </div>
      </header>

      <div className="sound-builder__panes">
        <aside className="sound-builder__bin" aria-label="Scenarios">
          {scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              className="sound-sandbox__scenario ct-toggle"
              aria-pressed={s.id === scenarioId}
              onClick={() => {
                stop();
                setFired(new Map());
                setScenarioId(s.id);
              }}
            >
              {s.name}
            </button>
          ))}
          {captured === null && (
            <button
              type="button"
              className="sound-sandbox__scenario ct-toggle"
              aria-pressed={false}
              onClick={() => {
                stop();
                void import('../sound/captured.ts').then(({ capturedGameScenario }) => {
                  setCaptured(capturedGameScenario());
                  setFired(new Map());
                  setScenarioId('captured');
                });
              }}
            >
              Captured game
            </button>
          )}
        </aside>

        <main className="sound-builder__main">
          <div className="sound-builder__table-wrap">
            <table className="sound-builder__matrix sound-sandbox__beats">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Beat</th>
                  <th>Heard</th>
                  {canEdit && <th>Gain</th>}
                </tr>
              </thead>
              <tbody>
                {scenario.beats.map((beat, i) => {
                  const event = beatEvent(beat, identities);
                  const roleCell = `${beat.role}|play`;
                  const layerCells = event.colourCell == null ? [roleCell] : [roleCell, event.colourCell];
                  const result = fired.get(i)?.plan;
                  return (
                    <tr key={i} data-fired={result !== undefined ? '' : undefined} data-seat={event.seat}>
                      <td className="sound-sandbox__time">{(beat.at / 1000).toFixed(2)}</td>
                      <th scope="row">
                        <div className="sound-builder__rowname">
                          <span>
                            <button
                              type="button"
                              className="sound-builder__rand"
                              aria-label={`Fire ${beat.label}`}
                              onClick={() => fire(beat, i)}
                            >
                              ▶
                            </button>{' '}
                            {beat.label}
                          </span>
                          <span className="sound-builder__rowsub">
                            {event.seat === 'opp' ? 'Them · ' : ''}
                            {SOUND_ROLES.get(REVERSED_ROLES[beat.role] ?? beat.role)?.name}
                            {event.colourCell != null ? ` + ${event.colourCell}` : ''}
                          </span>
                        </div>
                      </th>
                      <td className="sound-sandbox__heard">
                        {result === undefined
                          ? null
                          : layerCells.map((cell) => {
                              const v = result.voices.find((x) => x.cell === cell);
                              const sk = result.skipped.find((x) => x.cell === cell);
                              return (
                                <div key={cell} data-skipped={sk?.reason}>
                                  {v !== undefined ? (labelOf.get(v.file) ?? v.file) : sk !== undefined ? SKIP_TEXT[sk.reason] : null}
                                </div>
                              );
                            })}
                      </td>
                      {canEdit && (
                        <td>
                          {layerCells.map((cell) =>
                            (cells[cell] ?? []).length > 0 ? (
                              <GainSlider
                                key={cell}
                                label={cell}
                                value={gains[cell] ?? 1}
                                onCommit={(v) => void commitGain(cell, v)}
                              />
                            ) : null,
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}

function Level({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="sound-gain">
      {label}
      <input
        type="range"
        min={0}
        max={1.5}
        step={0.05}
        value={value}
        aria-label={`${label} level`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{value.toFixed(2)}</output>
    </label>
  );
}
