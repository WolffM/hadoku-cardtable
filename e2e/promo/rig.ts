/**
 * The promo film rig: one seat filmed at 1920×1080, 60 fps, with card art.
 *
 * Playwright's own `recordVideo` is ~25 fps VP8 at a low bitrate — fine for a test's evidence, not for a
 * trailer. So the HERO seat runs a headed, fullscreen Chromium on a private Xvfb display (never the operator's screen), and ffmpeg's
 * `x11grab` films that display losslessly enough to cut from. The other seat runs headless; nobody sees it.
 *
 * The e2e `openFriend` blocks every request that leaves 127.0.0.1 (a test must not depend on the network).
 * A promo clip wants the art, which resolves to the CDN or Scryfall (`packages/carddata/src/art/index.ts`),
 * so `openPromoFriend` lets image requests out and still blocks everything else.
 *
 * Fast Mode is OFF: the animations are the point. Clips land in `e2e/.run/promo/<clip>/` as
 * `<clip>.mkv` plus `<clip>.marks.json` — the moments the driver named, in seconds from the first frame,
 * which is what the edit cuts on. Never committed: `.run/` is ignored, and video bytes stay out of the repo.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser, type BrowserContext } from '@playwright/test';

import { SESSION_COOKIE } from '../identities.ts';
import type { Friend } from '../play/browser.ts';
import { PLAY_EDGE_ORIGIN, RUN_DIR } from '../play/harness.ts';
import { registerFriendContext } from '../play/open-friends.ts';
import { keepPrefsLocal, setPlayFastModeDefault } from '../prefsLocal.ts';

export const WIDTH = 1920;
export const HEIGHT = 1080;
const FPS = Number(process.env.PROMO_FPS ?? '60');
export const PROMO_DIR = resolve(RUN_DIR, 'promo');

/** The gamer tags on screen (`identities.ts`'s promo rows): never a real friend's name in a public video. */
export const HERO = 'ashgrove';
export const RIVAL = 'nightjar';
export const TAGS: Record<string, string> = { ashgrove: 'Ashgrove', nightjar: 'Nightjar', vexmoor: 'Vexmoor', lumen: 'Lumen' };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`promo rig: ${what} never came up`);
    await sleep(100);
  }
}

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
 * Start Xvfb on `:<display>`, a headed Chromium on it, and (once `roll()` is called) ffmpeg filming it.
 * The capture starts at `roll`, not here, so the clip does not open on a white tab and a mulligan.
 */
export async function startFilm(clip: string, display = Number(process.env.PROMO_DISPLAY ?? '97')): Promise<Film & { roll(): Promise<void> }> {
  const dir = resolve(PROMO_DIR, clip);
  mkdirSync(dir, { recursive: true });
  const lock = `/tmp/.X${display}-lock`;
  if (existsSync(lock)) throw new Error(`promo rig: display :${display} is taken (${lock}); set PROMO_DISPLAY`);
  const xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  await waitFor(`Xvfb :${display}`, () => existsSync(lock));
  // A private null sink: the game's sound goes into the clip, never to the operator's speakers.
  const sink = `promo_${display}`;
  const sinkModule = execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, `sink_properties=device.description=${sink}`], { encoding: 'utf8' }).trim();
  const hero = await chromium.launch({
    headless: false,
    // Never the operator's desktop: with WAYLAND_DISPLAY set, Chromium opens on Wayland and ignores DISPLAY.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WAYLAND_DISPLAY')), DISPLAY: `:${display}`, PULSE_SINK: sink },
    args: [
      '--ozone-platform=x11',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--window-position=0,0',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--disable-infobars',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-site-isolation-trials',
      '--disable-features=IsolateOrigins,site-per-process,Translate',
    ],
  });

  let ffmpeg: ChildProcess | null = null;
  let t0 = 0;
  const marks: { label: string; t: number }[] = [];
  const out = resolve(dir, `${clip}.mkv`);
  let stopped: Promise<string> | null = null;

  return {
    hero,
    async roll() {
      ffmpeg = spawn(
        'ffmpeg',
        ['-y', '-loglevel', 'error',
          '-thread_queue_size', '1024', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(FPS), '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `:${display}`,
          '-thread_queue_size', '1024', '-f', 'pulse', '-i', `${sink}.monitor`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'flac', out],
        { stdio: ['pipe', 'ignore', 'inherit'] },
      );
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
        if (ffmpeg !== null) {
          const done = new Promise<void>((r) => ffmpeg!.once('exit', () => r()));
          ffmpeg.stdin?.write('q');
          await Promise.race([done, sleep(15_000)]);
        }
        writeFileSync(resolve(dir, `${clip}.marks.json`), JSON.stringify({ clip, fps: FPS, marks }, null, 2));
        await hero.close().catch((err: unknown) => console.warn(`[promo:${clip}] hero browser close: ${String(err)}`));
        xvfb.kill('SIGTERM');
        execFileSync('pactl', ['unload-module', sinkModule]);
        return out;
      })();
      return stopped;
    },
  };
}

const IMAGE = /\.(jpe?g|png|webp|avif|svg)(\?|$)/i;

/**
 * A friend for a promo clip: the hero on the filmed browser (window-sized, no viewport override), anyone
 * else headless. Same identity cookie and local prefs as `openFriend`, Fast Mode off, art let through.
 */
export async function openPromoFriend(browser: Browser, name: string, opts: { filmed?: boolean } = {}): Promise<Friend> {
  const context: BrowserContext = await browser.newContext(opts.filmed === true ? { viewport: null, colorScheme: 'dark' } : { viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'dark' });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, PLAY_EDGE_ORIGIN);
  await setPlayFastModeDefault(context, false);
  // No match music in the clips: the trailer lays one bed under all of them (`mute.ts`'s level key).
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cardtable.sound.music', '0');
    } catch (err) {
      console.warn(`[promo] could not silence the match music: ${String(err)}`);
    }
  });
  const page = await context.newPage();
  if (opts.filmed === true) {
    // `--kiosk` is not honoured under Playwright; the window's own fullscreen hides the browser's chrome.
    const cdp = await context.newCDPSession(page);
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  }
  registerFriendContext(context);
  // A card drawn as a blank ◆ is art that never arrived: say which.
  page.on('requestfailed', (req) => {
    if (req.resourceType() === 'image') console.warn(`[promo] art failed: ${req.url()} (${req.failure()?.errorText ?? '?'})`);
  });
  page.on('response', (res) => {
    if (res.request().resourceType() === 'image' && res.status() >= 400) console.warn(`[promo] art ${res.status()}: ${res.url()}`);
  });
  const friend: Friend = { name, context, page, captures: [], pending: [], captureErrors: [], blocked: [] };
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === '127.0.0.1' || req.resourceType() === 'image' || req.resourceType() === 'font' || IMAGE.test(url.pathname)) return route.continue();
    friend.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });
  return friend;
}
