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
import { apiBase, bodyOf, getJson, sendJson, serverMessage, type Fetch } from '@hadoku/game-ui/http.ts';

export type Mine = DraftMine;

export type SaveOutcome = { ok: true; deck: string } | { ok: false; issues: string[] };

export interface DeckStoreClient {
  /** `null` on the server's 404 — the caller drafted no seat in this pod. */
  mine(podId: string): Promise<Mine | null>;
  save(podId: string, dck: string): Promise<SaveOutcome>;
}

/**
 * Each pod's save still on its way, across every client in this page: the draft screen saves its
 * last move as it hands over to the builder, which reads the pod with a client of its own, and a
 * read that overtook that save would open on the build before it.
 */
const saving = new Map<string, Promise<unknown>>();

export function deckStoreClient(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  base: string = apiBase(),
): DeckStoreClient {
  const url = (podId: string, path: string): string => `${base}drafts/${encodeURIComponent(podId)}${path}`;

  return {
    async mine(podId) {
      await saving.get(podId);
      let res: Response;
      try {
        res = await getJson(url(podId, '/mine'), fetchImpl);
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

    save(podId, dck) {
      const sent = put(podId, dck);
      const settled = sent.then(
        () => undefined,
        () => undefined,
      );
      saving.set(podId, settled);
      void settled.then(() => {
        if (saving.get(podId) === settled) saving.delete(podId);
      });
      return sent;
    },
  };

  async function put(podId: string, dck: string): Promise<SaveOutcome> {
    // Checked against the server's own request schema before it is ever
    // sent, not only after: a body that cannot be `{ dck }` is refused here,
    // the same refusal shape (`issues`) the server itself would answer with.
    const sent = SaveDraftDeckBodySchema.safeParse({ dck });
    if (!sent.success) return { ok: false, issues: sent.error.issues.map((i) => i.message) };
    let res: Response;
    try {
      res = await sendJson(url(podId, '/deck'), 'PUT', sent.data, fetchImpl);
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
  }
}
