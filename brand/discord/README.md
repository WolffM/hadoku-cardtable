# Discord server icon

The Cardtable Discord server's icon: a sly fox side-eyeing over a hand of card
backs. It's an original drawing, with no card frames and no Magic symbols.

- `sly-hand.svg` is the source: a 512 viewBox with a transparent background.
- `cardtable-discord-512.png` is what gets uploaded: 512 × 512, rendered from the SVG.

The browser-tab favicon is a separate drawing of the same fox, made for 16 px:
`apps/ui/src/favicon.svg`, a 64-unit grid where 4 units are one pixel at 16 px.

After editing the SVG, re-render the PNG at 512 px with a transparent
background. Then upload it in Discord: Server Settings → Server Profile → Icon.

This folder is the one place the repo tracks a PNG (operator, 2026-11-07;
see `AGENTS.md`).
