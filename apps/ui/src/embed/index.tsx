/*
 * The game bundle watchparty imports (D21): `/cardtable/embed/cardtable-embed.js`.
 *
 * `mount(el, ctx)` draws cardtable inside a shadow root on `el` and hands back
 * `{ update, unmount }`. Everything the standalone page gets from owning the
 * document is set up here instead, and taken down again by `unmount`:
 *
 * - **Styles** — fetched once and adopted by the shadow root (`./styles.ts`,
 *   which also says what has to live on the document and why).
 * - **The theme on `el` itself** (`data-theme`), before the styles land, so the
 *   host is painted in the host's theme rather than the light default
 *   (`withHostTheme` in `../../vite.embed.config.ts`). Restored on unmount.
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
 * concurrent mount is refused loudly rather than half-sharing the first's.
 *
 * Built by `../../vite.embed.config.ts`; served with `no-cache` (the name does
 * not change between builds) by `apps/server/src/index.ts`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { setDocumentScope } from '../dom.ts';
import { navigate, parseRoute, routeInMemory } from '../screens/route.ts';
import { EmbedApp } from './EmbedApp.tsx';
import { adoptStyles, fetchStyles } from './styles.ts';
import type { GameBundleContext, GameBundleModule, MountedGameBundle } from './contract.ts';

// The same tiers, in the same order, as `main.tsx` — minus the header's two
// sheets, because there is no header. Every sheet the app imports below this
// lands in the one `cardtable-embed.css` the build emits.
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '../styles.css';
import '../chrome/chrome.css';

/** Beside the entry, under the app's base — the API base resolves from the same `BASE_URL`. */
const STYLESHEET = `${import.meta.env.BASE_URL}embed/cardtable-embed.css`;

let active = false;

/** Put `theme` on the host element. Returns the undo, which restores what was there. */
function themeHost(el: HTMLElement): { set: (theme: string) => void; undo: () => void } {
  const before = el.getAttribute('data-theme');
  return {
    set: (theme) => el.setAttribute('data-theme', theme),
    undo: () => (before === null ? el.removeAttribute('data-theme') : el.setAttribute('data-theme', before)),
  };
}

/** Route a click on an in-app hash link in memory. Returns the undo. */
function followHashLinks(shadow: ShadowRoot): () => void {
  const onClick = (event: Event): void => {
    if (event.defaultPrevented) return;
    const link = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    const href = link?.getAttribute('href');
    if (href === undefined || href === null || !href.startsWith('#')) return;
    event.preventDefault();
    navigate(parseRoute(href));
  };
  shadow.addEventListener('click', onClick);
  return () => shadow.removeEventListener('click', onClick);
}

async function mountCardtable(el: HTMLElement, ctx: GameBundleContext): Promise<MountedGameBundle> {
  if (active) throw new Error('cardtable embed: already mounted on this page — unmount it before mounting again');
  active = true;
  const undo: (() => void)[] = [];
  const teardown = (): void => {
    for (const step of undo.reverse()) step();
    undo.length = 0;
    active = false;
  };
  try {
    const hostTheme = themeHost(el);
    hostTheme.set(ctx.theme);
    undo.push(hostTheme.undo);
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    undo.push(adoptStyles(shadow, await fetchStyles(STYLESHEET)));

    const container = document.createElement('div');
    container.className = 'cardtable-embed';
    shadow.append(container);
    undo.push(() => container.remove());

    undo.push(setDocumentScope(shadow));
    undo.push(routeInMemory({ kind: 'lobby' }));
    undo.push(followHashLinks(shadow));

    const root = createRoot(container);
    const render = (next: GameBundleContext): void =>
      root.render(
        <StrictMode>
          <EmbedApp ctx={next} />
        </StrictMode>,
      );
    undo.push(() => root.unmount());
    render(ctx);

    let mounted = true;
    return {
      update: (next) => {
        if (!mounted) return;
        hostTheme.set(next.theme);
        render(next);
      },
      unmount: () => {
        if (!mounted) return;
        mounted = false;
        teardown();
      },
    };
  } catch (err) {
    teardown();
    throw err;
  }
}

export const mount: GameBundleModule['mount'] = mountCardtable;
