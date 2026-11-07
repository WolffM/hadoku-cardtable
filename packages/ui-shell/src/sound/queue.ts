/*
 * The sound picker's queue mode: which cells still need a sound, in what
 * order, and which takes to offer for each. Pure mechanics only — the
 * cells that exist, what a folder guesses it was made for, and what counts
 * as a fallback take are the game's own data, injected rather than
 * imported.
 *
 * Empty cells only, shuffled by a seed drawn once so the order holds still
 * for a session and a skip goes to the back. `rankFor` (injected) says how
 * good a guess a take's folder is for a cell — lower better, `null` rules
 * it out; within a rank, unplaced before placed, edited before the take it
 * was made from; a fallback pool pads a thin choice to `minChoices`.
 */

export interface QueueItem {
  cell: string;
  /** The cell already has takes: what is offered is new candidates to add beside them. */
  filled?: boolean;
  title: string;
  sub: string;
}

export interface QueueTake {
  file: string;
}

export interface QueueConfig<T extends QueueTake> {
  /** Every cell the queue can serve, in display order. */
  catalog: readonly QueueItem[];
  /** Lower is a better guess; `null` means `folder` is not a candidate for `cell` at all. */
  rankFor: (cell: string, folder: string) => number | null;
  /** Ranked before the take it was made from. Default: never. */
  isEdited?: (take: T) => boolean;
  /** A pool (a stock library, say) that pads a thin choice. Default: never. */
  isFallback?: (take: T) => boolean;
  /** At most this many offered (default 6), at least this many before padding (default 3). */
  maxChoices?: number;
  minChoices?: number;
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

const folderOf = (file: string): string => file.slice(0, file.indexOf('/'));

/** Build one queue against the game's own catalog and ranking. Pure mechanics otherwise: no cell grammar, no role or folder names. */
export function createSoundQueue<T extends QueueTake>(config: QueueConfig<T>) {
  const { catalog, rankFor, isEdited = () => false, isFallback = () => false, maxChoices = 6, minChoices = 3 } = config;

  function emptyCells(cells: Readonly<Record<string, readonly string[]>>): QueueItem[] {
    return catalog.filter((i) => (cells[i.cell] ?? []).length === 0);
  }

  function ranked(cell: string, takes: readonly T[], placed: ReadonlySet<string>): T[] {
    return takes
      .map((t) => ({ t, rank: rankFor(cell, folderOf(t.file)) }))
      .filter((x): x is { t: T; rank: number } => x.rank !== null)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Number(isEdited(b.t)) - Number(isEdited(a.t)) ||
          Number(placed.has(a.t.file)) - Number(placed.has(b.t.file)) ||
          a.t.file.localeCompare(b.t.file),
      )
      .map((x) => x.t);
  }

  function freshFor(cell: string, takes: readonly T[], placed: ReadonlySet<string>): T[] {
    return ranked(cell, takes, placed)
      .filter((t) => !placed.has(t.file))
      .slice(0, maxChoices);
  }

  function candidatesFor(cell: string, takes: readonly T[], placed: ReadonlySet<string>): T[] {
    const out = ranked(cell, takes, placed).slice(0, maxChoices);
    if (out.length < minChoices) {
      const pool = takes.filter((t) => isFallback(t) && !placed.has(t.file) && !out.includes(t));
      // A stable spread over the pool, so each cell gets its own few rather than the first ones every time.
      const seed = [...cell].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
      for (let i = 0; out.length < minChoices && i < pool.length; i++) out.push(pool[(seed + i) % pool.length]!);
    }
    return out;
  }

  function queueCells(cells: Readonly<Record<string, readonly string[]>>, takes: readonly T[]): QueueItem[] {
    const placed = new Set(Object.values(cells).flat());
    return catalog.flatMap((i) => {
      if ((cells[i.cell] ?? []).length === 0) return [i];
      return freshFor(i.cell, takes, placed).length > 0 ? [{ ...i, filled: true }] : [];
    });
  }

  function queueOrder(
    cells: Readonly<Record<string, readonly string[]>>,
    skipped: readonly string[],
    seed?: number,
    takes?: readonly T[],
  ): QueueItem[] {
    const items = takes === undefined ? emptyCells(cells) : queueCells(cells, takes);
    const all = seed === undefined ? items : shuffled(items, seed);
    const later = new Set(skipped);
    const back = skipped.map((c) => all.find((i) => i.cell === c)).filter((i): i is QueueItem => i !== undefined);
    return [...all.filter((i) => !later.has(i.cell)), ...back];
  }

  return { QUEUE_CHOICES: maxChoices, emptyCells, queueCells, queueOrder, freshFor, candidatesFor };
}
