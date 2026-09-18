// @vitest-environment jsdom
/**
 * `tempShowZones` and `openZones` answer themselves on mount, as Forge's
 * desktop does — exactly once, even under StrictMode's double effects, because
 * a second reply to one `callId` is a protocol error.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement, StrictMode } from 'react';
import { cleanup, render } from '@testing-library/react';

import { askFor, fixtureLookup } from './fixtures.ts';
import { PROMPT_COMPONENTS } from './index.ts';
import { expectWireReply, mountPrompt } from './testing.ts';
import type { ReplyOf } from './types.ts';

afterEach(cleanup);

describe('tempShowZones', () => {
  it('answers at once with the zones it opened — not the battlefield, not your own hand', () => {
    const { answers, getByTestId } = mountPrompt('tempShowZones', askFor('tempShowZones'));
    expect(answers).toEqual([
      [
        { player: { kind: 'player', id: 1 }, zones: ['Graveyard', 'Hand'] },
        { player: { kind: 'player', id: 0 }, zones: ['Exile'] },
      ],
    ]);
    expectWireReply('tempShowZones', answers[0]);
    expect(getByTestId('prompt-zones').textContent).toBe('Alice (Host AI): Graveyard, HandBob (Capturing): Exile');
  });

  it('answers exactly once under StrictMode', () => {
    const answers: ReplyOf<'tempShowZones'>[] = [];
    render(
      createElement(
        StrictMode,
        null,
        createElement(PROMPT_COMPONENTS.tempShowZones, {
          ask: askFor('tempShowZones'),
          lookup: fixtureLookup(),
          onAnswer: (r) => answers.push(r),
        }),
      ),
    );
    expect(answers).toHaveLength(1);
  });

  it('cannot answer with a zone it was not asked for: a battlefield-only ask opens nothing', () => {
    const ask = {
      ...askFor('tempShowZones'),
      zonesToUpdate: [{ player: { kind: 'player', id: 1 }, zones: ['Battlefield'] }] as ReplyOf<'tempShowZones'>,
    };
    const { answers, getByTestId } = mountPrompt('tempShowZones', ask);
    expect(answers).toEqual([[]]);
    expect(getByTestId('prompt-zones-none')).toBeTruthy();
  });
});

describe('openZones', () => {
  it('opens the graveyards of both players, never the battlefield or the stack', () => {
    const { answers } = mountPrompt('openZones', askFor('openZones'));
    expect(answers).toEqual([
      [
        { player: { kind: 'player', id: 0 }, zones: ['Graveyard'] },
        { player: { kind: 'player', id: 1 }, zones: ['Graveyard'] },
      ],
    ]);
    expectWireReply('openZones', answers[0]);
  });

  it('answers exactly once under StrictMode', () => {
    const answers: ReplyOf<'openZones'>[] = [];
    render(
      createElement(
        StrictMode,
        null,
        createElement(PROMPT_COMPONENTS.openZones, {
          ask: askFor('openZones'),
          lookup: fixtureLookup(),
          onAnswer: (r) => answers.push(r),
        }),
      ),
    );
    expect(answers).toHaveLength(1);
  });
});
