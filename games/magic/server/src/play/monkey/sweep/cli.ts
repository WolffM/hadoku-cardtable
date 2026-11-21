#!/usr/bin/env -S node --
/*
 * The card sweep: every scripted card of one set, played on purpose against real Forge on a real
 * running server, through the client a browser runs. `docs/MONKEY.md` ("The card sweep") has how to
 * run it and read its report.
 *
 *   apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/sweep/cli.ts \
 *     --set BLB --out /tmp/sweep-blb.json [--card "Parting Gust"] [--variant accept|decline] [--per-match 6] [--update]
 *
 * A card has a match of its own unless `--per-match` says otherwise. A play that does not ask what is
 * recorded is played again alone, three times at most, and counts as differing only if it never does.
 * Exit 0: no flag, every optional-cost keyword asked and refusable (`mechanics.ts`), and every card
 * asked what `expected/<SET>.json` records. Exit 1 otherwise.
 * `--update` records what was asked instead of checking it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PREFIX, SESSION_COOKIE } from '../../../../../../../e2e/identities.ts';
import { forgeAvailability, startPlayStack } from '../../../../../../../e2e/play/harness.ts';

import { watchExit } from '../exit-watch.ts';
import { runPool } from '../pool.ts';
import { makeRng, seedFrom } from '../rng.ts';

import { differences, differenceText, expectedOf, signatureOf, type Expected } from './expected.ts';
import { mechanicProblems } from './mechanics.ts';
import type { Variant } from './policy.ts';
import { runCards, type CardResult } from './run-cards.ts';
import { setCards, type SetCard } from './set-cards.ts';

/** How many times a play that does not ask what is recorded is played again before it counts as differing. */
const REPLAYS = 3;
/** The wall a match gets for each card past its first. */
const EXTRA_CARD_MS = 30_000;
/**
 * How long a swept match's finished game stays on its JVM. Play's own ten minutes is a returning
 * player's window to see how the game ended; the sweep reads the board before it concedes and
 * finishes a match every few seconds, so at ten minutes some 200 finished games stayed live, a
 * new JVM opened every 25 of them, and the runner's 8 GB memory cap killed the job (#82).
 */
const OVER_GRACE_MS = 10_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** `items` in runs of `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const set = arg('set') ?? 'BLB';
  const only = process.argv.flatMap((a, i) => (a === '--card' ? [process.argv[i + 1]!] : []));
  const variants: Variant[] = arg('variant') === undefined ? ['accept', 'decline'] : [arg('variant') as Variant];
  const out = arg('out') ?? resolve(process.cwd(), `sweep-${set.toLowerCase()}.json`);
  const seed = seedFrom(arg('seed') ?? 1);
  const concurrency = Number(arg('concurrency') ?? '2');
  const update = process.argv.includes('--update');
  // What is recorded is what a card asks in a match of its own, so recording plays one card a match.
  const perMatch = update ? 1 : Number(arg('per-match') ?? '1');

  const available = forgeAvailability();
  if (!available.ok) {
    console.error(`[sweep] no Forge: ${available.reason}`);
    process.exitCode = 2;
    return;
  }
  const all = setCards(available.res, set);
  const cards = all.filter((c) => (only.length > 0 ? only.includes(c.name) : c.scripted));
  if (cards.length === 0) throw new Error(`no card of ${set} matches ${JSON.stringify(only)}`);
  console.log(`[sweep] ${set}: ${all.length} card(s), ${all.filter((c) => c.scripted).length} scripted; sweeping ${cards.length} × ${variants.join('/')}, ${perMatch} a match`);

  const expectedFile = resolve(import.meta.dirname, 'expected', `${set}.json`);
  const recorded: Expected = existsSync(expectedFile) ? (JSON.parse(readFileSync(expectedFile, 'utf8')) as Expected) : {};

  const stack = await startPlayStack({ jar: available.jar, res: available.res }, { env: { CARDTABLE_PLAY_OVER_GRACE_MS: String(OVER_GRACE_MS) } });
  console.log(`[sweep] play stack up at ${stack.origin} (work dir ${stack.workDir})`);
  const startedAt = new Date().toISOString();
  // The result that counts for each card and variant. Written after every match, so a run that is killed leaves what it had played.
  const final = new Map<string, CardResult>();
  const save = (): void => writeFileSync(out, JSON.stringify({ set, seed, startedAt, finishedAt: new Date().toISOString(), cards: [...final.values()] }, null, 1));
  const keep = (results: readonly CardResult[]): void => {
    for (const r of results) final.set(`${r.card}:${r.variant}`, r);
    save();
  };
  const play = (group: readonly SetCard[], variant: Variant) => async (): Promise<void> => {
    const runSeed = seedFrom(`${seed}:${group.map((c) => c.name).join('+')}:${variant}`);
    const results = await runCards({
      origin: stack.origin,
      prefix: PREFIX,
      cookie: `${SESSION_COOKIE}=alice`,
      seed: runSeed,
      rng: makeRng(runSeed),
      cards: group,
      variant,
      stuckMs: Number(arg('stuck-ms') ?? '20000'),
      timeoutMs: Number(arg('timeout-ms') ?? '150000') + (group.length - 1) * EXTRA_CARD_MS,
      serverLogFile: stack.serverLogFile,
      workDir: stack.workDir,
    });
    const first = results[0]!;
    console.log(`[sweep] ${variant}: ${results.map((r) => `${r.card} ${r.cast}`).join(', ')} — ended ${first.ended}, ${first.flags.length} flag(s) [${first.flags.map((f) => f.kind).join(',')}] ${Math.round(first.ms / 1000)}s`);
    keep(results);
  };
  /** A play stands when it asked what is recorded for it and, out of a shared match, also resolved and flagged nothing. */
  const stands = (r: CardResult, shared: boolean): boolean => differences([r], recorded).length === 0 && (!shared || (r.flags.length === 0 && r.cast === 'resolved'));
  /** Plays that matched what is recorded only when played again. */
  const unsteady = new Set<string>();

  try {
    const first = variants.flatMap((variant) => chunks(cards, perMatch).map((group) => play(group, variant)));
    await runPool(first, concurrency, () => null, () => false);
    // Cards sharing a match change each other's play (a board wipe, a trigger on every cast), and a
    // question can land a frame either side of the click that answers it. So a play that does not
    // stand is played again in a match of its own: a card that changed differs every time.
    for (let round = 0; round < REPLAYS && !update; round += 1) {
      const again = [...final.values()].filter((r) => !stands(r, round === 0 && perMatch > 1));
      if (again.length === 0) break;
      console.log(`[sweep] ${final.size - again.length} of ${final.size} stand; playing ${again.length} again alone`);
      for (const r of again) unsteady.add(`${r.card} (${r.variant})`);
      const alone = again.map((r) => play([cards.find((c) => c.name === r.card)!], r.variant));
      await runPool(alone, concurrency, () => null, () => false);
    }

    const results = [...final.values()];
    const flagged = results.filter((r) => r.flags.length > 0);
    const unplayed = results.filter((r) => r.cast !== 'resolved');
    for (const r of flagged) for (const f of r.flags) console.log(`[sweep] FLAG ${r.card} (${r.variant}) ${f.kind}: ${f.detail}`);
    for (const r of unplayed) console.log(`[sweep] NOT PLAYED ${r.card} (${r.variant}): ${r.cast}`);

    // What a keyword promises is checked on what was just played, recorded or not.
    let broken = 0;
    for (const c of cards) {
      const of = (variant: Variant) => results.find((r) => r.card === c.name && r.variant === variant);
      const [accept, decline] = [of('accept'), of('decline')];
      for (const problem of mechanicProblems(c, accept && signatureOf(accept), decline && signatureOf(decline))) {
        broken += 1;
        console.log(`[sweep] MECHANIC ${c.name} — ${problem}`);
      }
    }

    let differing = 0;
    if (update) {
      // A run of some cards or one variant records those and keeps the rest.
      const merged: Expected = { ...recorded };
      for (const [card, byVariant] of Object.entries(expectedOf(results))) merged[card] = { ...merged[card], ...byVariant };
      writeFileSync(expectedFile, `${JSON.stringify(Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
      console.log(`[sweep] recorded ${results.length} run(s) in ${expectedFile}`);
    } else {
      const diffs = differences(results, recorded);
      differing = diffs.length;
      for (const d of diffs) console.log(`[sweep] DIFFERS ${differenceText(d)}`);
      const settled = [...unsteady].filter((key) => !diffs.some((d) => `${d.card} (${d.variant})` === key));
      if (settled.length > 0) console.log(`[sweep] ${settled.length} play(s) asked what is recorded only when played again: ${settled.join(', ')}`);
    }
    console.log(`[sweep] ${results.length} run(s): ${flagged.length} flagged, ${broken} keyword promise(s) broken, ${differing} differing from what is recorded, ${unplayed.length} not played through. Report: ${out}`);
    process.exitCode = flagged.length > 0 || broken > 0 || differing > 0 ? 1 : 0;
  } finally {
    await stack.stop();
    watchExit(30_000);
  }
}

main().catch((err) => {
  console.error('[sweep] fatal:', err);
  process.exitCode = 2;
});
