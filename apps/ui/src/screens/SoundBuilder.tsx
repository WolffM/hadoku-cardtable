/*
 * `#/sounds` — the sound builder, admin-gated, server-hosted.
 *
 * A React port of the operator-approved artifact
 * (`docs/handoff/snapshot/builder.html`), kept behaviourally identical (wave
 * 50's "Settled" section is binding): the bin holds the keepers as dense pill
 * rows; click a pill to hear it and pick it up, then click a cell to drop it
 * there (dragging also works, between the bin and a cell or between two
 * cells); Esc puts a held pill down; a cell with more than one take plays one
 * at random on its own click and never repeats the one before it; a placed
 * pill plays on click and `×` removes it; a mono colour identity's Land cell
 * is labelled with its basic land name; "Play a sample turn" sequences the
 * assignments on the artifact's own timeline, overlapping through an 8-voice
 * pool. **No "holding" banner** — the operator asked for exactly that removed
 * from the artifact, and nothing here replaces it with one.
 *
 * ## The gate is the server's, not a client guess
 *
 * `GET /api/sounds/assignments` answers `{ cells, canEdit }`, and `canEdit` is
 * `rankOf(tier) >= rankOf('admin')` computed server-side from the edge-stamped
 * tier — never a header this client could set. Reads are friend tier, so a
 * non-admin's request still succeeds; this screen renders nothing useful
 * either way until it has seen `canEdit === true`. There is no link to this
 * route from anywhere else in the app, so a friend only ever lands here by
 * typing the hash.
 *
 * ## Saving is per cell, optimistic, and silent on failure
 *
 * Every add, remove or drag writes ONE cell with `PUT
 * /api/sounds/assignments/:cell`. The local state updates immediately; a save
 * that fails (403 if the tier changed mid-session, a network blip) leaves the
 * attempted value on screen and marks the cell `data-unsaved` — a border, no
 * text — because "explain what went wrong" is the one thing the house style
 * for this app refuses to do in prose.
 *
 * ## Why the matrix and the bin are plain markup, not canvas
 *
 * 27 colour identities × 5 paradigms plus 13 events is ~150 cells and a bin of
 * however many keepers exist; a `<table>` wrapped in its own scrolling box
 * (`.sound-builder__table-wrap`) keeps the PAGE from scrolling sideways at
 * phone width while the matrix itself does, which is the same trick the
 * artifact used (`.tw { overflow-x: auto }`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { SOUND_MATRIX, type CellId, type SoundTake } from '@hadoku/shared';

import { ManaCost } from '../components/ManaPip.tsx';
import {
  createAudioPool,
  pickRandom,
  soundsClient,
  type AudioPool,
  type SoundsClient,
} from '../sound/builderClient.ts';
import './SoundBuilder.css';

export interface SoundBuilderProps {
  /** Tests pass a stub. Production builds the real fetch-backed client. */
  client?: SoundsClient;
  /** Tests pass a stub. Production builds the real 8-voice pool. */
  audioPool?: AudioPool;
}

const FAMILY_LABEL: Record<string, string> = {
  mono: 'Mono',
  guild: 'Guilds',
  shard: 'Shards',
  wedge: 'Wedges',
  four: 'Four or more',
  extra: 'Colourless',
};

/** The artifact's own sequence: a colour identity's four paradigms plus nine events, overlapping. */
function sampleSteps(identityId: string): readonly [number, string, string][] {
  return [
    [0, 'm-turn|play', 'Your turn'],
    [450, 'm-draw|play', 'Draw'],
    [1050, `${identityId}|land`, 'Land'],
    [1250, 'm-tapcard|play', 'Tap'],
    [1900, `${identityId}|spell`, 'Spell'],
    [2500, 'm-resolve|play', 'Resolves'],
    [3100, `${identityId}|creature`, 'Creature'],
    [3900, 'm-phase|play', 'Phase'],
    [4200, 'm-attack|play', 'Attack'],
    [4600, 'm-block|play', 'Block'],
    [5000, 'm-damage|play', 'Damage to creature'],
    [5150, 'm-damage-player|play', 'Damage to player'],
    [5450, 'm-dies|play', 'Creature dies'],
    [6200, `${identityId}|artifact`, 'Artifact'],
  ];
}

/** `"Water · 1a"` → `"1a"`: the pill's own label minus the sound name the bin row already carries. */
function shortLabel(take: SoundTake): string {
  const parts = take.label.split(' · ');
  return parts.length > 1 ? parts.slice(1).join(' · ') : take.label;
}

interface DragPayload {
  file: string;
  from: string | null;
}

function parseDragPayload(raw: string): DragPayload | null {
  try {
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { file, from } = v as Record<string, unknown>;
    if (typeof file !== 'string') return null;
    return { file, from: typeof from === 'string' ? from : null };
  } catch {
    return null;
  }
}

export function SoundBuilder({ client: givenClient, audioPool: givenPool }: SoundBuilderProps) {
  const client = useMemo(() => givenClient ?? soundsClient(), [givenClient]);
  const pool = useMemo(() => givenPool ?? createAudioPool(client), [givenPool, client]);

  const [loaded, setLoaded] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [takes, setTakes] = useState<SoundTake[]>([]);
  const [cells, setCells] = useState<Record<string, string[]>>({});
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(new Set());
  const [holding, setHolding] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string>(SOUND_MATRIX.colour[0]?.id ?? '');
  const [log, setLog] = useState<string[]>([]);
  const lastPickRef = useRef<Map<string, string>>(new Map());
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    let alive = true;
    void Promise.all([client.catalogue(), client.assignments()]).then(([t, a]) => {
      if (!alive) return;
      setTakes(t);
      setCells(a.cells);
      setCanEdit(a.canEdit);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [client]);

  // Esc puts a held take down, wherever the focus is — the artifact's own rule.
  useEffect(() => {
    if (holding === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHolding(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [holding]);

  // Clear any in-flight "sample turn" timers on unmount.
  useEffect(
    () => () => {
      for (const id of timersRef.current) clearTimeout(id);
    },
    [],
  );

  const byFile = useMemo(() => {
    const m = new Map<string, SoundTake>();
    for (const t of takes) m.set(t.file, t);
    return m;
  }, [takes]);

  const placed = useMemo(() => {
    const s = new Set<string>();
    for (const files of Object.values(cells)) for (const f of files) s.add(f);
    return s;
  }, [cells]);

  async function persist(cell: string, files: string[]): Promise<void> {
    setCells((c) => ({ ...c, [cell]: files }));
    const saved = await client.save(cell as CellId, files);
    setUnsaved((prev) => {
      const next = new Set(prev);
      if (saved === null) next.add(cell);
      else next.delete(cell);
      return next;
    });
  }

  function addTo(cell: string, file: string): void {
    const cur = cells[cell] ?? [];
    if (cur.includes(file)) return;
    void persist(cell, [...cur, file]);
  }

  function removeFrom(cell: string, file: string): void {
    const cur = cells[cell] ?? [];
    void persist(
      cell,
      cur.filter((f) => f !== file),
    );
  }

  function onDropOnCell(cell: string, e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    const data = parseDragPayload(e.dataTransfer.getData('text/plain'));
    if (data === null || data.from === cell) return;
    if (data.from !== null) {
      const src = (cells[data.from] ?? []).filter((f) => f !== data.file);
      void persist(data.from, src);
    }
    addTo(cell, data.file);
  }

  function playRandom(cell: string, files: string[]): void {
    const file = pickRandom(files, lastPickRef.current.get(cell) ?? null);
    if (file === null) return;
    lastPickRef.current.set(cell, file);
    void pool.play(file);
  }

  function sampleTurn(): void {
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current = [];
    setLog([]);
    const heard: string[] = [];
    for (const [at, cellId, name] of sampleSteps(sampleId)) {
      const id = setTimeout(() => {
        const files = cells[cellId] ?? [];
        const file = pickRandom(files, lastPickRef.current.get(cellId) ?? null);
        if (file !== null) lastPickRef.current.set(cellId, file);
        const take = file !== null ? byFile.get(file) : undefined;
        heard.push(`${(at / 1000).toFixed(2)}s ${name}: ${take !== undefined ? take.label : 'nothing assigned'}`);
        setLog([...heard]);
        if (file !== null) void pool.play(file);
      }, at);
      timersRef.current.push(id);
    }
  }

  if (!loaded || !canEdit) return null;

  const total = SOUND_MATRIX.colour.length * SOUND_MATRIX.paradigms.length + SOUND_MATRIX.events.length;
  const filled = Object.values(cells).filter((f) => f.length > 0).length;

  const bySound = new Map<string, SoundTake[]>();
  const order: string[] = [];
  for (const t of takes) {
    const key = `${t.section}\u0000${t.group}\u0000${t.name}`;
    if (!bySound.has(key)) {
      bySound.set(key, []);
      order.push(key);
    }
    bySound.get(key)!.push(t);
  }

  let sec: string | null = null;
  let grp: string | null = null;

  return (
    <div className="sound-builder">
      <header className="sound-builder__top">
        <h1>Sound Builder</h1>
        <div className="sound-builder__counts">
          <span>
            <b>
              {filled}/{total}
            </b>{' '}
            cells
          </span>
          <span>
            <b>{placed.size}</b> placed
          </span>
          <span>
            <b>{takes.length}</b> keepers
          </span>
        </div>
        <div className="sound-builder__sample" role="group" aria-label="Sample turn">
          <label htmlFor="sound-builder-sample-id">Sample turn as</label>
          <select id="sound-builder-sample-id" value={sampleId} onChange={(e) => setSampleId(e.target.value)}>
            {SOUND_MATRIX.colour.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" className="sound-builder__btn sound-builder__btn--primary" onClick={sampleTurn}>
            Play a sample turn
          </button>
        </div>
      </header>

      <div className="sound-builder__panes">
        <aside className="sound-builder__bin" aria-label="Your keepers">
          {order.map((key) => {
            const [s, g, n] = key.split('\u0000') as [string, string, string];
            const list = bySound.get(key)!;
            const showSec = s !== sec;
            if (showSec) {
              sec = s;
              grp = null;
            }
            const showSub = s === 'Library' && g !== grp;
            if (showSub) grp = g;
            return (
              <div key={key}>
                {showSec && <div className="sound-builder__sec">{s}</div>}
                {showSub && <div className="sound-builder__subsec">{g}</div>}
                <div className="sound-builder__srow">
                  <span className="sound-builder__srow-name" title={n}>
                    {n}
                  </span>
                  <div className="sound-builder__pills">
                    {list.map((t) => (
                      <button
                        key={t.file}
                        type="button"
                        className="sound-builder__pill"
                        data-placed={placed.has(t.file) ? '' : undefined}
                        aria-pressed={holding === t.file}
                        aria-label={`${t.label}: play and pick up`}
                        title={t.prompt}
                        draggable
                        onDragStart={(e) =>
                          e.dataTransfer.setData('text/plain', JSON.stringify({ file: t.file, from: null }))
                        }
                        onClick={() => {
                          void pool.play(t.file);
                          setHolding((h) => (h === t.file ? null : t.file));
                        }}
                      >
                        {shortLabel(t)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </aside>

        <main className="sound-builder__main">
          <section className="sound-builder__section">
            <h2>Colour identities</h2>
            <div className="sound-builder__table-wrap">
              <table className="sound-builder__matrix">
                <thead>
                  <tr>
                    <th>Identity</th>
                    {SOUND_MATRIX.paradigms.map((p) => (
                      <th key={p.id}>{p.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let fam: string | null = null;
                    return SOUND_MATRIX.colour.map((row) => {
                      const famHeader = row.family !== fam;
                      fam = row.family;
                      return (
                        <ColourRowEl
                          key={row.id}
                          row={row}
                          famHeader={famHeader}
                          cells={cells}
                          byFile={byFile}
                          holding={holding}
                          unsaved={unsaved}
                          onAddTo={addTo}
                          onRemoveFrom={removeFrom}
                          onDrop={onDropOnCell}
                          onPlayRandom={playRandom}
                          onPlayPill={(f) => void pool.play(f)}
                        />
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </section>

          <section className="sound-builder__section">
            <h2>Events</h2>
            <div className="sound-builder__table-wrap">
              <table className="sound-builder__matrix">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Sounds (one plays at random)</th>
                  </tr>
                </thead>
                <tbody>
                  {SOUND_MATRIX.events.map((row) => {
                    const cellId = `${row.id}|play`;
                    const files = cells[cellId] ?? [];
                    return (
                      <tr key={row.id}>
                        <th scope="row">
                          <div className="sound-builder__rowname">
                            <span>{row.name}</span>
                            <span className="sound-builder__rowsub">{row.sub}</span>
                          </div>
                        </th>
                        <td>
                          <Cell
                            cellId={cellId}
                            files={files}
                            byFile={byFile}
                            holding={holding}
                            unsaved={unsaved.has(cellId)}
                            onAddTo={addTo}
                            onRemoveFrom={removeFrom}
                            onDrop={onDropOnCell}
                            onPlayRandom={playRandom}
                            onPlayPill={(f) => void pool.play(f)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="sound-builder__section">
            <h2>Last sample turn</h2>
            <div className="sound-builder__log">{log.join('\n')}</div>
          </section>
        </main>
      </div>
    </div>
  );
}

interface ColourRowProps {
  row: (typeof SOUND_MATRIX.colour)[number];
  famHeader: boolean;
  cells: Record<string, string[]>;
  byFile: Map<string, SoundTake>;
  holding: string | null;
  unsaved: ReadonlySet<string>;
  onAddTo: (cell: string, file: string) => void;
  onRemoveFrom: (cell: string, file: string) => void;
  onDrop: (cell: string, e: React.DragEvent<HTMLDivElement>) => void;
  onPlayRandom: (cell: string, files: string[]) => void;
  onPlayPill: (file: string) => void;
}

function ColourRowEl({
  row,
  famHeader,
  cells,
  byFile,
  holding,
  unsaved,
  onAddTo,
  onRemoveFrom,
  onDrop,
  onPlayRandom,
  onPlayPill,
}: ColourRowProps) {
  return (
    <>
      {famHeader && (
        <tr className="sound-builder__fam">
          <td colSpan={SOUND_MATRIX.paradigms.length + 1}>{FAMILY_LABEL[row.family] ?? row.family}</td>
        </tr>
      )}
      <tr>
        <th scope="row">
          <div className="sound-builder__rowname">
            <ManaCost cost={row.colours} label={row.name} />
            <span>{row.name}</span>
          </div>
        </th>
        {SOUND_MATRIX.paradigms.map((p) => {
          const cellId = `${row.id}|${p.id}`;
          const files = cells[cellId] ?? [];
          const hint =
            p.id === 'land'
              ? (SOUND_MATRIX.landNames as Record<string, string | undefined>)[row.id]
              : undefined;
          return (
            <td key={p.id}>
              <Cell
                cellId={cellId}
                files={files}
                hint={hint}
                byFile={byFile}
                holding={holding}
                unsaved={unsaved.has(cellId)}
                onAddTo={onAddTo}
                onRemoveFrom={onRemoveFrom}
                onDrop={onDrop}
                onPlayRandom={onPlayRandom}
                onPlayPill={onPlayPill}
              />
            </td>
          );
        })}
      </tr>
    </>
  );
}

interface CellProps {
  cellId: string;
  files: string[];
  hint?: string;
  byFile: Map<string, SoundTake>;
  holding: string | null;
  unsaved: boolean;
  onAddTo: (cell: string, file: string) => void;
  onRemoveFrom: (cell: string, file: string) => void;
  onDrop: (cell: string, e: React.DragEvent<HTMLDivElement>) => void;
  onPlayRandom: (cell: string, files: string[]) => void;
  onPlayPill: (file: string) => void;
}

function Cell({
  cellId,
  files,
  hint,
  byFile,
  holding,
  unsaved,
  onAddTo,
  onRemoveFrom,
  onDrop,
  onPlayRandom,
  onPlayPill,
}: CellProps) {
  return (
    <div
      className="sound-builder__cell"
      data-cell={cellId}
      data-unsaved={unsaved ? '' : undefined}
      onClick={() => {
        if (holding !== null) onAddTo(cellId, holding);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(cellId, e)}
    >
      {files.length > 0 ? (
        <>
          <button
            type="button"
            className="sound-builder__rand"
            aria-label={`Play one of ${files.length} at random`}
            title={files.length > 1 ? `${files.length} variations, one at random` : '1 take'}
            onClick={(e) => {
              if (holding !== null) return;
              e.stopPropagation();
              onPlayRandom(cellId, files);
            }}
          >
            ▶
          </button>
          {files.map((f) => {
            const take = byFile.get(f);
            if (take === undefined) return null;
            return (
              <span
                key={f}
                className="sound-builder__pill sound-builder__pill--placed"
                title={take.prompt}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData('text/plain', JSON.stringify({ file: f, from: cellId }))
                }
                onClick={(e) => {
                  if (holding !== null) return;
                  e.stopPropagation();
                  onPlayPill(f);
                }}
              >
                {take.label}
                <button
                  type="button"
                  className="sound-builder__pill-remove"
                  aria-label={`Remove ${take.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFrom(cellId, f);
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </>
      ) : hint !== undefined ? (
        <span className="sound-builder__hint">{hint}</span>
      ) : null}
    </div>
  );
}
