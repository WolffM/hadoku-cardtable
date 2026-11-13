/*
 * The sound picker's queue mode (the operator, 2026-10-10: *"might be nice to
 * have a 'queue' mode where it gives me a thing that needs a sound and then a
 * couple to choose from. i can either pick one, multiple, or none and move
 * on"*). `../screens/SoundQueue.tsx` draws it.
 *
 * The queue's mechanics (order, shuffling, candidate ranking and padding)
 * moved to `@hadoku/ui-shell/sound`'s `createSoundQueue` (w92-C), which knows
 * no cell grammar or role names. This file is the Magic half it is given:
 * every cell the queue can serve (the roles but music, then the colour
 * matrix), and how good a guess a take's folder is for one.
 *
 * ## Order
 *
 * `everyCell` keeps the registry's order — roles in group order, then the
 * colour matrix mono first — which becomes `CATALOG` below. Music is left
 * out: its takes are found tracks, not candidates.
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

import { BASIC_LAND_OF } from '@hadoku/deck';
import { rowHasParadigm, SOUND_MATRIX, SOUND_ROLE_GROUPS, type SoundTake } from '@hadoku/shared';
import { createSoundQueue, type QueueItem } from '@hadoku/ui-shell/sound';

const FAMILY_ORDER = ['mono', 'guild', 'shard', 'wedge', 'four', 'extra'];

function colourTitle(rowName: string, paradigm: string, row: string): string {
  if (paradigm === 'basic') return (BASIC_LAND_OF as Record<string, string | undefined>)[row] ?? `${rowName} basic land`;
  const p = SOUND_MATRIX.paradigms.find((x) => x.id === paradigm)?.name ?? paradigm;
  return `${rowName} ${p.toLowerCase()}`;
}

/** Every cell the queue can serve — the roles but music, then the colour matrix — in the registry's order. */
function everyCell(): QueueItem[] {
  const out: QueueItem[] = [];
  for (const group of SOUND_ROLE_GROUPS) {
    for (const role of group.roles) {
      if (role.bus !== 'music') out.push({ cell: `${role.id}|play`, title: role.name, sub: role.sub });
    }
  }
  for (const family of FAMILY_ORDER) {
    for (const row of SOUND_MATRIX.colour.filter((r) => r.family === family)) {
      for (const p of SOUND_MATRIX.paradigms) {
        if (rowHasParadigm(row.id, p.id)) out.push({ cell: `${row.id}|${p.id}`, title: colourTitle(row.name, p.id, row.id), sub: row.sub });
      }
    }
  }
  return out;
}

/** Static: the role groups and the colour matrix don't change at runtime. */
const CATALOG: readonly QueueItem[] = everyCell();

/** A take cut or turned from another (`-first`, `-half`, `take-rev-`): the operator asked for it, so it comes first. */
const isEdited = (t: SoundTake): boolean => /-(?:first|half)\.ogg$|\/take-rev-/.test(t.file);
/** `wu.spell`, `g.creature`, `bgu.r2`: a colour code and what it was generated as; `u-basic`, a cell harvested (`scripts/sfx/harvest.py`). */
const COLOUR_FOLDER = /^([wubrgc]+)[.-](spell|creature|land|basic|artifact|artifact-creature|r2)$/;

/** Lower rank is a better guess; `null` is not a candidate for this cell at all. */
function rankFor(cell: string, folder: string): number | null {
  const [row, col] = cell.split('|') as [string, string];
  if (col === 'play') {
    if (folder === row) return 0;
    // The older moment folders: `m-draw` was made for what is now `g.draw`.
    if (row.startsWith('g.') && folder === `m-${row.slice(2)}`) return 0;
    return null;
  }
  const code = row.toLowerCase();
  if (col === 'basic') {
    const land = (BASIC_LAND_OF as Record<string, string | undefined>)[row]?.toLowerCase();
    if (folder === `land-${land}`) return 0;
  }
  // A colour folder by its shape, `<code>.<column>`: green's `g.creature` is one, the role folder `g.tap` is not.
  const m = COLOUR_FOLDER.exec(folder);
  if (m === null || m[1] !== code) return null;
  const kind = m[2]!;
  if (col === 'basic') return kind === 'basic' ? 0 : kind === 'land' ? 1 : null;
  if (kind === col) return 0;
  if (col === 'artifact-creature' && (kind === 'creature' || kind === 'artifact')) return 1;
  return 2;
}

const queue = createSoundQueue<SoundTake>({
  catalog: CATALOG,
  rankFor,
  isEdited,
  isFallback: (t) => t.section === 'Library',
});

export const { QUEUE_CHOICES, emptyCells, queueCells, queueOrder, freshFor, candidatesFor } = queue;
