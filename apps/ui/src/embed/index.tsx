/*
 * The game bundle watchparty imports (D21): `/cardtable/embed/cardtable-embed.js`.
 *
 * `mount(el, ctx)` draws cardtable inside a shadow root on `el` and hands back
 * `{ update, unmount }`: `@hadoku/ui-shell/embed`'s `mountEmbed`, which every
 * game's embed shares (and whose header has the whole sequence). Cardtable's
 * part of it, all of which `unmount` takes down again:
 *
 * - **Styles** — with the fleet's cosmetics sheet beside them.
 * - **The theme on `el` itself** (`data-theme`, `hostTheme`), before the styles
 *   land, so the host is painted in the host's theme rather than the light
 *   default (the build's `hostTheme`, `../../vite.embed.config.ts`).
 * - **The route** — in memory (`routeInMemory`); watchparty owns the URL.
 * - **Lookups and hit tests** — `setDocumentScope` points the app's
 *   document-wide queries at the shadow root (`../dom.ts`).
 * - **Hash links** — an `<a href="#/…">` inside the table would rewrite
 *   watchparty's own address bar; a click on one is routed in memory instead.
 *
 * ## One mount per page
 *
 * The route, the document scope and a few modules below the screens (the
 * board's placement preview, the sound engine) are module singletons, exactly
 * as they are standalone, where "one chrome per page" already holds. A second
 * concurrent mount is refused loudly (`mountEmbed`).
 *
 * Built by `../../vite.embed.config.ts`; served with `no-cache` (the name does
 * not change between builds) by `apps/server/src/index.ts`.
 */

import { configureShell } from '@hadoku/ui-shell/app-id';
// Every sheet the table reaches, the lazy screens' too, in source order (`../../stylesheet.ts`).
import 'virtual:cardtable-stylesheet';
import { createElement } from 'react';
import { cosmeticsCss } from '@wolffm/prefs-client/cosmetics';

import { APP_ID } from '../../app-name.ts';
import { setDocumentScope } from '@hadoku/game-ui/dom.ts';
import { navigate, parseRoute, routeInMemory } from '@hadoku/game-ui/screens/route.ts';
import { preloadLikelyScreens } from '../screens/Screen.tsx';
import { EmbedApp } from './EmbedApp.tsx';
import { mountEmbed } from '@hadoku/ui-shell/embed';
import type { GameBundleModule } from './contract.ts';

// The same tiers, in the same order, as `main.tsx` — minus the header's two
// sheets, because there is no header. Every sheet the app imports below this
// lands in the one `cardtable-embed.css` the build emits.
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '@wolffm/task-ui-components/controls.css';
import '@hadoku/magic-ui/styles.css';
import '@hadoku/ui-shell/chrome';

// Every storage key, event name and chat prefix the shell writes is built from this.
configureShell({ appId: APP_ID });

export const mount: GameBundleModule['mount'] = mountEmbed({
  name: APP_ID,
  // Beside the entry, under the app's base — the API base resolves from the same `BASE_URL`.
  stylesheet: `${import.meta.env.BASE_URL}embed/cardtable-embed.css`,
  // The fleet's cosmetics sheet (faces' overlays, names' effects) rides in the
  // shadow sheet: `room/look.tsx` writes it to the document only standalone.
  extraCss: cosmeticsCss,
  // `hdk-controls` here, not on the host's <html>: a shadow root's selectors cannot see past it.
  containerClass: 'cardtable-embed hdk-controls',
  // A table is what the embed is mounted to show: its screens load beside the stylesheet.
  prefetch: preloadLikelyScreens,
  hostTheme: true,
  // An `<a href="#/…">` inside the table would rewrite watchparty's own address bar.
  followHashLink: (href) => navigate(parseRoute(href)),
  setup: ({ shadow, cleanup }) => {
    cleanup(setDocumentScope(shadow));
    cleanup(routeInMemory({ kind: 'lobby' }));
  },
  render: (ctx) => createElement(EmbedApp, { ctx }),
});
