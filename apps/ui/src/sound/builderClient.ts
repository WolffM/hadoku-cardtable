/*
 * The sound builder's HTTP client.
 *
 * Every wire shape — `SoundTake`, the catalogue, the assignment map, `CellId`
 * — comes from `@hadoku/shared` (`packages/shared/src/sounds.ts`), which the
 * server's `/api/sounds` router (`apps/server/src/http/sounds.ts`) builds its
 * own answers from. Nothing here writes a parallel definition of any of that;
 * this file is parse-and-call, the same shape `rooms/api.ts` uses for the
 * room list.
 *
 * ## Fails soft, by design
 *
 * A read that cannot reach the server, or that the server answers with
 * something that does not parse, comes back as the EMPTY case — `[]` for the
 * catalogue, `{ cells: {}, gains: {}, canEdit: false }` for assignments — rather than a
 * thrown error. `SoundBuilder.tsx` renders nothing useful for a non-admin
 * already, and "the server is unreachable" is not a fact worth a different
 * screen from "you are not an admin": both mean there is nothing to edit here
 * right now.
 *
 * `save` is the one call that DOES say when it failed (`null`), because the
 * screen needs to mark that one cell unsaved rather than silently keep an
 * optimistic value that never reached the server.
 */

import {
  AssignmentsSchema,
  CatalogueSchema,
  type CellId,
  MarksSchema,
  type RetireReason,
  type SoundMark,
  type SoundTake,
} from '@hadoku/shared';

import { apiBase } from '../screens/tables.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Assignments {
  cells: Record<string, string[]>;
  /** A cell's level relative to the others; a missing entry is 1. */
  gains: Record<string, number>;
  canEdit: boolean;
}

/** What a save stored: the cell's file list and its gain. */
export interface SavedCell {
  files: string[];
  gain: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function defaultAppBase(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' ? base : '/';
}

function defaultApiBase(): string {
  return apiBase(defaultAppBase());
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export interface SoundsClient {
  catalogue(): Promise<SoundTake[]>;
  assignments(): Promise<Assignments>;
  /**
   * `PUT /api/sounds/assignments/:cell`. Returns the saved list the server
   * echoed back, or `null` when the request did not reach the server, was
   * refused (403, a malformed body, an unknown file), or answered with
   * something that does not parse.
   */
  save(cell: CellId, files: readonly string[], gain?: number): Promise<SavedCell | null>;
  /**
   * `POST /api/sounds/retire`: the take leaves the catalogue and every cell, and
   * the reason is logged for the next batch. The cells it left, or `null` when
   * the server refused or could not be reached.
   */
  retire(file: string, reason: RetireReason): Promise<string[] | null>;
  /** `POST /api/sounds/restore`: undo the last retirement. Whether it worked. */
  restore(file: string): Promise<boolean>;
  /** `GET /api/sounds/marks`: every take's keep / delete mark; nothing on a failure. */
  marks(): Promise<Record<string, SoundMark>>;
  /** `PUT /api/sounds/marks`: set or (`null`) clear one take's mark. Whether it was stored. */
  mark(file: string, mark: SoundMark | null): Promise<boolean>;
  /** The same-origin URL a take's audio streams from. */
  takeUrl(file: string): string;
}

export function soundsClient(
  fetchImpl: Fetch = (i, init) => fetch(i, init),
  base: string = defaultApiBase(),
): SoundsClient {
  const url = (path: string): string => `${base}sounds${path}`;

  return {
    async catalogue() {
      let res: Response;
      try {
        res = await fetchImpl(url('/catalogue'), { credentials: 'same-origin' });
      } catch {
        return [];
      }
      if (!res.ok) return [];
      const parsed = CatalogueSchema.safeParse(await bodyOf(res));
      return parsed.success ? parsed.data.takes : [];
    },

    async assignments() {
      let res: Response;
      try {
        res = await fetchImpl(url('/assignments'), { credentials: 'same-origin' });
      } catch {
        return { cells: {}, gains: {}, canEdit: false };
      }
      if (!res.ok) return { cells: {}, gains: {}, canEdit: false };
      const parsed = AssignmentsSchema.safeParse(await bodyOf(res));
      return parsed.success ? parsed.data : { cells: {}, gains: {}, canEdit: false };
    },

    async save(cell, files, gain) {
      let res: Response;
      try {
        res = await fetchImpl(url(`/assignments/${encodeURIComponent(cell)}`), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify(gain === undefined ? { files } : { files, gain }),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const body = await bodyOf(res);
      if (!isRecord(body) || !Array.isArray(body.files)) return null;
      return {
        files: body.files.filter((f): f is string => typeof f === 'string'),
        gain: typeof body.gain === 'number' ? body.gain : 1,
      };
    },

    async retire(file, reason) {
      let res: Response;
      try {
        res = await fetchImpl(url('/retire'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ file, reason }),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const body = await bodyOf(res);
      return isRecord(body) && Array.isArray(body.cells) ? body.cells.filter((c): c is string => typeof c === 'string') : null;
    },

    async restore(file) {
      try {
        const res = await fetchImpl(url('/restore'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ file }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async marks() {
      try {
        const res = await fetchImpl(url('/marks'), { credentials: 'same-origin' });
        if (!res.ok) return {};
        const parsed = MarksSchema.safeParse(await bodyOf(res));
        return parsed.success ? parsed.data.marks : {};
      } catch {
        return {};
      }
    },

    async mark(file, mark) {
      try {
        const res = await fetchImpl(url('/marks'), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ file, mark }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    takeUrl(file) {
      // `file` is `<folder>/take-<suffix>.ogg` (TAKE_FILE_RE); the route takes
      // the folder and the file as two separate segments, each encoded on its
      // own so a literal `/` cannot be smuggled through either one.
      const i = file.indexOf('/');
      const folder = i < 0 ? file : file.slice(0, i);
      const name = i < 0 ? '' : file.slice(i + 1);
      return url(`/audio/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`);
    },
  };
}

/**
 * Pick one file at random, never the same one twice in a row — unless there
 * is only one to pick, in which case "never repeats" has nothing to say and
 * the one take plays again. Pure, so the no-repeat rule is a unit test and not
 * a thing proven by clicking a button a few times and hoping.
 */
export function pickRandom(
  files: readonly string[],
  last: string | null,
  rng: () => number = Math.random,
): string | null {
  if (files.length === 0) return null;
  const options = files.length > 1 && last !== null ? files.filter((f) => f !== last) : files;
  const i = Math.floor(rng() * options.length);
  return options[Math.min(i, options.length - 1)] ?? null;
}
