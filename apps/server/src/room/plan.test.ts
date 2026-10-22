/*
 * The verdict for a draft room's plan — "it shouldn't even get to the
 * drafting stage… if a set/cube is selected for drafting we should
 * immediately evaluate then whether or not its forge playable" (the
 * operator, `docs/planning/draft-pools-plan.md`'s Rulings #6).
 *
 * `CubeLookup`/`ForgeChecker` are faked for most of this file: this module was
 * written against the structural shapes the wave file names, before C's
 * `apps/server/src/pools/cubes.ts` and D's `apps/server/src/pools/forge.ts`
 * landed. The last describe block below (step 6) runs the real `createCubeStore`
 * against the committed shortlist — the wiring `index.ts` itself does.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CubeSummary, DraftCard, DraftPlan, PoolSource, PoolVerdict } from '@hadoku/shared';
import { checkCards, checkPlan, checkSource, type CubeLookup, type ForgeChecker, type SetLookup } from './plan.ts';
import { createCubeStore } from '../pools/cubes.ts';
import { loadCardCatalog } from '../pools/catalog.ts';
import { DEFAULT_PLAN } from './draftRooms.ts';

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
    artId: null,
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

/** `cardsFor` already resolved — the shape `pools/sets.ts`'s own store hands `checkSource` once `checkSetSource` calls it. */
function fakeSets(sets: Record<string, readonly DraftCard[] | null>, cached: Record<string, PoolVerdict> = {}): SetLookup & { setVerdict: ReturnType<typeof vi.fn> } {
  const verdicts = new Map(Object.entries(cached));
  const setVerdict = vi.fn((code: string, verdict: PoolVerdict) => verdicts.set(code, verdict));
  return {
    cardsFor: async (code) => sets[code] ?? null,
    cachedVerdict: (code) => verdicts.get(code) ?? null,
    setVerdict,
  };
}

const CUBE_SRC: PoolSource = { kind: 'cube', cubeId: 'vintage' };
const ISD_REALISTIC: PoolSource = { kind: 'set', code: 'ISD', style: 'realistic' };
const ISD_SET_CUBE: PoolSource = { kind: 'set', code: 'ISD', style: 'set-cube' };

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

  it('a card the catalog could not resolve (typeLine: \'\', C\'s own signal) refuses with missingText, named, and never reaches Forge', async () => {
    const cubes = fakeCubes({ vintage: [card('A'), { ...card('Mystery Card'), typeLine: '' }] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    const verdict = await checkSource(CUBE_SRC, { cubes, forge });
    expect(verdict).toEqual({ ok: false, unplayable: [], missingText: ['Mystery Card'] });
    expect(forge.check).toHaveBeenCalledWith(['A']);
    expect(cubes.setVerdict).toHaveBeenCalledWith('vintage', verdict);
  });

  it('missingText refuses even without a jar, and takes precedence over a cached ok verdict', async () => {
    const cached: PoolVerdict = { ok: true, cards: 2 };
    const cubes = fakeCubes({ vintage: [card('A'), { ...card('Mystery Card'), typeLine: '' }] }, [summary('vintage', { verdict: cached })]);
    const verdict = await checkSource(CUBE_SRC, { cubes, forge: null });
    expect(verdict).toEqual({ ok: false, unplayable: [], missingText: ['Mystery Card'] });
  });
});

/*
 * Wave 74 §E step 3: "Set verdict, in room/plan.ts" — `checkSource` for
 * `kind: 'set'` now runs for real, through `pools/sets.ts`'s own `SetLookup`
 * (faked here, exactly as `CubeLookup`/`ForgeChecker` are above — this
 * module was written against the structural shape before `pools/sets.ts`
 * landed in this same lane, so the fake and the real module are checked
 * against each other one commit later, same discipline the cube half used
 * in wave 73).
 */
describe('checkSource — a kind: \'set\' source, by CODE (realistic and set-cube share one verdict)', () => {
  it('without a SetLookup wired, refuses rather than reaching Forge', async () => {
    const cubes = fakeCubes({});
    const forge: ForgeChecker = { check: vi.fn() };
    const verdict = await checkSource(ISD_REALISTIC, { cubes, forge });
    expect(verdict.ok).toBe(false);
    expect(forge.check).not.toHaveBeenCalled();
  });

  it('an unknown code (cardsFor answers null) is refused, named', async () => {
    const cubes = fakeCubes({});
    const sets = fakeSets({ ISD: null });
    const forge: ForgeChecker = { check: vi.fn() };
    const verdict = await checkSource(ISD_REALISTIC, { cubes, sets, forge });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.unplayable.some((s) => s.includes('ISD'))).toBe(true);
    expect(forge.check).not.toHaveBeenCalled();
  });

  it('with a jar, an all-playable set is ok and caches the verdict by code', async () => {
    const cubes = fakeCubes({});
    const sets = fakeSets({ ISD: [card('A'), card('B')] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    const verdict = await checkSource(ISD_REALISTIC, { cubes, sets, forge });
    expect(verdict).toEqual({ ok: true, cards: 2 });
    expect(sets.setVerdict).toHaveBeenCalledWith('ISD', { ok: true, cards: 2 });
  });

  it('realistic and set-cube of the SAME code share the cached verdict — the second style never re-resolves cardsFor', async () => {
    const cubes = fakeCubes({});
    const cardsFor = vi.fn(async (code: string) => (code === 'ISD' ? [card('A')] : null));
    const verdicts = new Map<string, PoolVerdict>();
    const sets: SetLookup = {
      cardsFor,
      cachedVerdict: (code) => verdicts.get(code) ?? null,
      setVerdict: (code, verdict) => verdicts.set(code, verdict),
    };
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    // checkPlan dedupes by (code, style) — ISD_REALISTIC and ISD_SET_CUBE are
    // DIFFERENT sourceKeys, so checkSource runs for both; it is
    // checkSetSource's own cache (by code alone) that collapses them to one
    // cardsFor call, not checkPlan's dedup.
    await checkPlan({ rounds: [ISD_REALISTIC, ISD_SET_CUBE, ISD_REALISTIC] }, { cubes, sets, forge });
    expect(cardsFor).toHaveBeenCalledTimes(1);
  });

  it('an unplayable name refuses the source, named, and caches the refusal', async () => {
    const cubes = fakeCubes({});
    const sets = fakeSets({ ISD: [card('A'), card('Not A Real Card')] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue(['Not A Real Card']) };
    const verdict = await checkSource(ISD_REALISTIC, { cubes, sets, forge });
    expect(verdict).toEqual({ ok: false, unplayable: ['Not A Real Card'], missingText: [] });
    expect(sets.setVerdict).toHaveBeenCalledWith('ISD', verdict);
  });

  it('a name the catalog could not resolve refuses with missingText, named, and never reaches Forge', async () => {
    const cubes = fakeCubes({});
    const sets = fakeSets({ ISD: [card('A'), { ...card('Mystery Card'), typeLine: '' }] });
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    const verdict = await checkSource(ISD_SET_CUBE, { cubes, sets, forge });
    expect(verdict).toEqual({ ok: false, unplayable: [], missingText: ['Mystery Card'] });
    expect(forge.check).toHaveBeenCalledWith(['A']);
  });

  it('a cached verdict for the code is reused as-is, without calling cardsFor again', async () => {
    const cubes = fakeCubes({});
    const cached: PoolVerdict = { ok: true, cards: 5 };
    const cardsFor = vi.fn(async () => [card('A')]);
    const sets: SetLookup = { cardsFor, cachedVerdict: () => cached, setVerdict: vi.fn() };
    const forge: ForgeChecker = { check: vi.fn() };
    const verdict = await checkSource(ISD_REALISTIC, { cubes, sets, forge });
    expect(verdict).toEqual(cached);
    expect(cardsFor).not.toHaveBeenCalled();
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

describe('checkCards — the shared core, also apps/server/src/pools/cubes.ts’s attachCubeRoutes check dep', () => {
  it('an all-resolved cube with a jar reports every unplayable card, even past the first missing-text one', async () => {
    const cards = [card('A'), { ...card('Mystery'), typeLine: '' }, card('Not Real')];
    const forge: ForgeChecker = { check: vi.fn(async (names: readonly string[]) => names.filter((n) => n === 'Not Real')) };
    const verdict = await checkCards(cards, forge);
    expect(verdict).toEqual({ ok: false, unplayable: ['Not Real'], missingText: ['Mystery'] });
    // The resolved cards (A, Not Real) went to Forge; the missing-text one never did.
    expect(forge.check).toHaveBeenCalledWith(['A', 'Not Real']);
  });

  it('ok when every card resolves and Forge knows them all', async () => {
    const cards = [card('A'), card('B')];
    const forge: ForgeChecker = { check: vi.fn().mockResolvedValue([]) };
    expect(await checkCards(cards, forge)).toEqual({ ok: true, cards: 2 });
  });

  it('without a jar: missing text still refuses on its own; otherwise refused with a reason', async () => {
    expect(await checkCards([{ ...card('Mystery'), typeLine: '' }], null)).toEqual({ ok: false, unplayable: [], missingText: ['Mystery'] });
    const verdict = await checkCards([card('A')], null);
    expect(verdict.ok).toBe(false);
  });
});

/*
 * CI fix-forward (run 39715510788): the jar-less e2e stack's own escape
 * hatch (CONFIG.testUncheckedPools, threaded in here as checkCards' third
 * argument) — never from production, never a substitute for a real catalog
 * check.
 */
describe('checkCards — the jar-less e2e escape hatch', () => {
  it('opt-in + no jar: ok when every card resolved', async () => {
    const cards = [card('A'), card('B')];
    expect(await checkCards(cards, null, { uncheckedWithoutJar: true })).toEqual({ ok: true, cards: 2 });
  });

  it('opt-in + no jar: missingText still refuses — this is an escape from "no jar", never from "no catalog text"', async () => {
    const cards = [card('A'), { ...card('Mystery'), typeLine: '' }];
    expect(await checkCards(cards, null, { uncheckedWithoutJar: true })).toEqual({ ok: false, unplayable: [], missingText: ['Mystery'] });
  });

  it('no opt-in + no jar: refused, unchanged', async () => {
    const verdict = await checkCards([card('A')], null);
    expect(verdict.ok).toBe(false);
  });

  it('opt-in WITH a jar: the real check still runs — the flag never stands in for Forge', async () => {
    const cards = [card('A'), card('Not Real')];
    const forge: ForgeChecker = { check: vi.fn(async (names: readonly string[]) => names.filter((n) => n === 'Not Real')) };
    const verdict = await checkCards(cards, forge, { uncheckedWithoutJar: true });
    expect(verdict).toEqual({ ok: false, unplayable: ['Not Real'], missingText: [] });
    expect(forge.check).toHaveBeenCalledWith(['A', 'Not Real']);
  });
});

/*
 * Step 6: the real C module, not a fake — `createCubeStore` against the
 * committed shortlist `index.ts` points `shortlistDir` at. Proves the actual
 * wiring `index.ts` does, not a stand-in for it: the 8-cube shortlist loads,
 * and without a jar the Settled default plan (3 rounds of the same cube) is
 * refused, with a reason, never passed by default.
 */
describe('step 6 — createCubeStore against the real shortlist, no jar', () => {
  const SHORTLIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../pools/cubes');
  const importDirs: string[] = [];

  afterEach(async () => {
    for (const dir of importDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function realStore() {
    const importDir = await mkdtemp(join(tmpdir(), 'cardtable-plan-test-'));
    importDirs.push(importDir);
    return createCubeStore({ shortlistDir: SHORTLIST_DIR, importDir, catalog: loadCardCatalog('/no/such/catalog.json') });
  }

  it('loads all 8 shortlisted cubes', async () => {
    const store = await realStore();
    expect(store.list()).toHaveLength(8);
    expect(store.list().every((c) => c.origin === 'shortlist')).toBe(true);
  });

  it('without a jar, the Settled default plan is refused rather than passed by default', async () => {
    const store = await realStore();
    const verdict = await checkPlan(DEFAULT_PLAN, { cubes: store, forge: null });
    expect(verdict.ok).toBe(false);
  });
});
