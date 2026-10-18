/*
 * A pod's deck store, from the browser's side.
 *
 * `GET /api/drafts/:podId/mine` and `PUT /api/drafts/:podId/deck` — C's
 * contract (`packages/shared/src/draft.ts`'s "deck HTTP contract" section).
 * `mine` answers the DRAFTER's own pool and last saved build, resolved by the
 * same participant id the gate's draft arm uses, whether or not the drafter
 * still holds a seat in the pod; `save` stores any build of that same pool,
 * finished or not, and refuses only a card from outside it or a malformed
 * `.dck`. Whether the build is a playable deck is the table's question, asked
 * at ready and at start.
 *
 * Every shape here — the outgoing `PUT` body, the `mine` answer, the save's
 * success and its refusal — is C's own Zod schema (`DraftMineSchema`,
 * `SaveDraftDeckBodySchema`, `SaveDraftDeckResponseSchema`,
 * `SaveDraftDeckRefusalSchema`, now re-exported from `@hadoku/shared`), never a
 * hand-rolled copy of one: a second structural check of the same contract is
 * exactly the kind of parallel validator that can quietly disagree with the
 * schema that actually governs the wire.
 */

import {
  DraftMineSchema,
  SaveDraftDeckBodySchema,
  SaveDraftDeckRefusalSchema,
  SaveDraftDeckResponseSchema,
  type DraftMine,
} from '@hadoku/shared';
import { apiBase } from '../screens/tables.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Mine = DraftMine;

export type SaveOutcome = { ok: true; deck: string } | { ok: false; issues: string[] };

export interface DeckStoreClient {
  /** `null` on the server's 404 — the caller drafted no seat in this pod. */
  mine(podId: string): Promise<Mine | null>;
  save(podId: string, dck: string): Promise<SaveOutcome>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function defaultApiBase(): string {
  const base = import.meta.env?.BASE_URL;
  return apiBase(typeof base === 'string' ? base : '/');
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The generic fallback for a body that is none of C's own shapes — a proxy error page, a 500 with no JSON at all. */
function serverMessage(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string' && body.error !== '') return body.error;
  return `the server answered HTTP ${status}`;
}

export function deckStoreClient(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  base: string = defaultApiBase(),
): DeckStoreClient {
  const url = (podId: string, path: string): string => `${base}drafts/${encodeURIComponent(podId)}${path}`;

  return {
    async mine(podId) {
      let res: Response;
      try {
        res = await fetchImpl(url(podId, '/mine'), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      } catch {
        throw new Error('Could not reach the server.');
      }
      if (res.status === 404) return null;
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load your pool: ${serverMessage(body, res.status)}.`);
      const mine = DraftMineSchema.safeParse(body);
      if (!mine.success) throw new Error('The server sent something this app cannot read as your pool.');
      return mine.data;
    },

    async save(podId, dck) {
      // Checked against the server's own request schema before it is ever
      // sent, not only after: a body that cannot be `{ dck }` is refused here,
      // the same refusal shape (`issues`) the server itself would answer with.
      const sent = SaveDraftDeckBodySchema.safeParse({ dck });
      if (!sent.success) return { ok: false, issues: sent.error.issues.map((i) => i.message) };
      let res: Response;
      try {
        res = await fetchImpl(url(podId, '/deck'), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(sent.data),
        });
      } catch {
        return { ok: false, issues: ['Could not reach the server.'] };
      }
      const body = await bodyOf(res);
      if (res.status === 200) {
        const ok = SaveDraftDeckResponseSchema.safeParse(body);
        if (ok.success) return { ok: true, deck: ok.data.deck };
      }
      const refusal = SaveDraftDeckRefusalSchema.safeParse(body);
      return { ok: false, issues: refusal.success && refusal.data.issues.length > 0 ? refusal.data.issues : [serverMessage(body, res.status)] };
    },
  };
}
