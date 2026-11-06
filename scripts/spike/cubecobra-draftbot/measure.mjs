#!/usr/bin/env node
/*
 * Spike: what does it cost to run CubeCobra's draftbot model in our Node server?
 *
 * Loads CubeCobra's encoder + draft_decoder (TF.js graph models, the same files
 * its recommender service loads with tfjs-node) and measures, in this process:
 *   - disk: the tfjs install and the weights
 *   - memory: RSS before and after loading, and the peak while picking
 *   - time: model load, and one pick round at several batch sizes
 *   - a whole 8-seat draft of a real cube from cubes/, every seat a bot
 *
 * Nothing here enters the repo or the bundle. The weights, the tfjs install and
 * the oracle-id lookups live under $SPIKE_DIR (default
 * ~/.cache/cardtable-spikes/cubecobra). The weights carry no stated licence:
 * this measures them, it does not ship them.
 *
 * Setup, once:
 *   D=~/.cache/cardtable-spikes/cubecobra; mkdir -p $D && cd $D
 *   echo '{"private":true}' > package.json
 *   npm i --no-audit --no-fund @tensorflow/tfjs-node@4.22.0 @tensorflow/tfjs@4.22.0
 *
 * Run (from the repo root; one run per backend, so each process measures one):
 *   node scripts/spike/cubecobra-draftbot/measure.mjs [--backend tensorflow|cpu] [--cube "<cubes/*.dck name>"]
 *
 * --backend tensorflow  tfjs-node, native libtensorflow (what CubeCobra's server uses)
 * --backend cpu         pure-JS tfjs, no native dependency
 */

import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import util, { parseArgs } from "node:util";

// tfjs-node 4.22 (the last release) calls util.isNullOrUndefined, which Node 23 removed.
// Node 24 cannot run it without this shim — a finding in itself.
util.isNullOrUndefined ??= (v) => v === null || v === undefined;

const { values: args } = parseArgs({
  options: {
    backend: { type: "string", default: "tensorflow" },
    cube: { type: "string", default: "MTGO Vintage Cube 2013" },
    rounds: { type: "string", default: "30" },
  },
});

const SPIKE_DIR =
  process.env.SPIKE_DIR ??
  join(homedir(), ".cache", "cardtable-spikes", "cubecobra");
const MODEL_DIR = join(SPIKE_DIR, "model");
const MODEL_BASE = "https://cubecobra-public.s3.us-east-2.amazonaws.com/model";
const HEADS = ["encoder", "draft_decoder"];
const CATALOG = join(
  homedir(),
  ".local",
  "share",
  "cardtable",
  "catalog",
  "cards.json",
);
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const UA = {
  "User-Agent": "hadoku-cardtable-spike/1.0",
  Accept: "application/json",
};

const MB = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const mem = () => process.memoryUsage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dirBytes(path) {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path); // a symlink (libtensorflow.so → .so.2.9.1) is not counted twice
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce(
    (sum, name) => sum + dirBytes(join(path, name)),
    0,
  );
}

async function download(url, to) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

/** The two heads a pick needs, fetched once into MODEL_DIR. */
async function ensureWeights() {
  mkdirSync(MODEL_DIR, { recursive: true });
  const map = join(MODEL_DIR, "indexToOracleMap.json");
  if (!existsSync(map))
    await download(`${MODEL_BASE}/indexToOracleMap.json`, map);
  for (const head of HEADS) {
    const dir = join(MODEL_DIR, head);
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, "model.json");
    if (!existsSync(manifest))
      await download(`${MODEL_BASE}/${head}/model.json`, manifest);
    const shards = JSON.parse(
      readFileSync(manifest, "utf8"),
    ).weightsManifest.flatMap((g) => g.paths);
    for (const shard of shards) {
      const to = join(dir, shard);
      if (!existsSync(to)) await download(`${MODEL_BASE}/${head}/${shard}`, to);
    }
  }
}

/** Card names of a cube, one per copy, from our own .dck. */
function cubeNames(cube) {
  const text = readFileSync(join(REPO, "cubes", `${cube}.dck`), "utf8");
  const names = [];
  let inMain = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) inMain = t.toLowerCase() === "[main]";
    else if (inMain && t) {
      const m = /^(\d+)\s+([^|]+)/.exec(t);
      if (!m) throw new Error(`unparsed .dck line: ${t}`);
      for (let i = 0; i < Number(m[1]); i++) names.push(m[2].trim());
    }
  }
  return names;
}

/**
 * name → oracle id for the cube's cards. Our catalog carries scryfallId but no
 * oracle id (the model's vocabulary), so this asks Scryfall's collection
 * endpoint, 75 ids a request, and caches the answer.
 */
async function oracleIds(names) {
  const cachePath = join(SPIKE_DIR, "oracle-by-scryfall-id.json");
  const cache = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
  const lookup = (name) => {
    const key = name.toLowerCase();
    return catalog.cards[key] ?? catalog.cards[catalog.aliases?.[key]];
  };
  const scryfallIdOf = new Map();
  const unresolved = [];
  for (const name of new Set(names)) {
    const card = lookup(name);
    if (card) scryfallIdOf.set(name, card.scryfallId);
    else unresolved.push(name);
  }
  const missing = [...new Set(scryfallIdOf.values())].filter(
    (id) => !(id in cache),
  );
  for (let i = 0; i < missing.length; i += 75) {
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/json" },
      body: JSON.stringify({
        identifiers: missing.slice(i, i + 75).map((id) => ({ id })),
      }),
    });
    if (!res.ok)
      throw new Error(`Scryfall collection: ${res.status} ${await res.text()}`);
    for (const card of (await res.json()).data)
      cache[card.id] = card.oracle_id ?? card.card_faces?.[0]?.oracle_id;
    await sleep(120);
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  const oracleOf = new Map();
  for (const [name, id] of scryfallIdOf)
    if (cache[id]) oracleOf.set(name, cache[id]);
  return { oracleOf, unresolved };
}

function percentile(sorted, p) {
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

async function main() {
  await ensureWeights();
  const require = createRequire(join(SPIKE_DIR, "package.json"));

  const m0 = mem();
  const tf =
    args.backend === "cpu"
      ? require("@tensorflow/tfjs")
      : require("@tensorflow/tfjs-node");
  if (args.backend === "cpu") await tf.setBackend("cpu");
  await tf.ready();
  const m1 = mem();

  const indexToOracle = JSON.parse(
    readFileSync(join(MODEL_DIR, "indexToOracleMap.json"), "utf8"),
  );
  const numOracles = Object.keys(indexToOracle).length;
  const oracleToIndex = new Map(
    Object.entries(indexToOracle).map(([i, o]) => [o, Number(i)]),
  );

  const tLoad = performance.now();
  const loadHandler = (head) =>
    args.backend === "cpu"
      ? tf.io.fromMemory(fromDisk(join(MODEL_DIR, head)))
      : `file://${join(MODEL_DIR, head, "model.json")}`;
  const encoder = await tf.loadGraphModel(loadHandler("encoder"));
  const decoder = await tf.loadGraphModel(loadHandler("draft_decoder"));
  const loadMs = performance.now() - tLoad;
  globalThis.gc?.();
  const m2 = mem();

  let peakRss = m2.rss;
  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  /** CubeCobra's pick: one-hot pools → encoder → draft_decoder → argmax over the pack. */
  async function pickBatch(packs, pools) {
    const rows = pools.length;
    const input = new Float32Array(rows * numOracles);
    pools.forEach((pool, r) => {
      for (const o of pool) {
        const idx = oracleToIndex.get(o);
        if (idx !== undefined) input[r * numOracles + idx] = 1;
      }
    });
    const logits = tf.tidy(() =>
      decoder.predict(encoder.predict(tf.tensor2d(input, [rows, numOracles]))),
    );
    const data = await logits.data();
    sample();
    logits.dispose();
    return packs.map((pack, r) => {
      let best = pack[0];
      let bestLogit = -Infinity;
      for (const o of pack) {
        const idx = oracleToIndex.get(o);
        if (idx !== undefined && data[r * numOracles + idx] > bestLogit) {
          bestLogit = data[r * numOracles + idx];
          best = o;
        }
      }
      return best;
    });
  }

  // Synthetic rounds: random in-vocabulary pools and packs, as many seats as a batch holds.
  const vocab = [...oracleToIndex.keys()];
  const randomCards = (n) =>
    Array.from(
      { length: n },
      () => vocab[Math.floor(Math.random() * vocab.length)],
    );
  const rounds = Number(args.rounds);
  const timings = [];
  for (const seats of [1, 7, 28, 56]) {
    const times = [];
    for (let i = 0; i < rounds + 3; i++) {
      const pools = Array.from({ length: seats }, () =>
        randomCards(1 + Math.floor(Math.random() * 44)),
      );
      const packs = Array.from({ length: seats }, () => randomCards(15));
      const t = performance.now();
      await pickBatch(packs, pools);
      if (i >= 3) times.push(performance.now() - t); // the first rounds warm the graph
    }
    times.sort((a, b) => a - b);
    timings.push({
      seats,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
    });
  }

  // A whole draft of a real cube: 8 bot seats, 3 packs of 15, packs pass left then right.
  const names = cubeNames(args.cube);
  const { oracleOf, unresolved } = await oracleIds(names);
  const nameOf = new Map([...oracleOf].map(([n, o]) => [o, n]));
  const cards = names
    .filter((n) => oracleOf.has(n))
    .map((n) => oracleOf.get(n));
  const inVocab = cards.filter((o) => oracleToIndex.has(o)).length;
  const shuffled = [...cards].sort(() => Math.random() - 0.5);
  const SEATS = 8;
  const PACK = 15;
  const pools = Array.from({ length: SEATS }, () => []);
  const firstPicks = [];
  const tDraft = performance.now();
  for (let round = 0; round < 3; round++) {
    let packs = Array.from({ length: SEATS }, () => shuffled.splice(0, PACK));
    for (let pick = 0; pick < PACK; pick++) {
      const chosen = await pickBatch(packs, pools);
      chosen.forEach((o, s) => {
        pools[s].push(o);
        packs[s].splice(packs[s].indexOf(o), 1);
        if (round === 0 && pick === 0) firstPicks.push(nameOf.get(o));
      });
      packs =
        round === 1
          ? [...packs.slice(1), packs[0]]
          : [packs.at(-1), ...packs.slice(0, -1)];
    }
  }
  const draftMs = performance.now() - tDraft;
  const m3 = mem();

  const report = {
    backend: tf.getBackend(),
    disk: {
      tfjsInstall: MB(dirBytes(join(SPIKE_DIR, "node_modules"))),
      weights: MB(dirBytes(MODEL_DIR)),
    },
    vocabulary: numOracles,
    memory: {
      rssBaseline: MB(m0.rss),
      rssAfterTfjs: MB(m1.rss),
      rssAfterModels: MB(m2.rss),
      modelsAdd: MB(m2.rss - m1.rss),
      rssPeakWhilePicking: MB(peakRss),
      rssAfterDraft: MB(m3.rss),
      heapUsedAfterDraft: MB(m3.heapUsed),
      externalAfterDraft: MB(m3.external),
    },
    loadSeconds: +(loadMs / 1000).toFixed(1),
    pickRoundMs: timings.map((t) => ({
      seats: t.seats,
      p50: +t.p50.toFixed(1),
      p95: +t.p95.toFixed(1),
    })),
    draft: {
      cube: args.cube,
      cubeCards: names.length,
      resolvedToOracle: cards.length,
      unresolvedNames: unresolved,
      inModelVocab: inVocab,
      seats: SEATS,
      picks: SEATS * PACK * 3,
      seconds: +(draftMs / 1000).toFixed(2),
      firstPicks,
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

/** A graph model's manifest and weights read from disk, for the pure-JS backend (no file:// handler). */
function fromDisk(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "model.json"), "utf8"));
  const buffers = manifest.weightsManifest
    .flatMap((g) => g.paths)
    .map((p) => readFileSync(join(dir, p)));
  const all = Buffer.concat(buffers);
  const weightData = all.buffer.slice(
    all.byteOffset,
    all.byteOffset + all.byteLength,
  );
  const weightSpecs = manifest.weightsManifest.flatMap((g) => g.weights);
  return {
    modelTopology: manifest.modelTopology,
    weightSpecs,
    weightData,
    format: manifest.format,
  };
}

await main();
