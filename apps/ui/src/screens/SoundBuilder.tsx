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
 * is labelled with its basic land name. **No "holding" banner** — the operator
 * asked for exactly that removed from the artifact, and nothing here replaces
 * it with one.
 *
 * ## Roles and colours
 *
 * Two tabs. **Roles** lists `SOUND_ROLE_GROUPS`, the generic layer every event
 * plays. **Colours** is the identity × paradigm matrix, the layer mixed on top.
 * Every filled cell has a gain slider, saved beside its takes, so a level is
 * tuned once and the game and the sandbox both hear it. Scenarios live in the
 * sandbox (`#/sounds/sandbox`), which replaced the old "sample turn".
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
 * 27 colour identities × 5 paradigms, a basic land on the 5 mono rows, plus the roles is ~190 cells and a bin of
 * however many keepers exist; a `<table>` wrapped in its own scrolling box
 * (`.sound-builder__table-wrap`) keeps the PAGE from scrolling sideways at
 * phone width while the matrix itself does, which is the same trick the
 * artifact used (`.tw { overflow-x: auto }`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  rowHasParadigm,
  SOUND_MATRIX,
  SOUND_ROLE_GROUPS,
  SOUND_ROLES,
  type CellId,
  type RetireReason,
  type SoundMark,
  type SoundTake,
} from '@hadoku/shared';

import { ManaCost } from '../components/ManaPip.tsx';
import { pickRandom, soundsClient, type SoundsClient } from '../sound/builderClient.ts';
import { GainSlider } from '../sound/GainSlider.tsx';
import { createMixer, type Mixer } from '../sound/mixer.ts';
import { SoundQueue } from './SoundQueue.tsx';
import './SoundBuilder.css';

export interface SoundBuilderProps {
  /** Tests pass a stub. Production builds the real fetch-backed client. */
  client?: SoundsClient;
  /** Tests pass a stub. Production builds the real mixer. */
  player?: Pick<Mixer, 'playFile'>;
}

type Tab = 'roles' | 'colours' | 'queue';

const TAB_LABEL: Record<Tab, string> = { roles: 'Roles', colours: 'Colours', queue: 'Queue' };

const FAMILY_LABEL: Record<string, string> = {
  mono: 'Mono',
  guild: 'Guilds',
  shard: 'Shards',
  wedge: 'Wedges',
  four: 'Four or more',
  extra: 'Colourless',
};

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

export function SoundBuilder({ client: givenClient, player: givenPlayer }: SoundBuilderProps) {
  const client = useMemo(() => givenClient ?? soundsClient(), [givenClient]);
  const player = useMemo(() => givenPlayer ?? createMixer((f) => client.takeUrl(f)), [givenPlayer, client]);

  const [loaded, setLoaded] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [takes, setTakes] = useState<SoundTake[]>([]);
  const [cells, setCells] = useState<Record<string, string[]>>({});
  const [gains, setGains] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<Tab>('roles');
  const [query, setQuery] = useState('');
  const [unplacedOnly, setUnplacedOnly] = useState(false);
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(new Set());
  const [holding, setHolding] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, SoundMark>>({});
  /** The last take retired from here, while its Undo is offered. */
  const [retired, setRetired] = useState<{ take: SoundTake; reason: RetireReason } | null>(null);
  const lastPickRef = useRef<Map<string, string>>(new Map());

  const reload = useCallback(async (): Promise<void> => {
    const [t, a] = await Promise.all([client.catalogue(), client.assignments()]);
    setTakes(t);
    setCells(a.cells);
    setGains(a.gains);
    setCanEdit(a.canEdit);
    setLoaded(true);
  }, [client]);

  useEffect(() => {
    let alive = true;
    void client.marks().then((m) => {
      if (alive) setMarks(m);
    });
    return () => {
      alive = false;
    };
  }, [client]);

  /*
   * Middle-click marks a take keep, right-click marks it delete, the same click
   * again clears it (2026-10-10). A label only — nothing leaves the catalogue;
   * the delete marks are harvested by hand later. Saved as it is set; a refused
   * save puts the mark back as it was.
   */
  function toggleMark(file: string, mark: SoundMark): void {
    const was = marks[file];
    const next = was === mark ? null : mark;
    setMarks((m) => {
      const copy = { ...m };
      if (next === null) delete copy[file];
      else copy[file] = next;
      return copy;
    });
    void client.mark(file, next).then((ok) => {
      if (ok) return;
      setMarks((m) => {
        const copy = { ...m };
        if (was === undefined) delete copy[file];
        else copy[file] = was;
        return copy;
      });
    });
  }
  const markHandlers = (file: string) => ({
    'data-mark': marks[file],
    // Not the browser's middle-click autoscroll, nor its context menu.
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      toggleMark(file, 'keep');
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      toggleMark(file, 'trash');
    },
  });

  useEffect(() => {
    let alive = true;
    void Promise.all([client.catalogue(), client.assignments()]).then(([t, a]) => {
      if (!alive) return;
      setTakes(t);
      setCells(a.cells);
      setGains(a.gains);
      setCanEdit(a.canEdit);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [client]);

  /*
   * Esc puts a held take down, wherever the focus is — the artifact's own rule.
   * Delete retires it as bad and Shift+Delete as broken (the operator,
   * 2026-10-10: "give me a hotkey to delete a sound … ideally you log when this
   * happens"): out of the bin and every cell, logged server-side with its prompt
   * for the next batch, and undoable. Not while typing in the search box.
   */
  useEffect(() => {
    if (holding === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHolding(null);
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      void retire(holding, e.shiftKey ? 'broken' : 'bad');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  async function retire(file: string, reason: RetireReason): Promise<void> {
    const take = takes.find((t) => t.file === file);
    if (take === undefined) return;
    setHolding(null);
    setTakes((ts) => ts.filter((t) => t.file !== file));
    setCells((cs) => Object.fromEntries(Object.entries(cs).map(([c, fs]) => [c, fs.filter((f) => f !== file)])));
    const left = await client.retire(file, reason);
    if (left === null) {
      // Refused or unreachable: show what the server actually holds.
      await reload();
      return;
    }
    setRetired({ take, reason });
  }

  async function undoRetire(): Promise<void> {
    if (retired === null) return;
    const file = retired.take.file;
    setRetired(null);
    if (await client.restore(file)) await reload();
  }

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

  const gainOf = (cell: string): number => gains[cell] ?? 1;

  async function persist(cell: string, files: string[], gain?: number): Promise<void> {
    setCells((c) => ({ ...c, [cell]: files }));
    if (gain !== undefined) setGains((g) => ({ ...g, [cell]: gain }));
    const saved = await client.save(cell as CellId, files, gain);
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
    player.playFile(file, gainOf(cell));
  }

  function commitGain(cell: string, gain: number): void {
    void persist(cell, cells[cell] ?? [], gain);
  }

  if (!loaded || !canEdit) return null;

  const colourCells = SOUND_MATRIX.colour.reduce((n, row) => n + SOUND_MATRIX.paradigms.filter((p) => rowHasParadigm(row.id, p.id)).length, 0);
  const total = colourCells + SOUND_ROLES.size;
  const filled = Object.values(cells).filter((f) => f.length > 0).length;

  const bySound = new Map<string, SoundTake[]>();
  const order: string[] = [];
  const q = query.trim().toLowerCase();
  for (const t of takes) {
    if (unplacedOnly && placed.has(t.file)) continue;
    if (q !== '' && !`${t.name} ${t.group} ${t.label} ${t.prompt}`.toLowerCase().includes(q)) continue;
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
        {retired !== null && (
          <p className="sound-builder__retired" role="status" data-testid="sound-retired" data-reason={retired.reason}>
            Deleted {retired.take.label} ({retired.reason})
            <button type="button" data-testid="sound-retired-undo" onClick={() => void undoRetire()}>
              Undo
            </button>
          </p>
        )}
        <nav className="sound-builder__tabs" aria-label="Builder view">
          {(['roles', 'colours', 'queue'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className="sound-builder__btn"
              aria-pressed={tab === t}
              onClick={() => {
                // The queue has its own Delete; a take still in hand from the bin would answer it too.
                setHolding(null);
                setTab(t);
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
          <a className="sound-builder__btn sound-builder__btn--primary" href="#/sounds/sandbox">
            Sandbox
          </a>
        </nav>
      </header>

      <div className="sound-builder__panes">
        <aside className="sound-builder__bin" aria-label="Your keepers">
          <div className="sound-builder__filter">
            <input
              type="search"
              placeholder="Search"
              aria-label="Search takes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label>
              <input type="checkbox" checked={unplacedOnly} onChange={(e) => setUnplacedOnly(e.target.checked)} />
              Unplaced
            </label>
          </div>
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
                        {...markHandlers(t.file)}
                        aria-pressed={holding === t.file}
                        aria-label={`${t.label}: play and pick up`}
                        title={t.prompt}
                        draggable
                        onDragStart={(e) =>
                          e.dataTransfer.setData('text/plain', JSON.stringify({ file: t.file, from: null }))
                        }
                        onClick={() => {
                          player.playFile(t.file);
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
          {tab === 'queue' && (
            <SoundQueue
              takes={takes}
              cells={cells}
              placed={placed}
              play={(f) => player.playFile(f)}
              marks={marks}
              markHandlers={markHandlers}
              place={(cell, files) => void persist(cell, files)}
              retire={(f, reason) => void retire(f, reason)}
            />
          )}

          {tab === 'colours' && (
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
                          gains={gains}
                          onGain={commitGain}
                          onPlayPill={(f, cell) => player.playFile(f, gainOf(cell))}
                        />
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </section>
          )}

          {tab === 'roles' && (
            <div className="sound-builder__groups">
              {SOUND_ROLE_GROUPS.map((group) => (
                <section key={group.id} className="sound-builder__section">
                  <h2>{group.name}</h2>
                  <div className="sound-builder__table-wrap">
                    <table className="sound-builder__matrix">
                      <tbody>
                        {group.roles.map((role) => {
                          const cellId = `${role.id}|play`;
                          const files = cells[cellId] ?? [];
                          return (
                            <tr key={role.id}>
                              <th scope="row">
                                <div className="sound-builder__rowname">
                                  <button
                                    type="button"
                                    className="sound-builder__rolefind"
                                    aria-label={`Show takes for ${role.name}`}
                                    onClick={() => setQuery(role.name)}
                                  >
                                    {role.name}
                                  </button>
                                  <span className="sound-builder__rowsub">{role.sub}</span>
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
                                  onPlayPill={(f) => player.playFile(f, gainOf(cellId))}
                                />
                                {files.length > 0 && (
                                  <CellControls
                                    cellId={cellId}
                                    files={files}
                                    label={role.name}
                                    gain={gainOf(cellId)}
                                    onPlayRandom={playRandom}
                                    onGain={commitGain}
                                  />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          )}
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
  gains: Record<string, number>;
  onGain: (cell: string, gain: number) => void;
  onPlayPill: (file: string, cell: string) => void;
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
  gains,
  onGain,
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
          // `basic` is a mono row's only: every other row has no basic land to sound.
          if (!rowHasParadigm(row.id, p.id)) return <td key={p.id} className="sound-builder__none" />;
          const cellId = `${row.id}|${p.id}`;
          const files = cells[cellId] ?? [];
          const hint =
            p.id === 'basic'
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
                onPlayPill={(f) => onPlayPill(f, cellId)}
              />
              {files.length > 0 && (
                <CellControls
                  cellId={cellId}
                  files={files}
                  label={`${row.name} ${p.name}`}
                  gain={gains[cellId] ?? 1}
                  onPlayRandom={onPlayRandom}
                  onGain={onGain}
                />
              )}
            </td>
          );
        })}
      </tr>
    </>
  );
}

/**
 * A filled cell's ▶ and its level, on one line under its takes (the operator,
 * 2026-10-10: "the play button still gets its own row, can we put that on the
 * same line as the audio slider?").
 */
function CellControls({
  cellId,
  files,
  label,
  gain,
  onPlayRandom,
  onGain,
}: {
  cellId: string;
  files: string[];
  label: string;
  gain: number;
  onPlayRandom: (cell: string, files: string[]) => void;
  onGain: (cell: string, gain: number) => void;
}) {
  return (
    <div className="sound-builder__ctl">
      <button
        type="button"
        className="sound-builder__rand"
        aria-label={`Play one of ${files.length} at random`}
        title={files.length > 1 ? `${files.length} variations, one at random` : '1 take'}
        onClick={() => onPlayRandom(cellId, files)}
      >
        ▶
      </button>
      <GainSlider label={label} value={gain} onCommit={(v) => onGain(cellId, v)} />
    </div>
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
                  // The take in hand falls through to the cell, which places it; any other placed take just plays
                  // (the operator, 2026-10-16: "clicking on a different sound's pill should let me preview it").
                  if (holding === f) return;
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
