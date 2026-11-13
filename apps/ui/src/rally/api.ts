/*
 * The two reads behind a Rally view page: `GET /api/rally/views/{kind}/{id}/{cards|pack}`
 * (`games/magic/server/src/http/rally.ts`). Each answers Rally's `{ success, data }` wrapper; a refusal's
 * `error` is a sentence for the page to show as it is ("This draft preset has been deleted.").
 */

import {
  RallyCardsViewSchema,
  RallyPackViewSchema,
  rallyEnvelope,
  type RallyCardsView,
  type RallyPackView,
} from '@hadoku/shared';

import { apiUrl, bodyOf, getJson, serverMessage, type Fetch } from '../http.ts';

export type RallyViewData = { view: 'cards'; data: RallyCardsView } | { view: 'pack'; data: RallyPackView };

const CardsBody = rallyEnvelope(RallyCardsViewSchema);
const PackBody = rallyEnvelope(RallyPackViewSchema);

/** The page's data, or a thrown `Error` whose message is what the page says instead. */
export async function fetchRallyView(catalogue: string, id: string, view: string, fetchImpl?: Fetch): Promise<RallyViewData> {
  const res = await getJson(apiUrl(`rally/views/${catalogue}/${encodeURIComponent(id)}/${view}`), fetchImpl);
  const body = await bodyOf(res);
  const parsed = view === 'cards' ? CardsBody.safeParse(body) : PackBody.safeParse(body);
  if (!parsed.success) throw new Error(serverMessage(body, res.status));
  if (!parsed.data.success) throw new Error(parsed.data.error);
  return view === 'cards' ? { view, data: parsed.data.data as RallyCardsView } : { view: 'pack', data: parsed.data.data as RallyPackView };
}
