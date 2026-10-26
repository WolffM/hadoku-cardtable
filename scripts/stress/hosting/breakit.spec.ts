/*
 * docs/planning/hosting-test-plan.md §C: how today's one-JVM-per-match hosting fails.
 *
 * Kept OUT of e2e/ on purpose: these tests kill JVMs, freeze browsers, fill disks and start 20
 * matches at once, so CI's forge-e2e must never pick them up. To run one, on a claw (never
 * hokon: a stack is three JVMs, C5/C7 eleven), from a checkout with built apps/server and
 * apps/ui and linked node_modules:
 *
 *   cp scripts/stress/hosting/breakit.spec.ts e2e/zz-breakit.spec.ts
 *   cd e2e
 *   export PATH=<node 24>:$PATH CARDTABLE_FORGE_JAR=<jar> CARDTABLE_FORGE_RES=<res> \
 *     CARDTABLE_E2E_PLAY_EDGE_PORT=19628 CARDTABLE_E2E_PLAY_SERVER_PORT=19528 \
 *     CARDTABLE_E2E_EDGE_PORT=19608 CARDTABLE_E2E_SERVER_PORT=19508 \
 *     TMPDIR=<a dir with no dot segment> BREAKIT_OUT=<screenshots dir>
 *   npx playwright test zz-breakit.spec.ts -g "C1 "     # C1 C2 C2b C3a C3b C4 C5 C7
 *
 * C6 needs a small filesystem under the work dir: `c6-disk-full.sh` runs it inside `unshare -rm`
 * with a tmpfs over e2e's play-work root. C2b takes BREAKIT_STOP_S (the pause, seconds).
 * Every observation prints as a `[breakit]` JSON line.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium, test, type Browser, type Page } from '@playwright/test';

import { enterMatch, grindPriority, serverLog } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, PLAY_SERVER_PORT, readJvmRecord, startPlayStack, type PlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const OUT = process.env.BREAKIT_OUT ?? resolve(import.meta.dirname, '.run', 'breakit');
mkdirSync(OUT, { recursive: true });
const PREFIX = '/cardtable';

const say = (test: string, what: string, data: Record<string, unknown> = {}): void => {
  if (Array.isArray(data.drawn)) data = { ...data, drawn: (data.drawn as { text: string }[]).filter((d) => !NOISE.test(d.text)) };
  console.log(`[breakit] ${JSON.stringify({ test, what, at: new Date().toISOString(), ...data })}`);
};

/** Every alert/dialog/error text a screen draws, with when (ms since epoch). */
async function recordDrawn(f: Friend, seen: { who: string; t: number; text: string }[]): Promise<void> {
  await f.context.exposeBinding('__breakitDrawn', (_src, text: string) => {
    seen.push({ who: f.name, t: Date.now(), text });
  });
  await f.context.addInitScript(() => {
    const said = new WeakMap<Element, string>();
    const look = (): void => {
      for (const el of Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], [role="alertdialog"], .ct-error, [data-testid*="error"], [data-testid*="banner"]'))) {
        const text = (el.textContent ?? '').trim().slice(0, 300);
        if (text === '' || said.get(el) === text) continue;
        said.set(el, text);
        (window as unknown as { __breakitDrawn: (t: string) => void }).__breakitDrawn(text);
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  });
  f.page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') seen.push({ who: `${f.name}:console.${m.type()}`, t: Date.now(), text: m.text().slice(0, 300) });
  });
}

/** Java processes standing in the stack's work dir (cwd under it), and every run dir's state. */
function leftBehind(stack: PlayStack): Record<string, unknown> {
  const jvms: { pid: number; cwd: string; state: string }[] = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const cwd = readlinkSync(`/proc/${p}/cwd`);
      if (!cwd.startsWith(stack.workDir)) continue;
      const state = /State:\s+(\S+)/.exec(readFileSync(`/proc/${p}/status`, 'utf8'))?.[1] ?? '?';
      jvms.push({ pid: Number(p), cwd: cwd.slice(stack.workDir.length), state });
    } catch {
      // not ours or already gone: /proc races are expected while scanning
    }
  }
  const dirs = existsSync(stack.workDir)
    ? readdirSync(stack.workDir).map((d) => {
        const run = join(stack.workDir, d);
        const rec = readJvmRecord(run);
        return { dir: d, files: readdirSync(run).sort().join(','), pid: rec?.pid ?? null, spare: rec?.spare ?? null, orphanedAt: rec?.orphanedAt ?? null };
      })
    : [];
  return { jvms, dirs };
}

function matchPid(stack: PlayStack, matchId: string): number {
  // A match adopts the warm spare, so its run dir keeps the spare's name: find it by record.
  const rec = readdirSync(stack.workDir)
    .map((d) => readJvmRecord(join(stack.workDir, d)))
    .find((r) => r?.matchId === matchId) ?? null;
  if (rec === null) throw new Error(`no jvm.json for ${matchId}: ${JSON.stringify(leftBehind(stack))}`);
  return rec.pid;
}

function serverPid(): number {
  const out = execFileSync('ss', ['-ltnpH', `sport = :${PLAY_SERVER_PORT}`], { encoding: 'utf8' });
  const pid = /pid=(\d+)/.exec(out)?.[1];
  if (pid === undefined) throw new Error(`no listener on ${PLAY_SERVER_PORT}: ${out}`);
  return Number(pid);
}

/** A process and every descendant, from /proc's ppid fields. */
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
      parent.set(Number(p), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      // gone mid-scan
    }
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const [pid, pp] of parent) if (pp === out[i]) out.push(pid);
  return out;
}

function rssMb(pid: number): number {
  try {
    return Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? '0') / 1024);
  } catch {
    return -1;
  }
}

/** Server log lines from index `from` on, as compact strings with the evt first. */
function logSince(stack: PlayStack, from: number): string[] {
  return serverLog(stack)
    .slice(from)
    .map((r) => JSON.stringify(r).slice(0, 400));
}

/** Watch the log and the screens for `ms`; return the first time each source said something new. */
async function observe(
  stack: PlayStack,
  logFrom: number,
  drawnFrom: number,
  drawn: { who: string; t: number; text: string }[],
  t0: number,
  ms: number,
  stopWhen?: () => boolean,
): Promise<{ firstLog: Record<string, number>; firstDrawn: Record<string, number> }> {
  const firstLog: Record<string, number> = {};
  const firstDrawn: Record<string, number> = {};
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const l of logSince(stack, logFrom)) {
      const evt = /"evt":"([^"]+)"/.exec(l)?.[1] ?? l.slice(0, 40);
      if (firstLog[evt] === undefined) firstLog[evt] = Date.now() - t0;
    }
    for (const d of drawn.slice(drawnFrom)) {
      if (firstDrawn[d.who] === undefined && !NOISE.test(d.text)) firstDrawn[d.who] = d.t - t0;
    }
    if (stopWhen?.() === true) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { firstLog, firstDrawn };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) }).catch((e: unknown) => say('shot', 'failed', { name, error: String(e) }));
}

/** Press OK/answer prompts on these pages for up to `ms`, so frames flow; a timeout is the expected end. */
async function drive(pages: Page[], ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const page of pages) {
      // The coin toss and the mulligan, which grindPriority's prompt answers do not cover.
      for (const name of ['Play', 'Keep Hand', 'Keep']) {
        const b = page.getByRole('button', { name, exact: true });
        if ((await b.count()) > 0 && (await b.first().isEnabled().catch(() => false))) await b.first().click({ timeout: 1_000 }).catch(() => undefined);
      }
    }
    await grindPriority(pages, async () => false, { timeoutMs: Math.min(5_000, Math.max(1, end - Date.now())) }).catch(() => undefined);
  }
}

/** Frames this screen's socket received that match `re`, and when the first one did. */
function framesIn(f: Friend, re: RegExp): { n: number; first: number | null } {
  const hits = f.captures.filter((c) => c.dir === 'in' && re.test(c.text));
  return { n: hits.length, first: hits[0]?.t ?? null };
}

const NOISE = /watchparty|Connection error|Failed to load resource/;

async function setUp(browser: Browser, test: string): Promise<{ stack: PlayStack; alice: Friend; bob: Friend; drawn: { who: string; t: number; text: string }[]; matchId: string }> {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  const drawn: { who: string; t: number; text: string }[] = [];
  await recordDrawn(alice, drawn);
  await recordDrawn(bob, drawn);
  const { matchId } = await enterMatch(alice, bob, stack.origin);
  say(test, 'match running', { matchId, workDir: stack.workDir, ...leftBehind(stack) });
  return { stack, alice, bob, drawn, matchId };
}

test.describe.configure({ mode: 'serial' });
test.skip(!forge.ok, forge.ok ? '' : forge.reason);

test('C1 kill -9 the match JVM mid-match', async ({ browser }) => {
  const { stack, alice, bob, drawn, matchId } = await setUp(browser, 'C1');
  try {
    await drive([alice.page, bob.page], 15_000);
    const pid = matchPid(stack, matchId);
    const logFrom = serverLog(stack).length;
    const drawnFrom = drawn.length;
    const t0 = Date.now();
    process.kill(pid, 'SIGKILL');
    say('C1', 'SIGKILL sent', { pid });
    const seen = await observe(stack, logFrom, drawnFrom, drawn, t0, 30_000);
    await shot(alice.page, 'c1-alice');
    await shot(bob.page, 'c1-bob');
    const status = await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/play/matches/${matchId}`)).json();
    // Try to keep playing: does pressing anything on the dead board hang or tell the player?
    await drive([alice.page], 5_000);
    say('C1', 'result', { ...seen, errorFrame: { alice: framesIn(alice, /showErrorDialog/), bob: framesIn(bob, /showErrorDialog/), t0 }, status, drawn: drawn.slice(drawnFrom), log: logSince(stack, logFrom), ...leftBehind(stack) });
  } finally {
    await stack.stop();
    say('C1', 'after stop', leftBehind(stack));
  }
});

test('C2 SIGSTOP the match JVM (a hang)', async ({ browser }) => {
  const { stack, alice, bob, drawn, matchId } = await setUp(browser, 'C2');
  let pid = 0;
  try {
    await drive([alice.page, bob.page], 10_000);
    pid = matchPid(stack, matchId);
    const logFrom = serverLog(stack).length;
    const drawnFrom = drawn.length;
    const t0 = Date.now();
    process.kill(pid, 'SIGSTOP');
    say('C2', 'SIGSTOP sent', { pid });
    // Players keep pressing, as a player would.
    await drive([alice.page, bob.page], 20_000);
    const seen = await observe(stack, logFrom, drawnFrom, drawn, t0, 160_000);
    await shot(alice.page, 'c2-alice-stopped');
    await shot(bob.page, 'c2-bob-stopped');
    const status = await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/play/matches/${matchId}`)).json();
    say('C2', 'while stopped', { ...seen, status, drawn: drawn.slice(drawnFrom), log: logSince(stack, logFrom), ...leftBehind(stack) });
    const contFrom = serverLog(stack).length;
    const t1 = Date.now();
    process.kill(pid, 'SIGCONT');
    const turnBefore = await alice.page.getByTestId('live-turn-n').textContent();
    await drive([alice.page, bob.page], 20_000);
    const turnAfter = await alice.page.getByTestId('live-turn-n').textContent();
    await shot(alice.page, 'c2-alice-continued');
    say('C2', 'after SIGCONT', { ms: Date.now() - t1, turnBefore, turnAfter, log: logSince(stack, contFrom), ...leftBehind(stack) });
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        // already gone
      }
    }
    await stack.stop();
    say('C2', 'after stop', leftBehind(stack));
  }
});

test('C3a graceful restart of the Node server mid-match', async ({ browser }) => {
  const { stack, alice, bob, drawn, matchId } = await setUp(browser, 'C3a');
  try {
    await drive([alice.page, bob.page], 10_000);
    const pidBefore = matchPid(stack, matchId);
    const logFrom = serverLog(stack).length;
    const drawnFrom = drawn.length;
    const t0 = Date.now();
    await stack.restart();
    const restartMs = Date.now() - t0;
    const seen = await observe(stack, logFrom, drawnFrom, drawn, t0, 8_000);
    await shot(alice.page, 'c3a-alice-8s');
    await shot(bob.page, 'c3a-bob-8s');
    const says0 = { alice: await alice.page.getByTestId('live-says').textContent().catch(() => null), bob: await bob.page.getByTestId('live-says').textContent().catch(() => null) };
    const turnBefore = await alice.page.getByTestId('live-turn-n').textContent({ timeout: 2_000 }).catch(() => null);
    await drive([alice.page, bob.page], 30_000);
    const turnAfter = await alice.page.getByTestId('live-turn-n').textContent({ timeout: 2_000 }).catch(() => null);
    await shot(alice.page, 'c3a-alice-after-drive');
    await shot(bob.page, 'c3a-bob-after-drive');
    say('C3a', 'result', { pidBefore, pidAfter: matchPid(stack, matchId), restartMs, says0, turnBefore, turnAfter, ...seen, drawn: drawn.slice(drawnFrom), log: logSince(stack, logFrom), ...leftBehind(stack) });
  } finally {
    await stack.stop();
    say('C3a', 'after stop', leftBehind(stack));
  }
});

test('C3b kill -9 the Node server mid-match, then start a new one', async ({ browser }) => {
  const { stack, alice, bob, drawn, matchId } = await setUp(browser, 'C3b');
  try {
    await drive([alice.page, bob.page], 10_000);
    const jvm = matchPid(stack, matchId);
    const node = serverPid();
    const logFrom = serverLog(stack).length;
    const drawnFrom = drawn.length;
    const t0 = Date.now();
    process.kill(node, 'SIGKILL');
    say('C3b', 'SIGKILL node', { node, jvm });
    const down = await observe(stack, logFrom, drawnFrom, drawn, t0, 15_000);
    await shot(alice.page, 'c3b-alice-down');
    say('C3b', 'server down 15 s', { ...down, drawn: drawn.slice(drawnFrom), ...leftBehind(stack) });
    const t1 = Date.now();
    await stack.restart();
    const seen = await observe(stack, logFrom, drawnFrom, drawn, t1, 30_000);
    const back = await alice.page.getByTestId('live-turn-n').isVisible();
    await drive([alice.page, bob.page], 10_000);
    await shot(alice.page, 'c3b-alice-after');
    await shot(bob.page, 'c3b-bob-after');
    const status = await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/play/matches/${matchId}`)).json();
    say('C3b', 'after new server', { restartMs: Date.now() - t1, back, status, ...seen, drawn: drawn.slice(drawnFrom), log: logSince(stack, logFrom), ...leftBehind(stack) });
  } finally {
    await stack.stop();
    say('C3b', 'after stop', leftBehind(stack));
  }
});

test('C4 a browser that stops reading (frozen process)', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  // bob gets his own browser process, so freezing it leaves alice's alone.
  const server = await chromium.launchServer({ headless: true });
  const bobBrowser = await chromium.connect(server.wsEndpoint());
  const browserPid = server.process().pid ?? 0;
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(bobBrowser, 'bob');
    const drawn: { who: string; t: number; text: string }[] = [];
    await recordDrawn(alice, drawn);
    await recordDrawn(bob, drawn);
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await drive([alice.page, bob.page], 10_000);
    const tree = descendants(browserPid);
    const node = serverPid();
    const logFrom = serverLog(stack).length;
    const drawnFrom = drawn.length;
    const t0 = Date.now();
    for (const p of tree) process.kill(p, 'SIGSTOP');
    say('C4', 'bob browser frozen', { matchId, tree, node, rss0: rssMb(node) });
    const rss: number[] = [];
    const turns: string[] = [];
    const end = Date.now() + 150_000;
    while (Date.now() < end) {
      await drive([alice.page], 5_000);
      rss.push(rssMb(node));
      turns.push((await alice.page.getByTestId('live-turn-n').textContent()) ?? '');
    }
    const seen = await observe(stack, logFrom, drawnFrom, drawn, t0, 1_000);
    await shot(alice.page, 'c4-alice-while-bob-frozen');
    say('C4', 'while frozen', { rss, turns, ...seen, drawn: drawn.slice(drawnFrom), log: logSince(stack, logFrom) });
    const contFrom = serverLog(stack).length;
    const t1 = Date.now();
    for (const p of tree) process.kill(p, 'SIGCONT');
    await drive([alice.page, bob.page], 30_000);
    await shot(bob.page, 'c4-bob-thawed');
    const status = await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/play/matches/${matchId}`)).json();
    say('C4', 'after thaw', { ms: Date.now() - t1, status, bobTurn: await bob.page.getByTestId('live-turn-n').textContent().catch(() => null), drawn: drawn.slice(drawnFrom), log: logSince(stack, contFrom), ...leftBehind(stack) });
  } finally {
    await bobBrowser.close().catch(() => undefined);
    await server.close();
    await stack.stop();
    say('C4', 'after stop', leftBehind(stack));
  }
});

test('C6 the work dir fills up mid-match', async ({ browser }) => {
  // Run inside `unshare -rm` with a small tmpfs mounted at e2e/.run/play-work (see the plan's results note).
  const { stack, alice, bob, drawn, matchId } = await setUp(browser, 'C6');
  try {
    await drive([alice.page, bob.page], 10_000);
    const df0 = execFileSync('df', ['-k', stack.workDir], { encoding: 'utf8' });
    const filler = join(stack.workDir, '..', 'breakit-filler');
    const fd = openSync(filler, 'w');
    const chunk = Buffer.alloc(64 * 1024);
    let written = 0;
    try {
      for (;;) written += writeSync(fd, chunk);
    } catch (e) {
      say('C6', 'disk full', { written, error: String(e) });
    } finally {
      closeSync(fd);
    }
    const node = serverPid();
    const logFrom = serverLog(stack).length;
    const drawnFrom = drawn.length;
    const t0 = Date.now();
    await drive([alice.page, bob.page], 60_000);
    const seen = await observe(stack, logFrom, drawnFrom, drawn, t0, 10_000);
    await shot(alice.page, 'c6-alice');
    const status = await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/play/matches/${matchId}`)).json();
    const health = (await alice.context.request.get(`${stack.origin}${PREFIX}/health`)).status();
    say('C6', 'result', { df0, nodeAlive: rssMb(node) > 0, health, status, ...seen, drawn: drawn.slice(drawnFrom), log: logSince(stack, logFrom), ...leftBehind(stack) });
    // A second match on the full disk: does it fail loudly?
    const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, { data: { opponent: 'ai', decks: [null, null], names: ['Alice', 'AI'] }, timeout: 90_000 });
    say('C6', 'new match on a full disk', { status: res.status(), body: (await res.text()).slice(0, 400), log: logSince(stack, logFrom).slice(-10) });
  } finally {
    await stack.stop();
    say('C6', 'after stop', leftBehind(stack));
  }
});

const AI_MATCH = { opponent: 'ai', decks: [null, null], names: ['Alice', 'AI'] };

/** JVMs by kind: the pool's, spares (record says spare), matches, and anything with no record (an orphan). */
function jvmCensus(stack: PlayStack): Record<string, number> {
  const lb = leftBehind(stack) as { jvms: { pid: number; cwd: string }[]; dirs: { dir: string; pid: number | null; spare: boolean | null }[] };
  const byPid = new Map(lb.dirs.filter((d) => d.pid !== null).map((d) => [d.pid, d]));
  const census: Record<string, number> = { pool: 0, spare: 0, match: 0, unrecorded: 0, total: lb.jvms.length, rssMb: 0, poolRssMb: 0 };
  for (const j of lb.jvms) {
    const kind = j.cwd === '/pool' ? 'pool' : byPid.get(j.pid)?.spare === true ? 'spare' : byPid.has(j.pid) ? 'match' : 'unrecorded';
    census[kind]! += 1;
    const rss = rssMb(j.pid);
    census.rssMb! += rss;
    if (kind === 'pool') census.poolRssMb = rss;
  }
  return census;
}

test('C5 start matches up to MAX_CONCURRENT_MATCHES and past it', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  const ids: string[] = [];
  try {
    for (let i = 1; i <= 11; i++) {
      const t0 = Date.now();
      const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, { data: AI_MATCH, timeout: 120_000 });
      const body = await res.text();
      if (res.status() === 201) ids.push((JSON.parse(body) as { matchId: string }).matchId);
      // Let the replacement spare come up (or not) before the census.
      await new Promise((r) => setTimeout(r, 6_000));
      say('C5', 'start', { i, status: res.status(), ms: Date.now() - t0, body: body.slice(0, 200), census: jvmCensus(stack) });
    }
    // What a player sees when refused: the room's own start path, in a browser.
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await shot(alice.page, 'c5-lobby-full');
    // Free one slot by killing a match JVM: does the spare come back, and does the 11th start now?
    const logFrom = serverLog(stack).length;
    process.kill(matchPid(stack, ids[0]!), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 15_000));
    const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, { data: AI_MATCH, timeout: 120_000 });
    await new Promise((r) => setTimeout(r, 10_000));
    say('C5', 'after freeing one', { status: res.status(), body: (await res.text()).slice(0, 200), census: jvmCensus(stack), log: logSince(stack, logFrom).filter((l) => /spare|jvm|match-/.test(l)) });
  } finally {
    await stack.stop();
    say('C5', 'after stop', { census: jvmCensus(stack) });
  }
});

test('C7 twenty match starts in one second', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  const peak: Record<string, number> = { spare: 0, total: 0, match: 0, unrecorded: 0 };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const c = jvmCensus(stack);
      for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k]!, c[k] ?? 0);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  try {
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i * 50));
        const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, { data: AI_MATCH, timeout: 180_000 });
        return { i, status: res.status(), ms: Date.now() - t0, body: (await res.text()).slice(0, 160) };
      }),
    );
    await new Promise((r) => setTimeout(r, 15_000));
    const counts: Record<number, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    say('C7', 'burst', { counts, results, census: jvmCensus(stack), peak, log: serverLog(stack).map((r) => JSON.stringify(r)).filter((l) => /spare|jvm-|match-failed|pool-/.test(l)).slice(-40) });
  } finally {
    sampling = false;
    await sampler;
    await stack.stop();
    say('C7', 'after stop', { census: jvmCensus(stack), peak });
  }
});

/** Forge's own showConfirmDialog to alice through the bridge's loopback client, answered on her screen: does the round trip work? */
async function probeRoundTrip(stack: PlayStack, alice: Friend, matchId: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const req = alice.context.request
    .post(`${stack.origin}${PREFIX}/api/play/matches/${matchId}/probe`, { data: { seat: 0, message: 'breakit probe' }, timeout: 25_000 })
    .then(async (r) => ({ status: r.status(), body: (await r.text()).slice(0, 200) }))
    .catch((e: unknown) => ({ status: 0, body: String(e).split('\n')[0] }));
  const dialog = alice.page.getByTestId('confirm-dialog');
  const drawn = await dialog.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
  if (drawn) await dialog.locator('[data-answer]').first().click({ timeout: 5_000 }).catch(() => undefined);
  const res = await req;
  return { drawn, ...res, ms: Date.now() - t0 };
}

test('C2b a JVM pause of BREAKIT_STOP_S seconds, then resume: does the match go on?', async ({ browser }) => {
  const stopS = Number(process.env.BREAKIT_STOP_S ?? '30');
  const { stack, alice, bob, matchId } = await setUp(browser, 'C2b');
  let pid = 0;
  try {
    await drive([alice.page, bob.page], 5_000);
    pid = matchPid(stack, matchId);
    const before = await probeRoundTrip(stack, alice, matchId);
    process.kill(pid, 'SIGSTOP');
    await new Promise((r) => setTimeout(r, stopS * 1000));
    process.kill(pid, 'SIGCONT');
    await new Promise((r) => setTimeout(r, 2_000));
    const after = await probeRoundTrip(stack, alice, matchId);
    const run = readdirSync(stack.workDir).map((d) => join(stack.workDir, d)).find((d) => readJvmRecord(d)?.matchId === matchId);
    const heartbeatTimeoutLogged = run === undefined ? null : /timed out after \d+ seconds/.test(readFileSync(join(run, 'bridge.stderr.txt'), 'utf8'));
    say('C2b', 'result', { stopS, before, after, heartbeatTimeoutLogged });
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        // already gone
      }
    }
    await stack.stop();
  }
});
