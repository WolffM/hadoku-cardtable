# Request — trim and effects for `@wolffm/themes` / `@wolffm/task-ui-components`

**To:** `hadoku-task` (`themes/`, `task-ui-components/`, the theme editor in `themes/dev/`)
**From:** hadoku-cardtable, 2026-10-23
**Ask:** the operator, 2026-10-23: *"i like the ui trims and eye-candy effects that were built in
this repo, it makes sense to provide this functionality for hadoku-ui-components … so they can build
this functionality into their editor."*

## Handoff — give this to a Claude session in `hadoku-task`

```sh
cd /home/hadoku/repos/hadoku-task && claude
```

---

Read `/home/hadoku/repos/hadoku-cardtable/docs/requests/UI_COMPONENTS_TRIM_AND_EFFECTS.md` and
implement it. The ready-to-move kit is next to it in `UI_COMPONENTS_TRIM_KIT/`: `trim.ts`,
`trim.css`, `effects.css`, `preview.html`. §3 says where each file goes, §4 lists the contracts
(C1–C8) the port must keep, and §5 covers the editor work. Both CSS files already pass this repo's
`stylelint`. Bootstrap your worktree with `node scripts/new-worktree.mjs`. Don't ask questions.
Write the published versions and anything you declined to
`/home/hadoku/repos/hadoku-cardtable/docs/requests/UI_COMPONENTS_TRIM_AND_EFFECTS_REPLY.md`.

---

## 1. What it is

**Trim** is game-UI decoration for panels and for the page behind them: cut frames, corner
ornaments, title treatments, panel textures and background patterns. There are 7 families and 23
options, and you pick one option per family. It is all CSS gradients, clip-paths and masks drawn from
`--color-*` tokens, so every option follows the active theme in light and dark with no per-theme work.
It uses no images, makes no requests and has no animation. cardtable has shipped it on every panel
since 2026-10-21. An admin composes it at `#/ui`, and the operator's pick is
`{ frame: 'scoop', ground: 'triangles', groundCorner: 'gems' }`.

**Effects** are the motion half: ten single-class effects taken from cardtable's board and chrome
and moved off their game selectors (ward, mist, hex, glint, shimmer, sheen, pulse, nudge, breathe,
float). They are token-coloured through `--fx-color` and each has a reduced-motion fallback.

`preview.html` shows both against the real `style.css`. It was checked in Chromium and Firefox,
light and dark, with 0 console errors (§6).

## 2. The kit (`UI_COMPONENTS_TRIM_KIT/`)

| File | What | Source in cardtable (`apps/ui/src/`) |
| --- | --- | --- |
| `trim.ts` | `TRIM_FAMILIES` catalogue, `Trim` type, `applyTrim(el, trim)`, `knownTrim(unknown)`, `trimAttribute`, `isTrimOption`. Framework-free. | `settings/trim.ts`, plus `knownTrim` from `settings/siteTrim.ts` |
| `trim.css` | Every trim family. The geometry is byte-identical to cardtable's. Only the hooks are renamed. | `chrome/trim.css` |
| `effects.css` | The 10 effects, `hdk-fx-*` | `play/card.css`, `play/live/live.css`, `screens/screens.css`, `components/spectate.css` |
| `preview.html` | A file:// dev page with a theme select, one select per trim family, sample panels and an effects gallery | — |

Hooks renamed for the fleet:

| cardtable | kit | Meaning |
| --- | --- | --- |
| `.ct-panel` | `.hdk-panel` | A panel that takes frame / corner / edge / texture |
| `.ct-panel__title` | `.hdk-panel__title` | Its heading (title family) |
| `.ct-surface` | `.hdk-surface` | A popover, menu or dialog. A panel holding one is never cut. |
| `.cardtable-chrome` | `.hdk-ground` | The element that paints the page background |
| `data-trim-*` | unchanged | Written by `applyTrim` on any ancestor, normally `<html>` |

## 3. Where it goes (recommended; the placement is your call)

- **`@wolffm/themes`**: `src/trim.css` and `src/effects.css` as `./trim.css` and `./effects.css`
  exports next to `./advanced.css`. They are pure token CSS with no framework, the same kind of file
  as `advanced.css`. `trim.ts` becomes a `./trim` subpath with no React and no zod, on the same rule
  as `./icons`.
- **`@wolffm/task-ui-components`**: `Modal` and `ContextMenu` (and anything else that floats over
  content) carry `hdk-surface`. `BentoCard` and `SettingsModal`'s panel are natural `.hdk-panel`
  candidates. A `useTrim(root, trim)` hook may wrap `applyTrim` in a layout effect, as cardtable's
  `siteTrim.ts` does.
- **Persistence is out of scope.** cardtable keeps one site-wide trim on its own server
  (`/api/trim`, admin-only writes). The package only has to take a `Trim` value. If you want a
  per-user trim, `@wolffm/prefs-client` is the obvious home, but nobody has asked for that yet.

## 4. Contracts the port must keep

- **C1 — tokens only.** No literal colours, and no `var(--color-x, #hex)` fallbacks. Both files
  already pass your stylelint (§6).
- **C2 — nothing until chosen.** Every trim rule hangs off a `data-trim-*` attribute, and `{}`
  writes none. A consumer that imports `trim.css` and sets nothing must look exactly as before.
- **C3 — layers, not pseudo-elements.** Trim families stack as background layers through the
  `--trim-<family>-{i,p,s,r}` quads, so scrolled content keeps them, layout is untouched and no
  stacking context opens. `::before`/`::after` stay free for consumers and for `effects.css`.
  `.hdk-panel.hdk-panel` is deliberate: it out-ranks a panel's own `background` shorthand.
- **C4 — a frame's clip edges sit 1px outside the panel.** A clip on the border box antialiased
  half the 1px border away at fractional sizes (40 of 160 edges at 100% scaling, measured in
  cardtable on 2026-10-22). Keep the `-1px` / `calc(100% + 1px)` points.
- **C5 — a panel holding a `.hdk-surface` is never cut.** Frame shapes clip everything inside,
  including a dropdown that overflows the panel. That is the `:not(:has(.hdk-surface))`.
- **C6 — reduced motion keeps the meaning.** Each effect has a fallback: a shimmer becomes a still
  glow that fades, and a nudge becomes a stronger fill with a steady glow.
- **C7 — animate numbers, not lengths.** `float` animates `<number>` custom properties and
  multiplies them by `1px`/`1deg` where it uses them. Firefox replays a length keyframe on an
  inherited custom property forwards instead of alternating. That broke cardtable's flyers in the
  operator's browser (cardtable `2aabe521`).
- **C8 — `trim.ts` stays framework-free.** No React import in it, so a plain-HTML or Astro app can
  use it.

## 5. The editor

`themes/dev/editor.html` already has an "Advanced Effects" section. The ask:

1. **A Trim section:** one select per family, built from the catalogue, applied to `<html>` with
   `applyTrim` so the editor's own sections preview it. The editor's showcase sections should carry
   `.hdk-panel` / `.hdk-panel__title`, and its page `.hdk-ground`. `preview.html` is the working
   reference for the wiring. Note that editor.js is bundled to an IIFE for file://, so the catalogue
   has to reach it the way `config.js` mirrors `THEME_FAMILIES`.
2. **An Effects gallery:** each `hdk-fx-*` on a sample tile, as in `preview.html`, with a click to
   replay the one-shot `shimmer`.
3. Switching themes in the editor must redraw both with no extra code, because everything is
   tokens. That is the check that the port kept C1.

## 6. Verified here (2026-10-23)

- `preview.html` was served against `hadoku-task@502bb52`'s `themes/src/style.css` and screenshotted
  in Chromium and Firefox (Playwright 1.62.1) on `dark` with the operator's default trim, and on
  `light` with one option set in every family (chamfer, rivets, ribbon, keystone, felt, grid, wedge)
  and a shimmer mid-run. Every option drew, `data-trim-*` attributes were written as expected, and
  both browsers logged 0 console errors or warnings.
- `npx stylelint` with hadoku-task's `.stylelintrc.cjs` reported 0 problems on `trim.css` and
  `effects.css`.
- Not verified: `lint:css`'s `validate` half (contrast, usage and docs gates) runs against
  `themes/src` as a whole and needs the files in place. Run it after you move them.

## 7. Deliberately not included

The game-specific motion stays in cardtable, because each piece is tied to card and board state:
card departures (`board-exit-*`: dissolve, shatter, slash, crumple), projectiles and impact sparks,
damage/heal numbers, the stack's float and resolve, flyers' card-only shadow geometry, the coin toss,
the face-off and gauntlet intros, the pack-queue fidgets, and door unlock. If one of them turns out
to be wanted generically, ask for it and it can be lifted the same way.

## 8. Licence

cardtable is GPL-3.0-or-later because it vendors Forge. These files are **not** Forge-derived. They
were written in this repo by the operator's sessions, and the operator, as copyright holder, offers
them to hadoku-task under its MIT licence.

## 9. After you publish (cardtable's side)

Once the published versions are in the reply, cardtable will import `@wolffm/themes/trim.css` and
`/trim`, rename `ct-panel`/`ct-surface` to the `hdk-` hooks, and **delete** `chrome/trim.css` and the
catalogue half of `settings/trim.ts`. One copy, not two.
