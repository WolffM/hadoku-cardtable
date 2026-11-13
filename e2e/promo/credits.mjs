#!/usr/bin/env node
/**
 * The trailer's closing credits, drawn as a page and photographed: `node credits.mjs <out.png>`
 * (`cut.py` runs it for its END card).
 *
 * What it says is set by the operator (cut 5): free forever, open source, the licence, the Discord and
 * GitHub links with their icons, and the not-affiliated-with-Wizards disclaimer in NOTICE.md's own words.
 * The icons are the site header's own paths (`packages/game-ui/src/chrome/HeaderLinks.tsx`), read from that file so
 * the two never drift; the type is the C2 caption family (Noto Sans Black, letter-spaced SemiBold, the
 * accent rule). No WotC logo or wordmark, and nothing about money: "free forever" is a promise.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

const [out] = process.argv.slice(2);
if (out === undefined) {
  console.error('usage: credits.mjs <out.png>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..', '..');
const header = readFileSync(resolve(root, 'packages/game-ui/src/chrome/HeaderLinks.tsx'), 'utf8');
const constant = (name) => {
  const m = new RegExp(`${name}\\s*=\\s*\\n?\\s*'([^']+)'`).exec(header);
  if (m === null) throw new Error(`credits: no ${name} in HeaderLinks.tsx`);
  return m[1];
};
const notice = readFileSync(resolve(root, 'NOTICE.md'), 'utf8');
// The disclaimer's first sentence, verbatim, markdown emphasis stripped.
const disclaimer = /This project is[\s\S]*?Hasbro, Inc\.\*\*[^.]*\./.exec(notice)?.[0].replace(/\*\*/g, '').replace(/\s+/g, ' ').replace(/ in any way\.$/, ' in any way.');
if (disclaimer === undefined) throw new Error('credits: the Wizards disclaimer is not in NOTICE.md');
const discord = constant('DISCORD_INVITE_URL').replace(/^https:\/\//, '');
const github = constant('GITHUB_REPO_URL').replace(/^https:\/\//, '');
const icon = (path) => `<svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1920px; height: 1080px; background: #141218; color: #fff; font-family: 'Noto Sans', sans-serif; }
  .card { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 0; text-align: center; }
  .kicker { display: flex; align-items: center; gap: 18px; color: #b497ff; font-weight: 600; font-size: 26px; letter-spacing: 6px; margin-bottom: 18px; }
  .kicker::before { content: ''; width: 56px; height: 5px; background: #b497ff; }
  h1 { margin: 0; font-weight: 900; font-size: 150px; letter-spacing: 2px; line-height: 1.05; }
  .tags { margin-top: 26px; font-weight: 900; font-size: 46px; color: #e8e3f7; }
  .tags span { color: #b497ff; margin: 0 18px; }
  .links { margin-top: 64px; display: flex; gap: 90px; font-weight: 600; font-size: 34px; color: #e8e3f7; }
  .links div { display: flex; align-items: center; gap: 18px; }
  .links svg { color: #b497ff; }
  .fine { position: absolute; left: 50%; bottom: 64px; transform: translateX(-50%); width: 1500px; text-align: center; font-size: 22px; line-height: 1.5; color: #a49cb8; }
</style></head><body><div class="card">
  <div class="kicker">LICENSED GPL-3.0-OR-LATER</div>
  <h1>CARD TABLE</h1>
  <div class="tags">Free forever<span>·</span>Open source</div>
  <div class="links"><div>${icon(constant('DISCORD_PATH'))}${discord}</div><div>${icon(constant('GITHUB_PATH'))}${github}</div></div>
</div><p class="fine">${disclaimer}</p></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`credits: ${out}`);
