// @vitest-environment jsdom
/**
 * The fixtures and the index, held to the brief: every one of the fourteen
 * methods has a committed fixture that parses as a real `ServerFrame`, every
 * one has a component, and none of them is the fifteenth (lane B's).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { BLOCKING_METHODS, safeParseServerFrame } from '@hadoku/forge-wire';

import { fixtureLookup, PROMPT_FIXTURES } from './fixtures.ts';
import { isPromptMethod, DIRECT_CONFIRM_METHOD, PROMPT_COMPONENTS, PROMPT_METHODS, PromptFor } from './index.ts';
import { refName } from './lookup.ts';
import type { AskOf, PromptMethod } from './types.ts';

afterEach(cleanup);

describe('the method census', () => {
  it('covers the 15 blocking methods as 14 here plus the one LiveBoard.tsx answers directly', () => {
    expect(PROMPT_METHODS).toHaveLength(14);
    expect([...PROMPT_METHODS, DIRECT_CONFIRM_METHOD].sort()).toEqual([...BLOCKING_METHODS].sort());
    expect(Object.keys(PROMPT_COMPONENTS).sort()).toEqual([...PROMPT_METHODS].sort());
    expect(isPromptMethod('showConfirmDialog')).toBe(false);
    expect(isPromptMethod('setSelectables')).toBe(false);
  });

  it('has at least one fixture for every method, and none for any other', () => {
    const covered = new Set(PROMPT_FIXTURES.map((f) => f.method));
    expect([...covered].sort()).toEqual([...PROMPT_METHODS].sort());
  });
});

describe('every fixture', () => {
  it.each(PROMPT_FIXTURES.map((f) => [f.file, f] as const))('%s parses as the ServerFrame it claims', (_file, f) => {
    const parsed = safeParseServerFrame(f.raw);
    expect(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.errors)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.method).toBe(f.method);
    expect(parsed.value.kind).toBe('ask');
    expect(f.source.length).toBeGreaterThan(0);
  });

  it('names only cards and players that exist in the real match', () => {
    const lookup = fixtureLookup();
    const refs: { kind: string; id: number }[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v !== null) {
        const o = v as Record<string, unknown>;
        if ((o.kind === 'card' || o.kind === 'player') && typeof o.id === 'number') refs.push(o as never);
        else Object.values(o).forEach(walk);
      }
    };
    PROMPT_FIXTURES.forEach((f) => walk(f.raw));
    expect(refs.length).toBeGreaterThan(30);
    const unresolved = refs.filter((r) => /#/.test(refName(lookup, r)));
    expect(unresolved).toEqual([]);
  });

  it.each(PROMPT_FIXTURES.map((f) => [f.file, f] as const))('%s renders through PromptFor', (_file, f) => {
    const parsed = safeParseServerFrame(f.raw);
    if (!parsed.ok) throw new Error(`${f.file} does not parse`);
    const { container } = render(
      createElement(PromptFor, {
        ask: parsed.value as AskOf<PromptMethod>,
        lookup: fixtureLookup(),
        onAnswer: () => undefined,
      }),
    );
    const root = container.querySelector<HTMLElement>('[data-prompt]');
    expect(root?.dataset.prompt).toBe(f.method);
    // D13/D15 and the trademark rule: a prompt draws no image.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/url\(/);
  });
});
