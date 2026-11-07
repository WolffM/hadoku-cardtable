/**
 * The promo film rig: one seat filmed at 1920×1080, 60 fps, with card art and the game's sound.
 *
 * The HERO seat runs headless Chromium rendering on the GPU (ANGLE over Vulkan), and the clip is taken
 * from its compositor over CDP (`Page.startScreencast`), not by grabbing a display. Cut 3 grabbed a headed
 * Chromium on Xvfb, which can only rasterise in software: ~45 fps on an idle box, 6–12 real frames a second
 * under load (the operator saw it as lag). Xvfb has no GPU present path, so a GPU Chromium there paints
 * almost nothing to the window; headless has no window to paint, and tab capture is not supported headless.
 *
 * Frames arrive as JPEGs at `capture.mjs`, a process of its own (so a busy test never delays a frame's
 * ack), which keeps each with its arrival time. At `stop` ffmpeg lays them out with exactly those
 * durations (`frame-list.ts`) and converts to 60 fps CFR. The screencast delivers about 95% of the compositor's frames
 * however it is tuned (JPEG quality, acking off-process), so a missed frame is blended from its two
 * neighbours instead of repeating the last one. The sound comes from the null sink, and the encode runs
 * on NVENC, so nothing competes for the CPU. The other seat runs headless in software; nobody sees it.
 *
 * The e2e `openFriend` blocks every request that leaves 127.0.0.1 (a test must not depend on the network).
 * A promo clip wants the art, which resolves to the CDN or Scryfall (`packages/carddata/src/art/index.ts`),
 * so `openPromoFriend` lets image requests out and still blocks everything else.
 *
 * Fast Mode is OFF: the animations are the point. Clips land in `e2e/.run/promo/<clip>/` as `<clip>.mkv`
 * and `<clip>.marks.json` (the moments the driver named, in seconds from the first frame, which is what the
 * edit cuts on), with the evidence for every dropped frame: `<clip>.frames.json` (when each captured frame
 * arrived), `<clip>.raf.json` (the page's own late frames) and `<clip>.loaf.json` (its long animation
 * frames, with the scripts behind them). Never committed: `.run/` is ignored, and video bytes stay out of
 * the repo.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from '@playwright/test';

import { FRIENDS, SESSION_COOKIE } from '../identities.ts';
import { dress } from '../looks.ts';
import type { Friend } from '../play/browser.ts';
import { PLAY_EDGE_ORIGIN, RUN_DIR } from '../play/harness.ts';
import { registerFriendContext } from '../play/open-friends.ts';
import { keepPrefsLocal, setPlayFastModeDefault } from '../prefsLocal.ts';
import { FILM_FILTER, FPS, frameList } from './frame-list.ts';
import { seedMouse } from './mouse.ts';

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const PROMO_DIR = resolve(RUN_DIR, 'promo');

/** The hero's GPU path: ANGLE on Vulkan, raster on the GPU, Chromium's own 60 Hz frame clock left alone. */
const GPU_ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];

/** The gamer tags on screen (`identities.ts`'s promo rows): never a real friend's name in a public video. */
export const HERO = 'ashgrove';
export const RIVAL = 'nightjar';
export const TAGS: Record<string, string> = { ashgrove: 'Ashgrove', nightjar: 'Nightjar', vexmoor: 'Vexmoor', lumen: 'Lumen' };
/** Each tag's watchparty sprite: the hero is Fern (`mage`) and the rival Himmel (`herald`), as the operator asked. */
export const AVATARS: Record<string, string> = { ashgrove: 'mage', nightjar: 'herald', vexmoor: 'sage', lumen: 'knight' };

/** The commit this tree was on when the take was filmed (the manifest's build), `+dirty` if anything outside `.run/` differed. */
const BUILD = ((): string => {
  const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() === '' ? sha : `${sha}+dirty`;
})();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Film {
  hero: Browser;
  /** Name a moment, in seconds since the capture's first frame. */
  mark(label: string): void;
  /** A held beat, so a viewer can follow what is about to happen. */
  beat(ms?: number): Promise<void>;
  /** Stop the capture and write the marks; idempotent. */
  stop(): Promise<string>;
}

/**
 * Launch the hero's GPU Chromium and (once `roll()` is called) start filming its page. The capture starts at
 * `roll`, not here, so the clip does not open on a blank tab and a mulligan. The filmed page is the hero
 * browser's newest page at `roll`.
 */
export async function startFilm(clip: string): Promise<Film & { roll(): Promise<void> }> {
  const dir = resolve(PROMO_DIR, clip);
  mkdirSync(dir, { recursive: true });
  seedMouse(clip);
  // A private null sink: the game's sound goes into the clip, never to the operator's speakers.
  const sink = `promo_${clip}_${process.pid}`;
  const sinkModule = execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, `sink_properties=device.description=${sink}`], { encoding: 'utf8' }).trim();
  const port = await freePort();
  const hero = await chromium.launch({
    headless: true,
    // Playwright mutes a headless browser; the clip wants the game's sound, on the null sink above.
    ignoreDefaultArgs: ['--mute-audio'],
    env: { ...process.env, PULSE_SINK: sink },
    // The DevTools port is for `capture.mjs`, which films from its own process.
    args: [...GPU_ARGS, `--remote-debugging-port=${port}`, `--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
  });

  let audio: ChildProcess | null = null;
  let keepAlive: ChildProcess | null = null;
  let audioAt = 0;
  let catcher: ChildProcess | null = null;
  let t0 = 0;
  const marks: { label: string; t: number }[] = [];
  let arrivals: number[] = [];
  const frames = resolve(dir, 'frames');
  const out = resolve(dir, `${clip}.mkv`);
  let stopped: Promise<string> | null = null;

  return {
    hero,
    async roll() {
      const page = hero.contexts().flatMap((c) => c.pages()).at(-1);
      if (page === undefined) throw new Error('promo rig: the hero has no page to film');
      rmSync(frames, { recursive: true, force: true });
      mkdirSync(frames, { recursive: true });
      // An idle PulseAudio sink suspends and its monitor sends nothing, so the sound came out shorter than
      // the picture and slid out of sync across silences. A silent stream keeps the sink running, and the
      // recording is stamped by the wall clock, its gaps filled with silence.
      keepAlive = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'pulse', sink], { stdio: ['pipe', 'ignore', 'inherit'] });
      audio = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-use_wallclock_as_timestamps', '1', '-f', 'pulse', '-i', `${sink}.monitor`, '-af', 'aresample=async=1:first_pts=0', '-c:a', 'flac', resolve(dir, 'audio.flac')], { stdio: ['pipe', 'ignore', 'inherit'] });
      audioAt = Date.now();
      // Each frame is written with the time it arrived; `stop` assembles them with exactly those durations.
      // (Piping them into ffmpeg stamped them as it read them, in bursts, and lost nine in ten.)
      catcher = spawn(process.execPath, [resolve(import.meta.dirname, 'capture.mjs'), String(port), frames], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise<void>((ok, fail) => {
        catcher!.stdout!.on('data', (chunk: Buffer) => (chunk.toString().includes('capture: filming') ? ok() : undefined));
        catcher!.once('exit', (code) => fail(new Error(`promo rig: capture.mjs exited ${String(code)} before filming`)));
      });
      t0 = Date.now();
      await sleep(300);
    },
    mark(label) {
      const t = t0 === 0 ? 0 : (Date.now() - t0) / 1000;
      marks.push({ label, t });
      console.log(`[promo:${clip}] ${t.toFixed(2)}s ${label}`);
    },
    beat: (ms = 700) => sleep(ms),
    stop() {
      stopped ??= (async () => {
        const end = Date.now();
        if (catcher !== null && catcher.exitCode === null) {
          const done = new Promise<void>((r) => catcher!.once('exit', () => r()));
          catcher.kill('SIGTERM');
          await Promise.race([done, sleep(20_000)]);
          if (catcher.exitCode === null) console.warn(`[promo:${clip}] capture.mjs ${catcher.pid} did not finish writing`);
        }
        try {
          arrivals = JSON.parse(readFileSync(resolve(frames, 'arrivals.json'), 'utf8')) as number[];
        } catch (err) {
          console.warn(`[promo:${clip}] no arrivals from capture.mjs: ${String(err)}`);
        }
        await stopProcess(clip, audio);
        await stopProcess(clip, keepAlive);
        const filmed = hero.contexts().flatMap((c) => c.pages()).at(-1);
        const loaf = ((await filmed?.evaluate(() => (window as unknown as { __promoLoaf?: { at: number }[] }).__promoLoaf ?? []).catch(() => [])) ?? []).map((e) => ({ ...e, at: Math.round(e.at - t0) / 1000 }));
        writeFileSync(resolve(dir, `${clip}.loaf.json`), JSON.stringify(loaf, null, 1));
        const raf = ((await filmed?.evaluate(() => (window as unknown as { __promoRaf?: number[][] }).__promoRaf ?? []).catch(() => [])) ?? []).map(([at, ms]) => [Math.round(at! - t0) / 1000, ms]);
        writeFileSync(resolve(dir, `${clip}.raf.json`), JSON.stringify(raf));
        await hero.close().catch((err: unknown) => console.warn(`[promo:${clip}] hero browser close: ${String(err)}`));
        execFileSync('pactl', ['unload-module', sinkModule]);
        writeFileSync(resolve(dir, `${clip}.marks.json`), JSON.stringify({ clip, fps: FPS, build: BUILD, marks }, null, 2));
        if (arrivals.length === 0) return out;
        const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
        const late = gaps.filter((g) => g > (1000 / FPS) * 1.5).length;
        console.log(`[promo:${clip}] captured ${arrivals.length} frames over ${((end - t0) / 1000).toFixed(1)} s, ${late} gaps over 25 ms, longest ${Math.max(0, ...gaps)} ms`);
        writeFileSync(resolve(dir, `${clip}.frames.json`), JSON.stringify({ arrivals: arrivals.map((t) => t - t0) }));
        writeFileSync(resolve(frames, 'list.txt'), frameList(arrivals, t0, end));
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
          '-f', 'concat', '-safe', '0', '-i', resolve(frames, 'list.txt'),
          '-ss', ((t0 - audioAt) / 1000).toFixed(3), '-i', resolve(dir, 'audio.flac'),
          '-vf', FILM_FILTER, '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'constqp', '-qp', '14',
          '-t', ((end - t0) / 1000).toFixed(3), '-c:a', 'flac', out]);
        rmSync(frames, { recursive: true, force: true });
        rmSync(resolve(dir, 'audio.flac'), { force: true });
        return out;
      })();
      return stopped;
    },
  };
}

/** A free TCP port on 127.0.0.1, for the hero's DevTools endpoint. */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr !== null ? ok(addr.port) : fail(new Error('no port'))));
    });
  });
}

/** Stop an ffmpeg that records an endless input: `q`, then SIGINT, then SIGKILL, saying so if it came to that. */
async function stopProcess(clip: string, proc: ChildProcess | null): Promise<void> {
  if (proc === null || proc.exitCode !== null) return;
  const done = new Promise<void>((r) => proc.once('exit', () => r()));
  proc.stdin?.write('q');
  await Promise.race([done, sleep(3_000)]);
  if (proc.exitCode === null) proc.kill('SIGINT');
  await Promise.race([done, sleep(5_000)]);
  if (proc.exitCode === null) {
    console.warn(`[promo:${clip}] ffmpeg ${proc.pid} would not stop; killing it`);
    proc.kill('SIGKILL');
  }
}

interface LoafEntry {
  startTime: number;
  duration: number;
  blockingDuration: number;
  styleAndLayoutStart: number;
  scripts: { sourceURL: string; sourceFunctionName: string; sourceCharPosition: number; invoker: string; duration: number; forcedStyleAndLayoutDuration: number }[];
}

const IMAGE = /\.(jpe?g|png|webp|avif|svg)(\?|$)/i;

/**
 * A friend for a promo clip, on `browser`: the filmed hero's GPU browser, or the shared headless one. Same identity cookie and local prefs as `openFriend`, Fast Mode off, art let through.
 * `options` overrides the context's own: a phone's shape and touch, a recording.
 */
export async function openPromoFriend(browser: Browser, name: string, options: BrowserContextOptions = {}): Promise<Friend> {
  const context: BrowserContext = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'dark', ...options });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, PLAY_EDGE_ORIGIN);
  await setPlayFastModeDefault(context, false);
  // No match music in the clips: the trailer lays one bed under all of them (`mute.ts`'s level key).
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cardtable.sound.music', '0');
    } catch (err) {
      console.warn(`[promo] could not set the local prefs: ${String(err)}`);
    }
  });
  // And the friend's avatar, dressed in prefs-api's stand-in the way their own account
  // answers `room/avatar.ts`'s `accountAvatarId` GET (wave 92 D).
  const identity = FRIENDS[name];
  const userId = identity?.userId ?? null;
  const sprite = AVATARS[name];
  if (sprite !== undefined && identity !== undefined) await dress(context.request, PLAY_EDGE_ORIGIN, identity.key, { source: 'sprite', sprite, name });
  // Every long animation frame (50 ms or more), with the scripts behind it: where a clip's dropped frames
  // come from when it is the game, not the capture (`<clip>.loaf.json`, written by the film's `stop`).
  await context.addInitScript(() => {
    const w = window as unknown as { __promoLoaf: unknown[]; __promoRaf: number[][] };
    w.__promoLoaf = [];
    // The page's own frame clock: every requestAnimationFrame interval over 25 ms, so a drop in a clip can
    // be put on the game (it painted late) or on the capture (it painted on time and the frame was lost).
    w.__promoRaf = [];
    let last = 0;
    const tick = (t: number): void => {
      if (last > 0 && t - last > 25) w.__promoRaf.push([performance.timeOrigin + last, Math.round(t - last)]);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as LoafEntry[]) {
          w.__promoLoaf.push({
            at: performance.timeOrigin + e.startTime,
            ms: Math.round(e.duration),
            blockingMs: Math.round(e.blockingDuration),
            styleLayoutMs: e.styleAndLayoutStart > 0 ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
            scripts: e.scripts.map((x) => ({ src: x.sourceURL.split('/').pop(), fn: x.sourceFunctionName, at: x.sourceCharPosition, invoker: x.invoker, ms: Math.round(x.duration), forcedMs: Math.round(x.forcedStyleAndLayoutDuration) })),
          });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch (err) {
      console.warn(`[promo] no long-animation-frame observer: ${String(err)}`);
    }
  });
  const page = await context.newPage();
  registerFriendContext(context);
  // A card drawn as a blank ◆ is art that never arrived: say which.
  page.on('requestfailed', (req) => {
    if (req.resourceType() === 'image') console.warn(`[promo] art failed: ${req.url()} (${req.failure()?.errorText ?? '?'})`);
  });
  page.on('response', (res) => {
    if (res.request().resourceType() === 'image' && res.status() >= 400) console.warn(`[promo] art ${res.status()}: ${res.url()}`);
  });
  const friend: Friend = { name, context, page, captures: [], pending: [], captureErrors: [], blocked: [], trace: { since: Date.now(), inFlight: new Map(), events: [] } };
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    // The e2e edge serves no watchparty sprites, so portraits fell back to initials (w79d, item 12):
    // the same sprite from production, which serves it publicly.
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/watchparty/media/sprites/')) {
      // Without the page's 127.0.0.1 Referer: production refuses a hotlink from another origin (403).
      const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'referer' && k !== 'origin'));
      return route.fulfill({ response: await route.fetch({ url: `https://hadoku.me${url.pathname}`, headers }) });
    }
    // The e2e edge serves no `/session/whoami` either, and without it the room never asserts the avatar.
    if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/session/whoami') && userId !== null) {
      return route.fulfill({ json: { valid: true, userId, userType: 'friend', name: TAGS[name] ?? name } });
    }
    if (url.hostname === '127.0.0.1' || req.resourceType() === 'image' || req.resourceType() === 'font' || IMAGE.test(url.pathname)) return route.continue();
    friend.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });
  return friend;
}
