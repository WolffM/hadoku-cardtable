/*
 * The verdict for a draft room's plan — "it shouldn't even get to the
 * drafting stage… if a set/cube is selected for drafting we should
 * immediately evaluate then whether or not its forge playable" (the
 * operator, `docs/planning/draft-pools-plan.md`'s Rulings #6).
 *
 * `CubeLookup`/`ForgeChecker` are faked here: C's `apps/server/src/pools/cubes.ts`
 * and D's `apps/server/src/pools/forge.ts` land in their own lanes this wave
 * (`docs/planning/wave73-2026-10-21.md`'s ordering), so this module — and
 * this test — are written against the structural shapes the wave file names,
 * never against their real modules.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CubeSummary, DraftCard, DraftPlan, PoolSource, PoolVerdict } from '@hadoku/shared';
import { checkPlan, checkSource, type CubeLookup, type ForgeChecker } from './plan.ts';

function card(name: string): DraftCard {
  return {
    cardId: name,
    name,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: 'Creature — Test',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: '1',
    rarity: 'common',
  };
}

function summary(id: string, overrides: Partial<CubeSummary> = {}): CubeSummary {
  return {
    id,
    name: id,
    size: 2,
    origin: 'shortlist',
    cubeCobraId: null,
    importedBy: null,
    importedAt: null,
    refreshedAt: null,
    verdict: null,
    ...overrides,
  };
}

function fakeCubes(cubes: Record<string, DraftCard[]>, summaries: CubeSummary[] = []): CubeLookup & { setVerdict: ReturnType<typeof vi.fn> } {
  const setVerdict = vi.fn();
  return {
    list: () => summaries,
    cards: (id) => cubes[id] ?? null,
    setVerdict,
  };
}

const CUBE_SRC: PoolSource = { kind: 'cube', cubeId: 'vintage' };

describe('checkSource — one source', () => {
  it('refuses an unknown cube id, named', async () => {
    const cubes = fakeCubes({});
    const verdict = await checkSource(CUBE_SRC, { cubes, forge: null });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.unplayable.some((s) => s.includes('vintage'))).toBe(true);
  });

  it('without a jar, refuses a never-checked cube rather than passing by default', async () => {
    const cubes = fakeCubes({ vintage: [card('A'), card('B')] });
    const verdict = await checkSource(CUBE_SRC, { cubes, forge: null });
    expect(verdict.ok).toBe(false);
    expect(cubes.setVerdict).not.toHaveBeenCalled();
  });

  it('without a jar, reuses an already-cached verdict for that cube', async () => {
    const cached: PoolVerdict = { ok: true, cards: 2 };
    const cubes = fakeCubes({ vintage: [card('A'), card('B')] }, [summary('vintage', { verdict: cached })]);
    const verdict = await checkSource(CUBE_SRC, { cubes, forge: null });
    expect(verdict).toEqual(cached);
  });

  it('with a jar, an all-playable cube is ok and caches the verdict', async () => {
    const cubes = fakeCubes({ vintage: [card('A'), card('B')] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    const verdict = await checkSource(CUBE_SRC, { cubes, forge });
    expect(verdict).toEqual({ ok: true, cards: 2 });
    expect(forge.check).toHaveBeenCalledWith(['A', 'B']);
    expect(cubes.setVerdict).toHaveBeenCalledWith('vintage', { ok: true, cards: 2 });
  });

  it('with a jar, an unplayable card refuses the source, named, and caches the refusal', async () => {
    const cubes = fakeCubes({ vintage: [card('A'), card('Not A Real Card')] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue(['Not A Real Card']) };
    const verdict = await checkSource(CUBE_SRC, { cubes, forge });
    expect(verdict).toEqual({ ok: false, unplayable: ['Not A Real Card'], missingText: [] });
    expect(cubes.setVerdict).toHaveBeenCalledWith('vintage', verdict);
  });

  it('a set source is refused this wave, never reaching Forge', async () => {
    const cubes = fakeCubes({});
    const forge: ForgeChecker = { check: vi.fn() };
    const verdict = await checkSource({ kind: 'set', code: 'ISD', style: 'realistic' }, { cubes, forge });
    expect(verdict.ok).toBe(false);
    expect(forge.check).not.toHaveBeenCalled();
  });
});

describe('checkPlan — a whole plan, deduped by source', () => {
  it('three identical rounds call Forge once, not three times', async () => {
    const plan: DraftPlan = { rounds: [CUBE_SRC, CUBE_SRC, CUBE_SRC] };
    const cubes = fakeCubes({ vintage: [card('A'), card('B')] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    const verdict = await checkPlan(plan, { cubes, forge });
    expect(verdict).toEqual({ ok: true, cards: 2 });
    expect(forge.check).toHaveBeenCalledTimes(1);
  });

  it('refuses the whole plan when any round\'s source is refused, naming every unplayable card', async () => {
    const plan: DraftPlan = {
      rounds: [{ kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'legacy' }, { kind: 'cube', cubeId: 'vintage' }],
    };
    const cubes = fakeCubes({
      vintage: [card('A')],
      legacy: [card('Not A Real Card')],
    });
    const forge: ForgeChecker = {
      check: vi.fn(async (names: readonly string[]) => names.filter((n) => n === 'Not A Real Card')),
    };
    const verdict = await checkPlan(plan, { cubes, forge });
    expect(verdict).toEqual({ ok: false, unplayable: ['Not A Real Card'], missingText: [] });
  });
});
