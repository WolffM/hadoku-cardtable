/*
 * The Upcoming card's Polls page (`./polls.ts`): the open forms attached to events, each with
 * Rally's own summary, soonest to close first.
 */
import { describe, expect, it } from 'vitest';

import { openPolls, pollsClient } from './polls.ts';

const form = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Form ${id}`,
  status: 'open',
  closesAt: null,
  url: `https://hadoku.me/rally/f/${id}`,
  createdBy: 'alice',
  schema: { name: 'event-signup', version: 1 },
  attachedBy: 'alice',
  mine: false,
  ...over,
});

const answering = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('pollsClient', () => {
  it('reads the attached forms and keeps only the open ones', async () => {
    const polls = await pollsClient(answering(200, { forms: [form('a'), form('b', { status: 'closed' })] })).list();
    expect(polls.map((p) => p.id)).toEqual(['a']);
    expect(polls[0]).toMatchObject({ title: 'Form a', url: 'https://hadoku.me/rally/f/a' });
  });
  it('skips a form it cannot read rather than losing the rest', async () => {
    const polls = await pollsClient(answering(200, { forms: [{ id: 'x' }, form('a')] })).list();
    expect(polls.map((p) => p.id)).toEqual(['a']);
  });
  it('throws on a refused read, so the card keeps what it had', async () => {
    await expect(pollsClient(answering(401, { error: 'sign in' })).list()).rejects.toThrow();
  });
});

describe('openPolls', () => {
  it('closes soonest first; a form with no closing time goes last', () => {
    const polls = [form('never'), form('late', { closesAt: '2026-11-09T20:00:00Z' }), form('soon', { closesAt: '2026-11-02T20:00:00Z' })] as never;
    expect(openPolls(polls).map((p) => p.id)).toEqual(['soon', 'late', 'never']);
  });
});
