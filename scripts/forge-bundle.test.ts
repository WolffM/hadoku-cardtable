/**
 * scripts/forge-bundle.sh, exercised against a FAKE `git`/`mvn` on PATH and a
 * fixture cache root under the OS temp dir — never the real `~/.cache` or
 * `~/.m2`. The live proof against the real toolchain and the real
 * WolffM/forge fork is a separate, manual run (see docs/FORGE_JAR.md).
 *
 * Each test below is paired with a guard in the script; mutation-testing
 * notes (which guard, which test reds) are kept in the lane's closing report,
 * not here — this file only needs to pass green against the correct script.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'forge-bundle.sh');

// A scratch root for this whole file's fixtures, named for the lane so two
// concurrent test runs (or a stray leftover) are easy to spot and never
// collide with another lane's scratch.
const LANE_SCRATCH = join(tmpdir(), 'forge-claws-A', 'vitest');
mkdirSync(LANE_SCRATCH, { recursive: true });

// The claws (jdk21 label) carry Temurin 21 here; absent elsewhere. The
// no-unzip/no-strings test below is skipped, not failed, when this host
// doesn't have it — it proves the `jar` fallback, not this host's toolchain.
// FORGE_BUNDLE_TEST_JDK_BIN_DIR is test-only (never the script's own
// interface): it lets a proof run point this at a path that does not exist,
// to confirm the skip itself fires correctly, without needing a second host
// that genuinely lacks the JDK.
const JDK_BIN_DIR = process.env.FORGE_BUNDLE_TEST_JDK_BIN_DIR ?? '/home/hadoku/.local/opt/jdk-21.0.12.1+1/bin';
const JDK_JAR = join(JDK_BIN_DIR, 'jar');
const HAS_JDK_JAR = existsSync(JDK_JAR);

let fakeBinDir: string;
// A PATH with every coreutil the script and its fakes need EXCEPT `unzip`
// and `strings` — plus the real JDK's `jar` — so extract_main_class() is
// forced down its `jar xf` fallback, the way it must on a claw.
let noUnzipBinDir: string;

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

// `command -v unzip` on the REAL (this-process) PATH, used only for a
// sanity check that the fixture jar `make-jar.mjs` writes is actually a
// valid zip — never for anything the script itself does. Absent on a claw,
// so that one assertion is skipped there, not failed.
const REAL_UNZIP = spawnSync('/usr/bin/bash', ['-c', 'command -v unzip || true'], { encoding: 'utf8' }).stdout.trim();

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(LANE_SCRATCH, 'fakebin-'));

  // A minimal, pure-Node STORED-method zip writer: one entry,
  // forge/view/Main.class, bytes "server\n". The claws have no `zip` CLI
  // (and the fake `mvn` below used to shell out to one), so the fixture jar
  // is built with nothing but Node's own `node:zlib` (crc32, Node >=22.2;
  // we run 24) and `node:fs` — no external tool at all.
  writeFileSync(
    join(fakeBinDir, 'make-jar.mjs'),
    `import { crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
const name = Buffer.from('forge/view/Main.class', 'ascii');
const data = Buffer.from('server\\n', 'ascii');
const crc = crc32(data);

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

const localHeader = Buffer.concat([
  u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
  u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
]);
const localRecord = Buffer.concat([localHeader, data]);

const centralHeader = Buffer.concat([
  u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
  u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
  u16(0), u16(0), u32(0), u32(0), name,
]);

const cdOffset = localRecord.length;
const cdSize = centralHeader.length;
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(cdSize), u32(cdOffset), u16(0),
]);

writeFileSync(out, Buffer.concat([localRecord, centralHeader, eocd]));
`,
    'utf8',
  );

  // Serves BOTH `git ls-tree HEAD forge` (this checkout's own pin) and the
  // scratch clone of the fork (init / remote add / fetch / checkout),
  // because the real script uses `git` for both. Each scenario is driven by
  // an env var rather than an argument, since the script's own interface
  // (no flags) is settled and not to be changed for testing.
  writeExecutable(
    join(fakeBinDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "ls-tree" ]; then
  if [ "\${FAKE_GIT_NO_PIN:-}" = "1" ]; then
    exit 0
  fi
  printf '160000 commit %s\\tforge\\n' "\${FAKE_GIT_PIN:?FAKE_GIT_PIN not set for fake git ls-tree}"
  exit 0
fi

if [ "\${1:-}" = "-C" ]; then
  dir="$2"
  shift 2
  case "\${1:-}" in
    init)
      mkdir -p "$dir/.git"
      exit 0
      ;;
    remote)
      exit 0
      ;;
    fetch)
      if [ "\${FAKE_GIT_FETCH_FAIL:-}" = "1" ]; then
        echo "fake-git: fetch failed (FAKE_GIT_FETCH_FAIL=1)" >&2
        exit 1
      fi
      touch "$dir/FETCH_HEAD"
      exit 0
      ;;
    checkout)
      mkdir -p "$dir/forge-gui/res"
      if [ "\${FAKE_GIT_NO_CARDSFOLDER:-}" != "1" ]; then
        mkdir -p "$dir/forge-gui/res/cardsfolder"
        echo fixture > "$dir/forge-gui/res/cardsfolder/placeholder.txt"
      fi
      mkdir -p "$dir/forge-gui-desktop"
      exit 0
      ;;
    *)
      exit 0
      ;;
  esac
fi

exit 0
`,
  );

  // A jar the real verification accepts: forge/view/Main.class whose bytes
  // contain the string "server" and not "sentry". Logs every invocation to
  // FAKE_MVN_CALL_LOG (if set) BEFORE honouring FAKE_MVN_FAIL, so a test can
  // tell "mvn ran and failed" apart from "mvn never ran".
  writeExecutable(
    join(fakeBinDir, 'mvn'),
    `#!/usr/bin/env bash
set -euo pipefail

if [ -n "\${FAKE_MVN_CALL_LOG:-}" ]; then
  echo called >> "$FAKE_MVN_CALL_LOG"
fi

if [ "\${FAKE_MVN_SLEEP:-}" != "" ]; then
  sleep "$FAKE_MVN_SLEEP"
fi

if [ "\${FAKE_MVN_FAIL:-}" = "1" ]; then
  echo "fake-mvn: build failed (FAKE_MVN_FAIL=1)" >&2
  exit 1
fi

mkdir -p forge-gui-desktop/target
node "${join(fakeBinDir, 'make-jar.mjs')}" forge-gui-desktop/target/forge-gui-desktop-9.9.9-jar-with-dependencies.jar
exit 0
`,
  );

  // A curated PATH entry carrying every coreutil the script (and the fakes
  // above) call, EXCEPT `unzip` and `strings` — symlinked in individually so
  // nothing from the real /usr/bin leaks back in by accident. No `zip`
  // either: the fixture jar is built by `make-jar.mjs` in pure Node, not a
  // `zip` CLI, matching the claws exactly (they have neither).
  noUnzipBinDir = mkdtempSync(join(LANE_SCRATCH, 'no-unzip-bin-'));
  const needed = [
    'awk',
    'flock',
    'mktemp',
    'mkdir',
    'cp',
    'rm',
    'mv',
    'stat',
    'sort',
    'cut',
    'du',
    'tr',
    'grep',
    'date',
    'bash',
    'sh',
    'env',
    'touch',
    'dirname',
    'basename',
    'readlink',
  ];
  for (const tool of needed) {
    const real = spawnSync('/usr/bin/bash', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).stdout.trim();
    if (real) {
      symlinkSync(real, join(noUnzipBinDir, tool));
    }
  }
  // The fake `mvn`'s `node "<make-jar.mjs>" ...` call resolves `node` via
  // PATH, and this test's PATH has no inherited tail — symlink the actual
  // running interpreter in so it is found.
  symlinkSync(process.execPath, join(noUnzipBinDir, 'node'));
});

// Each test makes its own cache root under LANE_SCRATCH; fixtures are left on
// disk for post-mortem rather than cleaned per-test. The whole LANE_SCRATCH
// tree is disposable and never touches the real ~/.cache or ~/.m2.

function freshCacheRoot(): string {
  return mkdtempSync(join(LANE_SCRATCH, 'cache-'));
}

function freshPin(): string {
  return randomBytes(20).toString('hex');
}

interface RunOpts {
  cacheRoot: string;
  env?: Record<string, string>;
}

function runScript({ cacheRoot, env = {} }: RunOpts) {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete childEnv.RUNNER_TEMP;
  delete childEnv.TMPDIR;
  childEnv.PATH = `${fakeBinDir}:${childEnv.PATH ?? '/usr/bin:/bin'}`;
  childEnv.CARDTABLE_FORGE_CACHE = cacheRoot;
  Object.assign(childEnv, env);

  return spawnSync('bash', [SCRIPT], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function makeFixtureBundle(
  cacheRoot: string,
  pin: string,
  opts: { cardsfolder?: boolean; marker?: boolean; markerEpochSec?: number } = {},
): void {
  const { cardsfolder = true, marker = true, markerEpochSec } = opts;
  const dir = join(cacheRoot, pin);
  mkdirSync(join(dir, 'res'), { recursive: true });
  writeFileSync(join(dir, 'forge.jar'), 'not a real jar, just a fixture');
  if (cardsfolder) {
    mkdirSync(join(dir, 'res', 'cardsfolder'), { recursive: true });
    writeFileSync(join(dir, 'res', 'cardsfolder', 'placeholder.txt'), 'fixture');
  }
  if (marker) {
    const markerPath = join(dir, '.forge-bundle-marker');
    writeFileSync(markerPath, `built by scripts/forge-bundle.sh\npin=${pin}\nbuilt_at=fixture\n`);
    if (markerEpochSec !== undefined) {
      utimesSync(markerPath, markerEpochSec, markerEpochSec);
    }
  }
}

describe('scripts/forge-bundle.sh', () => {
  it('a cache hit prints both lines and does not invoke mvn', () => {
    const cacheRoot = freshCacheRoot();
    const pin = freshPin();
    makeFixtureBundle(cacheRoot, pin);

    const result = runScript({
      cacheRoot,
      env: { FAKE_GIT_PIN: pin, FAKE_MVN_FAIL: '1' }, // if mvn ran, this would red the run
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `CARDTABLE_FORGE_JAR=${join(cacheRoot, pin, 'forge.jar')}\n` +
        `CARDTABLE_FORGE_RES=${join(cacheRoot, pin, 'res')}\n`,
    );
    expect(result.stderr).toMatch(/HIT/);
    expect(result.stderr).not.toMatch(/BUILD/);
  });

  it('a miss builds, then a second call hits', () => {
    const cacheRoot = freshCacheRoot();
    const pin = freshPin();
    const callLog = join(LANE_SCRATCH, `mvn-calls-${pin}.log`);

    const first = runScript({
      cacheRoot,
      env: { FAKE_GIT_PIN: pin, FAKE_MVN_CALL_LOG: callLog },
    });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/BUILD/);
    expect(first.stdout).toBe(
      `CARDTABLE_FORGE_JAR=${join(cacheRoot, pin, 'forge.jar')}\n` +
        `CARDTABLE_FORGE_RES=${join(cacheRoot, pin, 'res')}\n`,
    );
    expect(existsSync(join(cacheRoot, pin, 'forge.jar'))).toBe(true);
    expect(existsSync(join(cacheRoot, pin, 'res', 'cardsfolder'))).toBe(true);
    expect(existsSync(callLog)).toBe(true);

    // Sanity check on the fixture itself, not the script: the real `unzip`
    // (present on hokon, absent on a claw — hence the guard) confirms
    // `make-jar.mjs` wrote a genuinely valid zip, not just bytes the
    // script's own tr/grep-based check happens to accept.
    if (REAL_UNZIP) {
      const ztest = spawnSync(REAL_UNZIP, ['-t', join(cacheRoot, pin, 'forge.jar')], { encoding: 'utf8' });
      expect(ztest.status, ztest.stdout + ztest.stderr).toBe(0);
    }

    // Second call: same pin, same cache root, mvn now set to fail — a HIT
    // must not invoke it.
    const second = runScript({
      cacheRoot,
      env: { FAKE_GIT_PIN: pin, FAKE_MVN_FAIL: '1', FAKE_MVN_CALL_LOG: callLog },
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toMatch(/HIT/);
    expect(second.stdout).toBe(first.stdout);

    // mvn was invoked exactly once across both calls (by the first one).
    const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
    expect(calls.length).toBe(1);
  });

  it('a build failure exits non-zero and leaves no bundle under the final name', () => {
    const cacheRoot = freshCacheRoot();
    const pin = freshPin();

    const result = runScript({
      cacheRoot,
      env: { FAKE_GIT_PIN: pin, FAKE_MVN_FAIL: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/build failed/);
    expect(existsSync(join(cacheRoot, pin))).toBe(false);
  });

  it('two concurrent calls build once', async () => {
    const cacheRoot = freshCacheRoot();
    const pin = freshPin();
    const callLog = join(LANE_SCRATCH, `mvn-calls-concurrent-${pin}.log`);

    const spawnOnce = () =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
        delete childEnv.RUNNER_TEMP;
        delete childEnv.TMPDIR;
        childEnv.PATH = `${fakeBinDir}:${childEnv.PATH ?? '/usr/bin:/bin'}`;
        childEnv.CARDTABLE_FORGE_CACHE = cacheRoot;
        childEnv.FAKE_GIT_PIN = pin;
        childEnv.FAKE_MVN_CALL_LOG = callLog;
        childEnv.FAKE_MVN_SLEEP = '0.4'; // give the second racer time to arrive at the lock
        const child = spawn('bash', [SCRIPT], { env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
      });

    const [a, b] = await Promise.all([spawnOnce(), spawnOnce()]);

    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    // Exactly one of the two actually ran the build; the other saw a HIT
    // once it got the lock.
    const kinds = [a.stderr, b.stderr].map((s) => (/BUILD/.test(s) ? 'BUILD' : 'HIT'));
    expect(kinds.sort()).toEqual(['BUILD', 'HIT']);

    const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
    expect(calls.length).toBe(1);
  });

  it('a res/ without cardsfolder/ is refused', () => {
    const cacheRoot = freshCacheRoot();
    const pin = freshPin();

    const result = runScript({
      cacheRoot,
      env: { FAKE_GIT_PIN: pin, FAKE_GIT_NO_CARDSFOLDER: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cardsfolder/);
    expect(existsSync(join(cacheRoot, pin))).toBe(false);
  });

  it('prune keeps 3 and never the serving pin', () => {
    const cacheRoot = freshCacheRoot();
    const pins = Array.from({ length: 5 }, () => freshPin());
    const [oldest, p2, p3, p4, newest] = pins;

    // `oldest` is also the pin this run serves, which touches its marker to
    // "now" on the HIT path (so a normally-served pin ages back into the
    // kept window on its own). To exercise the "never the serving pin"
    // special case regardless, the other four are planted in the FUTURE —
    // ahead of "now" by minutes, far past the touch's own clock skew — so
    // `oldest` stays the least-recent of the five even after being touched.
    const now = Math.floor(Date.now() / 1000);
    makeFixtureBundle(cacheRoot, oldest, { markerEpochSec: now - 1_000_000 });
    makeFixtureBundle(cacheRoot, p2, { markerEpochSec: now + 1_000 });
    makeFixtureBundle(cacheRoot, p3, { markerEpochSec: now + 2_000 });
    makeFixtureBundle(cacheRoot, p4, { markerEpochSec: now + 3_000 });
    makeFixtureBundle(cacheRoot, newest, { markerEpochSec: now + 4_000 });

    const result = runScript({
      cacheRoot,
      env: { FAKE_GIT_PIN: oldest, FAKE_MVN_FAIL: '1' }, // this run must be a HIT
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/HIT/);

    expect(existsSync(join(cacheRoot, oldest))).toBe(true); // the serving pin, protected
    expect(existsSync(join(cacheRoot, p2))).toBe(false); // older than the newest 3, not served
    expect(existsSync(join(cacheRoot, p3))).toBe(true);
    expect(existsSync(join(cacheRoot, p4))).toBe(true);
    expect(existsSync(join(cacheRoot, newest))).toBe(true);
  });

  // The claws run forge.yml's jobs with no `unzip` (and almost certainly no
  // `strings`) on PATH — only hokon is guaranteed to carry them. Only the
  // JDK's own `jar` tool is guaranteed there (the `jdk21` runner label).
  // Skipped, not failed, on a host without that exact JDK — it is proving
  // the fallback exists, not this host's toolchain.
  it.skipIf(!HAS_JDK_JAR)('a miss builds and verifies with no unzip/strings, via the JDK jar fallback', () => {
    const cacheRoot = freshCacheRoot();
    const pin = freshPin();

    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete childEnv.RUNNER_TEMP;
    delete childEnv.TMPDIR;
    // No fakeBinDir and no inherited PATH at all: just the curated
    // no-unzip/no-strings tool dir plus the real JDK's bin dir, so `command
    // -v unzip` and `command -v strings` both genuinely fail, and `command
    // -v jar` finds the real one.
    childEnv.PATH = `${fakeBinDir}:${noUnzipBinDir}:${JDK_BIN_DIR}`;
    childEnv.CARDTABLE_FORGE_CACHE = cacheRoot;
    childEnv.FAKE_GIT_PIN = pin;

    const result = spawnSync('bash', [SCRIPT], { env: childEnv, encoding: 'utf8', timeout: 30_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/BUILD/);
    expect(result.stdout).toBe(
      `CARDTABLE_FORGE_JAR=${join(cacheRoot, pin, 'forge.jar')}\n` +
        `CARDTABLE_FORGE_RES=${join(cacheRoot, pin, 'res')}\n`,
    );
    expect(existsSync(join(cacheRoot, pin, 'forge.jar'))).toBe(true);
  });
});
