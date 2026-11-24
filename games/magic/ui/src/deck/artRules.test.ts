/*
 * The art rules' client (`GET`/`PUT /api/me/art`): every change reads the stored rules fresh, edits
 * them, and writes the whole document, so a change another tab made is kept; a refusal says why.
 */
import { describe, expect, it } from 'vitest';

import { artClient, changeArt, withPick, type ArtRules } from './artRules.ts';

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server holding `stored`, answering PUTs with `put` (the default stores the body), recording every request. */
function server(stored: ArtRules, put?: (body: ArtRules) => Response) {
  const asked: string[] = [];
  const client = artClient(async (input, init) => {
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${String(input)}${init?.body === undefined ? '' : ` ${String(init.body)}`}`);
    if (method === 'GET') return answer(200, stored);
    const body = JSON.parse(String(init!.body)) as ArtRules;
    if (put !== undefined) return put(body);
    stored = body;
    return answer(200, body);
  }, '/api/');
  return { client, asked };
}

describe('withPick', () => {
  it('sets a pick under the normalised name, and clears it with null', () => {
    const rules: ArtRules = { oldest: true, picks: { 'lightning bolt': 'a' } };
    expect(withPick(rules, ' Counterspell ', 'c')).toEqual({ oldest: true, picks: { 'lightning bolt': 'a', counterspell: 'c' } });
    expect(withPick(rules, 'Lightning Bolt', null)).toEqual({ oldest: true, picks: {} });
  });
});

describe('changeArt', () => {
  it('reads the rules fresh before it writes, so another tab’s change survives', async () => {
    // This page drew `{ oldest: false, picks: {} }`; another tab has since picked Counterspell and turned "oldest" on.
    const { client, asked } = server({ oldest: true, picks: { counterspell: 'c' } });
    const r = await changeArt(client, (rules) => withPick(rules, 'Lightning Bolt', 'b'));
    expect(r).toEqual({ ok: true, rules: { oldest: true, picks: { counterspell: 'c', 'lightning bolt': 'b' } } });
    expect(asked).toEqual(['GET /api/me/art', 'PUT /api/me/art {"oldest":true,"picks":{"counterspell":"c","lightning bolt":"b"}}']);
  });

  it('says why the server refused, and keeps nothing', async () => {
    const { client } = server({ oldest: false, picks: {} }, () => answer(400, { error: '"x" is not a printing of "lightning bolt"' }));
    expect(await changeArt(client, (rules) => withPick(rules, 'Lightning Bolt', 'x'))).toEqual({ ok: false, message: '"x" is not a printing of "lightning bolt"' });
  });

  it('writes nothing when the read fails', async () => {
    const asked: string[] = [];
    const client = artClient(async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return answer(503, { error: 'down' });
    }, '/api/');
    expect(await changeArt(client, (rules) => ({ ...rules, oldest: true }))).toEqual({ ok: false, message: 'Could not load your card art: down.' });
    expect(asked).toEqual(['GET /api/me/art']);
  });
});
