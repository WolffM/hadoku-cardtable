// Wave 15, lane D -- the click-to-pixel rig, as a standalone script.
//
// It is a separate file on purpose: the SAME code has to run inside our CheerpJ
// harness page AND be injected (page.addInitScript) into a page we do not own,
// so that CheerpJ and a streamed noVNC canvas are measured by one instrument
// rather than by two instruments that agree only in prose. streaming.md's own
// "What these numbers do NOT include" names the browser paint as unmeasured and
// says: "To settle it, drive the click from inside the page and time it against
// a requestAnimationFrame after the canvas changes; nothing in this lane does
// that yet." This is that, pointed at both.
//
// It defines window.__fp.ctp and, if the host page has not already made one,
// a minimal window.__fp. It never assumes CheerpJ is present.

(() => {
const S = window.__fp = window.__fp || {};
if (!S.lines) S.lines = [];
if (!S.marks) S.marks = {};
if (!S.find) S.find = (p) => (S.lines.find((l) => l.s.startsWith(p)) || null);

// ---------------------------------------------------------------------------
// The click-to-pixel rig.
// ---------------------------------------------------------------------------
const CTP = S.ctp = {
  canvas: null,
  read: null,          // (x,y,w,h) -> Uint8ClampedArray, or null
  readPath: null,      // 'direct2d' | 'drawImage'
  scratch: null,
  region: null,        // { x, y, w, h } in canvas pixel coords
  baseline: null,
  changes: [],         // { t, via, changedPixels }
  presses: [],         // { t, x, y } from trusted mousedown, page clock
  sampling: false,
  pollTimes: [],
  rafTimes: [],
  // A pixel counts as changed when any channel moves by more than this. 12 is
  // far above JPEG-less canvas noise (there is none: this is a bitmap read, not
  // a video decode) and far below any real repaint.
  CH_DELTA: 12,
  // ...and a frame counts as changed only when at least this many pixels did.
  // A single stray pixel is not a repaint; without this the rig would happily
  // report a number off an antialiasing wobble.
  MIN_PIXELS: 24,
};

// The press timestamp. Capture phase on window so it is recorded before
// anything CheerpJ does with the event, passive so it cannot alter delivery.
// event.timeStamp on a trusted event shares performance.now()'s time origin, so
// press and pixel are in ONE clock.
//
// MEASURED, and it cost a run to find: under CheerpJ 4.3 a click on the display
// dispatches pointerdown / pointerup / click and **no mousedown or mouseup at
// all** -- CheerpJ preventDefault()s the pointer event, which suppresses the
// compatibility mouse events. A rig that timestamps 'mousedown' therefore
// records NOTHING while Java's own MouseListener fires normally, i.e. it reads
// as "the click was never delivered" when the click was delivered perfectly.
// Listen for both and take whichever arrives; assert the type in the output.
for (const type of ['pointerdown', 'mousedown']) {
  window.addEventListener(type, (e) => {
    CTP.presses.push({ t: e.timeStamp, now: performance.now(), type: e.type,
                       x: e.clientX, y: e.clientY, trusted: e.isTrusted });
  }, { capture: true, passive: true });
}

CTP.attach = (selector) => {
  // The biggest canvas on the page, unless told otherwise. noVNC's display and
  // CheerpJ's display are both "the one big canvas", but noVNC also puts small
  // helper canvases in the DOM and picking the first would measure a 1x1 pixel.
  const c = selector
    ? document.querySelector(selector)
    : (document.querySelector('#display canvas')
       || [...document.querySelectorAll('canvas')]
            .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]);
  if (!c) return { ok: false, why: 'NO-CANVAS' };
  CTP.canvas = c;

  // Path 1: the canvas is a 2d canvas we can read directly.
  let ctx = null;
  try { ctx = c.getContext('2d'); } catch { ctx = null; }
  if (ctx && typeof ctx.getImageData === 'function') {
    CTP.readPath = 'direct2d';
    CTP.read = (x, y, w, h) => {
      try { return ctx.getImageData(x, y, w, h).data; } catch { return null; }
    };
  } else {
    // Path 2: blit into our own 2d canvas. Works for a canvas whose context we
    // cannot obtain; may read blank for a WebGL canvas without
    // preserveDrawingBuffer, which is why a blank baseline is a hard failure
    // below rather than a zero.
    CTP.readPath = 'drawImage';
    const sc = CTP.scratch = document.createElement('canvas');
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    CTP.read = (x, y, w, h) => {
      try {
        sc.width = w; sc.height = h;
        sctx.drawImage(c, x, y, w, h, 0, 0, w, h);
        return sctx.getImageData(0, 0, w, h).data;
      } catch { return null; }
    };
  }
  return { ok: true, readPath: CTP.readPath, w: c.width, h: c.height,
           css: { w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height } };
};

const diffCount = (a, b) => {
  if (!a || !b || a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > CTP.CH_DELTA ||
        Math.abs(a[i + 1] - b[i + 1]) > CTP.CH_DELTA ||
        Math.abs(a[i + 2] - b[i + 2]) > CTP.CH_DELTA) n++;
  }
  return n;
};

// A baseline where every pixel is identical means we are almost certainly
// reading a buffer that has nothing in it (the drawImage-from-WebGL case, or a
// canvas that was never drawn to). Reporting a latency off that is the exact
// "harness passes while measuring nothing" failure this lane is told to avoid.
const isUniform = (a) => {
  if (!a || a.length < 16) return true;
  for (let i = 4; i < a.length; i += 4) {
    if (a[i] !== a[0] || a[i + 1] !== a[1] || a[i + 2] !== a[2]) return false;
  }
  return true;
};

// Full-canvas diff, used once to LOCATE the region a click actually changes.
// In Phase 2 nothing is known about Forge's layout, so the region is found, not
// assumed; and if a click changes nothing, this is where that is discovered.
CTP.fullBaseline = () => {
  const c = CTP.canvas;
  CTP.full = CTP.read(0, 0, c.width, c.height);
  return { ok: !!CTP.full, uniform: isUniform(CTP.full), bytes: CTP.full ? CTP.full.length : 0 };
};

CTP.locate = () => {
  const c = CTP.canvas;
  const now = CTP.read(0, 0, c.width, c.height);
  if (!now || !CTP.full) return { ok: false, why: 'READ-FAILED' };
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(now[i] - CTP.full[i]) > CTP.CH_DELTA ||
          Math.abs(now[i + 1] - CTP.full[i + 1]) > CTP.CH_DELTA ||
          Math.abs(now[i + 2] - CTP.full[i + 2]) > CTP.CH_DELTA) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (n === 0) return { ok: false, why: 'NO-CHANGE', changedPixels: 0 };
  return { ok: true, changedPixels: n, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
};

// Pick the 520x30 strip (streaming's exact strip size) centred in the bbox of
// what a click changes, clamped to the canvas.
CTP.setRegionFromBBox = (bbox, sw, sh) => {
  const c = CTP.canvas;
  const w = Math.min(sw || 520, bbox.w, c.width);
  const h = Math.min(sh || 30, bbox.h, c.height);
  let x = Math.round(bbox.x + (bbox.w - w) / 2);
  let y = Math.round(bbox.y + (bbox.h - h) / 2);
  x = Math.max(0, Math.min(x, c.width - w));
  y = Math.max(0, Math.min(y, c.height - h));
  CTP.region = { x, y, w, h };
  return CTP.region;
};

// A GENERATION counter, not a boolean. With a boolean, stopSampling() sets
// false and the next arm() sets it true again before the previous loop's
// pending callback has run -- so the old loop sees `sampling === true` and
// keeps going. Every rep then adds another pair of loops. Measured: the raf
// sample count went 23, 44, 66, 88, 110 across five reps, and the reported
// sampler interval collapsed from a true 4.1 ms to a meaningless 0.1 ms
// because several loops were interleaving. The interval is the evidence that
// the sampler kept up, so corrupting it corrupts the proof, and the extra
// loops also load the same thread the JVM runs on.
CTP.gen = 0;
CTP.startSampling = () => {
  if (CTP.sampling) return;
  CTP.sampling = true;
  const gen = ++CTP.gen;
  const r = CTP.region;

  const check = (via) => {
    const cur = CTP.read(r.x, r.y, r.w, r.h);
    const n = diffCount(cur, CTP.baseline);
    if (n >= CTP.MIN_PIXELS) CTP.changes.push({ t: performance.now(), via, changedPixels: n });
  };

  // ~4-5 ms quantum in Chrome (the 4 ms nesting clamp) -- deliberately close to
  // the 5 ms quantum streaming.md's ffmpeg-at-200-fps capture had. It YIELDS,
  // so it cannot starve the thread CheerpJ runs on the way a MessageChannel
  // spin loop would; a starved JVM would show up as a latency the rig caused
  // rather than one it measured.
  const pollLoop = () => {
    if (!CTP.sampling || CTP.gen !== gen) return;
    CTP.pollTimes.push(performance.now());
    check('poll');
    setTimeout(pollLoop, 0);
  };
  const rafLoop = () => {
    if (!CTP.sampling || CTP.gen !== gen) return;
    CTP.rafTimes.push(performance.now());
    check('raf');
    requestAnimationFrame(rafLoop);
  };
  setTimeout(pollLoop, 0);
  requestAnimationFrame(rafLoop);
};

CTP.stopSampling = () => { CTP.sampling = false; CTP.gen++; };

// Re-baseline and clear per-rep state. Returns once the canvas has been quiet
// for quietMs -- a pre-click baseline that is already moving makes any number
// taken against it meaningless.
CTP.arm = async (quietMs) => {
  const r = CTP.region;
  CTP.changes = [];
  CTP.presses = [];
  CTP.pollTimes = [];
  CTP.rafTimes = [];
  CTP.baseline = CTP.read(r.x, r.y, r.w, r.h);
  if (!CTP.baseline) return { ok: false, why: 'READ-FAILED' };
  if (isUniform(CTP.baseline)) return { ok: false, why: 'BASELINE-BLANK' };
  CTP.startSampling();
  const t0 = performance.now();
  await new Promise((res) => setTimeout(res, quietMs));
  const noisy = CTP.changes.filter((c) => c.t >= t0);
  CTP.armedAt = performance.now();
  CTP.changes = [];
  return { ok: noisy.length === 0, why: noisy.length ? 'NOISY-BASELINE' : null,
           preClickChanges: noisy.length, armedAt: CTP.armedAt };
};

// Wait for the first change of each kind after the press, or run out of budget.
CTP.collect = async (budgetMs) => {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    const p = CTP.presses.length ? CTP.presses.slice().sort((a, b) => a.t - b.t)[0] : null;
    if (p) {
      const poll = CTP.changes.find((c) => c.via === 'poll' && c.t > p.t);
      const raf = CTP.changes.find((c) => c.via === 'raf' && c.t > p.t);
      if (poll && raf) break;
    }
    await new Promise((res) => setTimeout(res, 2));
  }
  CTP.stopSampling();
  const p = CTP.presses.length ? CTP.presses.slice().sort((a, b) => a.t - b.t)[0] : null;
  const poll = p ? CTP.changes.find((c) => c.via === 'poll' && c.t > p.t) : null;
  const raf = p ? CTP.changes.find((c) => c.via === 'raf' && c.t > p.t) : null;
  const ivl = (ts) => { const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]); return d; };
  // Decompose the number with the Java side's own console lines. They are
  // stamped with performance.now() by the console hook above, so they are in
  // the SAME clock as the press and the pixel -- no JVM/JS correlation.
  // PAINT-DONE must land at or before the poll detection; if it does not, the
  // rig is reading pixels that the repaint it is attributing them to did not
  // produce, and the output says so.
  const after = (prefix) => (p ? S.lines.find((l) => l.t > p.t && l.s.startsWith(prefix)) : null);
  const jClick = after('PAINT-CLICK');
  const jDone = after('PAINT-DONE');
  return {
    press: p,
    javaListenerMs: jClick ? jClick.t - p.t : null,
    javaPaintDoneMs: jDone ? jDone.t - p.t : null,
    pressCount: CTP.presses.length,
    pollMs: poll ? poll.t - p.t : null,
    rafMs: raf ? raf.t - p.t : null,
    pollChangedPixels: poll ? poll.changedPixels : null,
    rafChangedPixels: raf ? raf.changedPixels : null,
    // Every change after the press, not just the first. Without this a rig can
    // only say "something changed at t"; with it you can see whether the strip
    // moved once or twice and how big each move was, which is the difference
    // between a measurement and a guess.
    allChanges: (p ? CTP.changes.filter((c) => c.via === 'poll' && c.t > p.t) : [])
      .map((c) => ({ ms: +(c.t - p.t).toFixed(1), px: c.changedPixels })),
    pollIntervals: ivl(CTP.pollTimes),
    rafIntervals: ivl(CTP.rafTimes),
    pollSamples: CTP.pollTimes.length,
    rafSamples: CTP.rafTimes.length,
    region: CTP.region,
    readPath: CTP.readPath,
  };
};

})();
