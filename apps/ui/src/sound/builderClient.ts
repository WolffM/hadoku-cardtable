/*
 * The sound builder's HTTP client, and the small audio pool it plays takes
 * through.
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
 * catalogue, `{ cells: {}, canEdit: false }` for assignments — rather than a
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
  type SoundTake,
} from '@hadoku/shared';

import { apiBase } from '../screens/tables.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Assignments {
  cells: Record<string, string[]>;
  canEdit: boolean;
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
  save(cell: CellId, files: readonly string[]): Promise<string[] | null>;
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
        return { cells: {}, canEdit: false };
      }
      if (!res.ok) return { cells: {}, canEdit: false };
      const parsed = AssignmentsSchema.safeParse(await bodyOf(res));
      return parsed.success ? parsed.data : { cells: {}, canEdit: false };
    },

    async save(cell, files) {
      let res: Response;
      try {
        res = await fetchImpl(url(`/assignments/${encodeURIComponent(cell)}`), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ files }),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const body = await bodyOf(res);
      if (!isRecord(body) || !Array.isArray(body.files)) return null;
      return body.files.filter((f): f is string => typeof f === 'string');
    },

    takeUrl(file) {
      // `file` is `<folder>/take-<suffix>.ogg` (TAKE_FILE_RE); the route takes
      // the folder and the file as two separate segments, each encoded on its
      // own so a literal `/` cannot be smuggled through either one.
      const i = file.indexOf('/');
      const folder = i < 0 ? file : file.slice(0, i);
      const name = i < 0 ? '' : file.slice(i + 1);
      return url(`/takes/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`);
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

/**
 * An 8-voice pool, so a sample turn's overlapping cues do not cut each other
 * off — the same shape `../sound/webaudio.ts` uses for in-game cues, kept
 * separate because this one plays SERVER-HOSTED files by URL rather than
 * synthesising an envelope, and the builder is the only caller.
 *
 * Each take is fetched once and cached as an object URL; a take that fails to
 * fetch or decode is remembered as failed and never retried, so one bad file
 * costs one silent take rather than a retry storm.
 */
export interface AudioPool {
  play(file: string): Promise<void>;
}

export interface AudioPoolOptions {
  voices?: number;
  fetchImpl?: Fetch;
  /** Overridable so a test can inject a stub without a real `HTMLAudioElement`. */
  createAudio?: () => HTMLAudioElement;
}

function defaultCreateAudio(): HTMLAudioElement | null {
  return typeof Audio === 'undefined' ? null : new Audio();
}

export function createAudioPool(client: Pick<SoundsClient, 'takeUrl'>, opts: AudioPoolOptions = {}): AudioPool {
  const voices = opts.voices ?? 8;
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const make = opts.createAudio ?? defaultCreateAudio;

  const pool: HTMLAudioElement[] = [];
  for (let i = 0; i < voices; i++) {
    const a = make();
    if (a !== null) pool.push(a);
  }
  let next = 0;

  /** file -> object URL, or `null` once fetching/decoding it has failed. */
  const urls = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();

  function load(file: string): Promise<string | null> {
    const cached = urls.get(file);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = pending.get(file);
    if (inFlight !== undefined) return inFlight;
    const task = (async (): Promise<string | null> => {
      try {
        const res = await fetchImpl(client.takeUrl(file));
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const objectUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
        urls.set(file, objectUrl);
        return objectUrl;
      } catch {
        urls.set(file, null);
        return null;
      } finally {
        pending.delete(file);
      }
    })();
    pending.set(file, task);
    return task;
  }

  return {
    async play(file) {
      if (pool.length === 0) return;
      const src = await load(file);
      if (src === null) return;
      const a = pool[next++ % pool.length];
      try {
        a.pause();
        a.currentTime = 0;
        a.src = src;
        await a.play();
      } catch {
        // A browser that refuses to play (no gesture yet, a codec it does not
        // have) loses this one take, not the page.
      }
    },
  };
}
