/*
 * Wave 27 lane D: SHOW that deleting styles.css's 16 pre-D20 `.pip` rules
 * changes no rendered pip.
 *
 * Renders, in a real Chromium, the exact markup `ManaPip.tsx` emits for every
 * shape it can emit, against a built UI CSS bundle served over HTTP (so the
 * vendored woff2 fonts actually load), and dumps for each element:
 *   - every computed property the deleted block set, on the wrapper AND on the
 *     inner `<i>` glyph (which is what a reader sees),
 *   - the ::before / ::after computed content, font-size and position, which is
 *     how Mana draws a hybrid's two halves,
 *   - the glyph's own bounding box.
 *
 * Run once per bundle; diff the two JSON dumps.
 *
 *   node probe.mjs <bundle.css path> <out.json>
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import pw from '/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w27-manager/e2e/node_modules/@playwright/test/index.js';
const { chromium } = pw;

const [cssPath, outPath] = process.argv.slice(2);
const css = readFileSync(cssPath, 'utf8');
const DIST = '/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w27-manager/apps/ui/dist';

/** Every token shape `readManaToken` has a branch for, plus the no-glyph arm. */
const TOKENS = [
  'W', 'U', 'B', 'R', 'G', 'C', 'S', 'X', 'Y', 'Z', 'E', 'P', 'T', 'Q', '½', '∞',
  '0', '1', '2', '7', '20', '100', '1000000',
  'W/U', 'U/B', 'B/R', 'R/G', 'G/W', 'W/B', 'U/R', 'B/G', 'R/W', 'G/U',
  '2/W', '2/U', '2/B', '2/R', '2/G', 'C/W', 'C/G',
  'W/P', 'U/P', 'B/P', 'R/P', 'G/P',
  'W/U/P', 'B/G/P',
  'ZZZ-not-a-token',
];

// `ManaPip.tsx`'s own table, duplicated here on purpose: the probe must render
// what the component renders, and importing a .tsx into a plain node script
// would need a bundler.
const HYBRID_PAIRS = ['WU', 'WB', 'UB', 'UR', 'BR', 'BG', 'RW', 'RG', 'GW', 'GU'];
const HYBRID = {};
for (const p of HYBRID_PAIRS) { HYBRID[p] = p.toLowerCase(); HYBRID[p[1] + p[0]] = p.toLowerCase(); }
const SINGLE = { W:'w',U:'u',B:'b',R:'r',G:'g',C:'c',S:'s',X:'x',Y:'y',Z:'z',E:'e',P:'p',T:'tap',Q:'untap','½':'1-2','∞':'infinity' };
const GENERIC = new Set([...Array.from({ length: 21 }, (_, i) => String(i)), '100', '1000000']);
const isColor = (t) => 'WUBRG'.includes(t) && t.length === 1;

function manaClass(token) {
  const parts = token.split('/');
  if (parts.length === 3) {
    const pair = HYBRID[parts[0] + parts[1]];
    if (parts[2] === 'P' && pair !== undefined) return `${pair}p`;
  }
  if (parts.length === 2) {
    const [a, b] = parts;
    if (b === 'P' && isColor(a)) return `${a.toLowerCase()}p`;
    if ((a === '2' || a === 'C') && isColor(b)) return `${a.toLowerCase()}${b.toLowerCase()}`;
    const pair = HYBRID[a + b];
    if (pair !== undefined) return pair;
  }
  if (SINGLE[token] !== undefined) return SINGLE[token];
  if (GENERIC.has(token)) return token;
  return null;
}

const rows = TOKENS.map((token) => {
  const mana = manaClass(token);
  return mana === null
    ? `<span class="pip pip--wide pip--unknown" data-t="${token}">${token}</span>`
    : `<span class="pip pip--symbol" style="display:contents;font-size:inherit" data-t="${token}"><i class="ms ms-${mana} ms-cost" role="img"></i></span>`;
});

// Three contexts, because `.pip`'s inherited half depends on what it inherits
// from: a deck row (14px), a card tile (11px) and a board flag.
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="http://127.0.0.1:${'PORT'}/assets/CSSFILE">
</head><body>
<div id="ctx-deckrow" style="font-size:14px"><span class="cost">${rows.join('')}</span></div>
<div id="ctx-tile" style="font-size:11px"><span class="cost">${rows.join('')}</span></div>
<div id="ctx-inherit" style="font-size:20px;font-weight:400;color:#ff00ff;line-height:2"><span class="cost">${rows.join('')}</span></div>
</body></html>`;

const PROPS = [
  'display', 'alignItems', 'justifyContent', 'width', 'height', 'borderRadius',
  'backgroundColor', 'backgroundImage', 'color', 'fontSize', 'fontWeight',
  'lineHeight', 'verticalAlign', 'flexShrink', 'letterSpacing', 'padding',
  'minWidth', 'boxShadow', 'outline', 'outlineOffset', 'fontFamily', 'position',
  'textAlign',
];

const cssFile = cssPath.split('/').pop();
const server = createServer((req, res) => {
  if (req.url === `/assets/${cssFile}`) {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end(css);
    return;
  }
  try {
    const body = readFileSync(`${DIST}${req.url.split('?')[0]}`);
    res.writeHead(200, { 'content-type': req.url.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(18777, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 3 });
await page.setContent(html.replace("${'PORT'}", '18777').replace('PORT', '18777').replace('CSSFILE', cssFile));
await page.waitForLoadState('load');
await page.evaluate(() => document.fonts.ready);

const dump = await page.evaluate((props) => {
  const out = {};
  for (const ctx of ['ctx-deckrow', 'ctx-tile', 'ctx-inherit']) {
    for (const wrap of document.querySelectorAll(`#${ctx} [data-t]`)) {
      const token = wrap.getAttribute('data-t');
      const glyph = wrap.querySelector('i') ?? wrap;
      const pick = (el, pseudo) => {
        const s = getComputedStyle(el, pseudo ?? undefined);
        const o = {};
        for (const p of props) o[p] = s[p];
        if (pseudo !== null) o.content = s.content;
        return o;
      };
      const r = glyph.getBoundingClientRect();
      out[`${ctx}/${token}`] = {
        wrapper: pick(wrap, null),
        glyph: pick(glyph, null),
        before: pick(glyph, '::before'),
        after: pick(glyph, '::after'),
        box: { w: +r.width.toFixed(3), h: +r.height.toFixed(3) },
        text: wrap.textContent,
      };
    }
  }
  return out;
}, PROPS);

writeFileSync(outPath, `${JSON.stringify(dump, null, 1)}\n`, 'utf8');

// The literal answer to "is anything rendered differently": a pixel shot of
// every probe, at 3x, which is what a diff of the two PNGs settles.
for (const ctx of ['ctx-deckrow', 'ctx-tile', 'ctx-inherit']) {
  await page.locator(`#${ctx}`).screenshot({
    path: outPath.replace(/\.json$/, `-${ctx}.png`),
    scale: 'css',
  });
}
console.log(`${outPath}: ${Object.keys(dump).length} probes`);
await browser.close();
server.close();
