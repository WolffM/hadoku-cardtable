#!/usr/bin/env -S node --
/*
 * The monkey seat: a headless client that joins vs-AI matches on a REAL
 * running server (the same process a browser talks to, behind the e2e
 * stand-in edge) and plays them out, picking a random legal answer to every
 * ask Forge raises and a random legal board action otherwise. See
 * `docs/MONKEY.md` for how to run it, read a report, and reproduce a seed.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   apps/server/node_modules/.bin/tsx apps/server/src/play/monkey/cli.ts \
 *     --seed 1 --matches-per-deck 1 --out /tmp/monkey-report.json
 *
 * Ports: this stack's own, picked free by `e2e/ports.ts` unless the
 * `CARDTABLE_E2E_PLAY_*_PORT` variables hand it some, so a monkey run never
 * collides with another stack on the same host.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PREFIX, SESSION_COOKIE } from '../../../../../e2e/identities.ts';
import { forgeAvailability, startPlayStack } from '../../../../../e2e/play/harness.ts';

import { fetchDeckLibrary } from './deck-pool.ts';
import { runPool } from './pool.ts';
import { makeRng, seedArg, seedFrom } from './rng.ts';
import { runMatch } from './run-match.ts';
import { buildReport, stopReason, summaryText, type MatchResult } from './report.ts';

interface Args {
  seed: number | string;
  matchesPerDeck: number;
  deck: string | null;
  /** A random sample of this many library decks, instead of every one (or `--deck`'s one). */
  sample: number | null;
  out: string;
  stuckMs: number;
  matchTimeoutMs: number;
  turnCap: number;
  concurrency: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sample = get('sample');
  return {
    seed: seedArg(get('seed')) ?? Date.now(),
    matchesPerDeck: Number(get('matches-per-deck') ?? '1'),
    deck: get('deck') ?? null,
    sample: sample === undefined ? null : Number(sample),
    out: get('out') ?? resolve(process.cwd(), 'monkey-report.json'),
    stuckMs: Number(get('stuck-ms') ?? '20000'),
    matchTimeoutMs: Number(get('match-timeout-ms') ?? '180000'),
    turnCap: Number(get('turn-cap') ?? '60'),
    concurrency: Number(get('concurrency') ?? '2'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seed = seedFrom(args.seed);
  console.log(`[monkey] seed ${seed} (from ${JSON.stringify(args.seed)})`);

  const available = forgeAvailability();
  if (!available.ok) {
    console.error(`[monkey] no Forge: ${available.reason}`);
    process.exitCode = 2;
    return;
  }

  const stack = await startPlayStack({ jar: available.jar, res: available.res });
  console.log(`[monkey] play stack up at ${stack.origin} (work dir ${stack.workDir})`);

  const cookie = `${SESSION_COOKIE}=alice`;

  try {
    const library = await fetchDeckLibrary(stack.origin, PREFIX, cookie);
    if (library.length === 0) throw new Error('the server has no library decks');
    const seedRng = makeRng(seed);
    const decksToCover =
      args.deck !== null
        ? library.filter((d) => d.id === args.deck)
        : args.sample !== null
          ? seedRng.sample(library, args.sample)
          : library;
    if (decksToCover.length === 0) throw new Error(`no library deck ${JSON.stringify(args.deck)}`);
    console.log(`[monkey] ${library.length} library deck(s); covering ${decksToCover.length}`);

    const startedAt = new Date().toISOString();
    const tasks: (() => Promise<MatchResult>)[] = [];
    let runIndex = 0;
    for (const deck of decksToCover) {
      for (let i = 0; i < args.matchesPerDeck; i += 1) {
        const thisRun = runIndex;
        runIndex += 1;
        tasks.push(async () => {
          const matchSeed = seedFrom(`${seed}:${deck.id}:${i}`);
          const rng = makeRng(matchSeed);
          const opponent = rng.pick(library) ?? deck;
          console.log(`[monkey] run ${thisRun}: ${deck.name} (monkey) vs ${opponent.name} (AI), seed ${matchSeed}`);
          const result = await runMatch({
            origin: stack.origin,
            prefix: PREFIX,
            cookie,
            seed: matchSeed,
            rng,
            decks: { seat0: deck.name, seat1: opponent.name },
            deckRefs: { seat0: { id: deck.id, era: deck.era }, seat1: { id: opponent.id, era: opponent.era } },
            stuckMs: args.stuckMs,
            matchTimeoutMs: args.matchTimeoutMs,
            turnCap: args.turnCap,
            serverLogFile: stack.serverLogFile,
            workDir: stack.workDir,
          });
          console.log(`[monkey] run ${thisRun} (${deck.name}): ${result.outcome}, ${result.decisions} decision(s), ${result.flags.length} flag(s)`);
          return result;
        });
      }
    }

    const { results: matches, stopped } = await runPool(tasks, args.concurrency, stopReason);
    const report = buildReport(seed, decksToCover.map((d) => d.id), matches, startedAt, stopped);
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log('');
    console.log(summaryText(report));
    console.log(`[monkey] report written to ${args.out}`);
    if (stopped !== null) {
      // Exit 2, as for no Forge: the run could not cover its decks, which says nothing about the UI.
      console.error(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}[monkey] stopped after ${matches.length} of ${tasks.length} match(es): ${stopped}`);
      process.exitCode = 2;
    } else {
      process.exitCode = report.summary.flagged > 0 ? 1 : 0;
    }
  } finally {
    await stack.stop();
  }
}

main().catch((err) => {
  console.error('[monkey] fatal:', err);
  process.exitCode = 2;
});
