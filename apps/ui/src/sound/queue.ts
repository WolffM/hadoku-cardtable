/*
 * The sound picker's queue mode (the operator, 2026-10-10: *"might be nice to
 * have a 'queue' mode where it gives me a thing that needs a sound and then a
 * couple to choose from. i can either pick one, multiple, or none and move
 * on"*). Pure: which cells still need a sound, in what order, and which takes
 * to offer for each. `../screens/SoundQueue.tsx` draws it.
 *
 * ## Order
 *
 * Empty cells only, shuffled (the operator, 2026-10-10: *"next time can you make
 * it so queue chooses something random rather than go in order?"*) by a seed
 * the screen draws once, so the order holds still for the session and a skip
 * still goes to the back. `emptyCells` keeps the registry's order — roles in
 * group order, then the colour matrix mono first — for anything that wants it.
 * Music is left out: its takes are found tracks, not candidates.
 *
 * ## Candidates
 *
 * A take's folder says what it was generated for (`scripts/sfx/import.py`):
 * a role's own id (`g.tap/…`), the older moment folders (`m-draw/…` for
 * `g.draw`), a colour code and a column (`wu.spell/…`, `wu.r2/…`), a basic
 * land (`land-island/…`). Best guesses first; within a rank, takes placed
 * nowhere before takes already used elsewhere; then library takes to make a
 * choice of at least three when little was made for the cell.
 */

import {
  rowHasParadigm,
  SOUND_MATRIX,
  SOUND_ROLE_GROUPS,
  type SoundTake,
} from '@hadoku/shared';

/** How many takes a queue item offers, at most. */
export const QUEUE_CHOICES = 6;
const MIN_CHOICES = 3;

export interface QueueItem {
  cell: string;
  /** "Draw", "Boros spell", "Island". */
  title: string;
  /** The role's line, or the colour row's. */
  sub: string;
}

const FAMILY_ORDER = ['mono', 'guild', 'shard', 'wedge', 'four', 'extra'];

function colourTitle(rowName: string, paradigm: string, row: string): string {
  if (paradigm === 'basic') return (SOUND_MATRIX.landNames as Record<string, string>)[row] ?? `${rowName} basic land`;
  const p = SOUND_MATRIX.paradigms.find((x) => x.id === paradigm)?.name ?? paradigm;
  return `${rowName} ${p.toLowerCase()}`;
}

/** Every cell with nothing in it, in the order the queue serves them. */
export function emptyCells(cells: Readonly<Record<string, readonly string[]>>): QueueItem[] {
  const empty = (cell: string): boolean => (cells[cell] ?? []).length === 0;
  const out: QueueItem[] = [];
  for (const group of SOUND_ROLE_GROUPS) {
    for (const role of group.roles) {
      if (role.bus === 'music') continue;
      const cell = `${role.id}|play`;
      if (empty(cell)) out.push({ cell, title: role.name, sub: role.sub });
    }
  }
  for (const family of FAMILY_ORDER) {
    for (const row of SOUND_MATRIX.colour.filter((r) => r.family === family)) {
      for (const p of SOUND_MATRIX.paradigms) {
        if (!rowHasParadigm(row.id, p.id)) continue;
        const cell = `${row.id}|${p.id}`;
        if (empty(cell)) out.push({ cell, title: colourTitle(row.name, p.id, row.id), sub: row.sub });
      }
    }
  }
  return out;
}

/**
 * The queue as it is served: the empty cells, with the ones skipped this
 * session moved to the back in the order they were skipped.
 */
export function queueOrder(cells: Readonly<Record<string, readonly string[]>>, skipped: readonly string[], seed?: number): QueueItem[] {
  const all = seed === undefined ? emptyCells(cells) : shuffled(emptyCells(cells), seed);
  const later = new Set(skipped);
  const back = skipped.map((c) => all.find((i) => i.cell === c)).filter((i): i is QueueItem => i !== undefined);
  return [...all.filter((i) => !later.has(i.cell)), ...back];
}

/** A seeded shuffle (mulberry32 + Fisher-Yates): the same seed, the same order. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const folderOf = (t: SoundTake): string => t.file.slice(0, t.file.indexOf('/'));
/** A take cut or turned from another (`-first`, `-half`, `take-rev-`): the operator asked for it, so it comes first. */
const isEdited = (t: SoundTake): boolean => /-(?:first|half)\.ogg$|\/take-rev-/.test(t.file);
/** `wu.spell`, `g.creature`, `bgu.r2`: a colour code and what it was generated as. */
const COLOUR_FOLDER = /^([wubrgc]+)\.(spell|creature|land|artifact|artifact-creature|r2)$/;

/** Lower rank is a better guess; `null` is not a candidate for this cell at all. */
function rankFor(cell: string, folder: string): number | null {
  const [row, col] = cell.split('|') as [string, string];
  if (col === 'play') {
    if (folder === row) return 0;
    // The older moment folders: `m-draw` was made for what is now `g.draw`.
    if (row.startsWith('g.') && folder === `m-${row.slice(2)}`) return 0;
    // The retired untap step's takes are untaps (2026-10-10).
    if (row === 'g.untap' && folder === 'g.untap-all') return 1;
    return null;
  }
  const code = row.toLowerCase();
  if (col === 'basic') {
    const land = (SOUND_MATRIX.landNames as Record<string, string>)[row]?.toLowerCase();
    if (folder === `land-${land}`) return 0;
  }
  // A colour folder by its shape, `<code>.<column>`: green's `g.creature` is one, the role folder `g.tap` is not.
  const m = COLOUR_FOLDER.exec(folder);
  if (m === null || m[1] !== code) return null;
  const kind = m[2]!;
  if (col === 'basic') return kind === 'land' ? 1 : null;
  if (kind === col) return 0;
  if (col === 'artifact-creature' && (kind === 'creature' || kind === 'artifact')) return 1;
  return 2;
}

/**
 * Up to `QUEUE_CHOICES` takes to offer for `cell`: its best guesses, placed-
 * nowhere first, then library takes to make a real choice where little was
 * made for it.
 */
export function candidatesFor(cell: string, takes: readonly SoundTake[], placed: ReadonlySet<string>): SoundTake[] {
  const ranked = takes
    .map((t) => ({ t, rank: rankFor(cell, folderOf(t)) }))
    .filter((x): x is { t: SoundTake; rank: number } => x.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(isEdited(b.t)) - Number(isEdited(a.t)) ||
        Number(placed.has(a.t.file)) - Number(placed.has(b.t.file)) ||
        a.t.file.localeCompare(b.t.file),
    )
    .map((x) => x.t);
  const out = ranked.slice(0, QUEUE_CHOICES);
  if (out.length < MIN_CHOICES) {
    const library = takes.filter((t) => t.section === 'Library' && !placed.has(t.file) && !out.includes(t));
    // A stable spread over the library, so each cell gets its own few rather than the first ones every time.
    const seed = [...cell].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
    for (let i = 0; out.length < MIN_CHOICES && i < library.length; i++) out.push(library[(seed + i) % library.length]!);
  }
  return out;
}
