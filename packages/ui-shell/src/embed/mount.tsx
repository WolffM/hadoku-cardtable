/*
 * The game bundle a host page imports (`/<app>/embed/<app>-embed.js`): `mount(el, ctx)` draws the game
 * inside a shadow root on `el` and hands back `{ update, unmount }` — `@wolffm/rooms-protocol`'s
 * `GameBundleModule`. Everything the standalone page gets from owning the document is set up here
 * instead, and taken down again by `unmount`, in reverse:
 *
 * - **Styles** — the one stylesheet the embed build emits (`./vite.ts`), fetched once and adopted by
 *   the shadow root (`./styles.ts`), after the frame's own `:host` rules ({@link HOST_CSS}) and with
 *   whatever the game adds (`extraCss`).
 * - **The theme on `el` itself** (`hostTheme`), before the styles land, so the host is painted in the
 *   host's theme rather than the light default (the build's `hostTheme` option themes `:host` from it).
 *   Restored on unmount.
 * - **The game's own page-wide state** (`setup`): its route in memory, its document scope, a socket.
 *   Each step hands back its undo through `cleanup`. A step that must run before EVERY render, outside
 *   React, is what `setup` returns: a child's effect can run before a parent's, so wiring a transport
 *   in an effect is too late.
 * - **Hash links** (`followHashLink`) — an `<a href="#/…">` inside the game would rewrite the host's
 *   address bar; a click on one is handed to the game's router instead.
 *
 * ## One mount per page
 *
 * A game's route and sockets are module singletons, exactly as they are standalone, where "one room
 * per page" already holds. A second concurrent mount is refused loudly rather than half-sharing the
 * first's.
 */

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { adoptStyles, fetchStyles } from './styles.ts';

/**
 * The frame's own rules, before the game's sheet: the host is the slot it was mounted in, and the
 * game fills it. A game adds what it needs on top (`:host { position: relative }`, say) in its sheet.
 */
export const HOST_CSS = ':host { display: block; height: 100%; min-height: 0; }';

/** What a mount hands `setup`. */
export interface EmbedSetup<Ctx> {
  el: HTMLElement;
  shadow: ShadowRoot;
  /** The React root's element, already in the shadow root. */
  container: HTMLElement;
  /** The context the mount was called with. */
  ctx: Ctx;
  /** Registers an undo; they run in reverse on unmount, after React has unmounted the game. */
  cleanup(undo: () => void): void;
}

export interface EmbedOptions<Ctx extends { theme: string }> {
  /** For the refusal of a second mount (`bomberman embed: already mounted …`). */
  name: string;
  /** The stylesheet's URL, beside the entry under the app's base. */
  stylesheet: string;
  /** More CSS for the shadow root, after the stylesheet (a sheet the game otherwise writes to the document). */
  extraCss?: () => string;
  /** The container's class. */
  containerClass: string;
  /** Called before the stylesheet is fetched: start fetching what the first render will need. */
  prefetch?: () => void;
  /** Put `ctx.theme` on the host element, and keep it there as `update` moves it. */
  hostTheme?: boolean;
  /** Hand a click on an in-game `#` link to the game's router, rather than to the host's address bar. */
  followHashLink?: (href: string) => void;
  /**
   * The game's page-wide state, set up before the first render. May return a step to run before every
   * render (the first and each `update`), outside React.
   */
  setup?: (env: EmbedSetup<Ctx>) => ((ctx: Ctx) => void) | void;
  /** The game, for a context. Wrapped in `<StrictMode>`. */
  render: (ctx: Ctx) => ReactNode;
}

export interface MountedEmbed<Ctx> {
  update(ctx: Ctx): void;
  unmount(): void;
}

/** Put `theme` on the host element. Returns the undo, which restores what was there. */
function themeHost(el: HTMLElement): { set: (theme: string) => void; undo: () => void } {
  const before = el.getAttribute('data-theme');
  return {
    set: (theme) => el.setAttribute('data-theme', theme),
    undo: () => (before === null ? el.removeAttribute('data-theme') : el.setAttribute('data-theme', before)),
  };
}

/** Hand a click on a `#` link inside `shadow` to `follow`. Returns the undo. */
function followHashLinks(shadow: ShadowRoot, follow: (href: string) => void): () => void {
  const onClick = (event: Event): void => {
    if (event.defaultPrevented) return;
    const link = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    const href = link?.getAttribute('href');
    if (href === undefined || href === null || !href.startsWith('#')) return;
    event.preventDefault();
    follow(href);
  };
  shadow.addEventListener('click', onClick);
  return () => shadow.removeEventListener('click', onClick);
}

/** A game's `mount`. Call once, at module level, and export it as `mount`. */
export function mountEmbed<Ctx extends { theme: string }>(options: EmbedOptions<Ctx>): (el: HTMLElement, ctx: Ctx) => Promise<MountedEmbed<Ctx>> {
  let active = false;
  return async (el, ctx) => {
    if (active) throw new Error(`${options.name} embed: already mounted on this page — unmount it before mounting again`);
    active = true;
    const undo: (() => void)[] = [];
    const teardown = (): void => {
      for (const step of undo.reverse()) step();
      undo.length = 0;
      active = false;
    };
    try {
      const hostTheme = options.hostTheme === true ? themeHost(el) : null;
      if (hostTheme !== null) {
        hostTheme.set(ctx.theme);
        undo.push(hostTheme.undo);
      }
      const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
      options.prefetch?.();
      const css = [HOST_CSS, await fetchStyles(options.stylesheet), options.extraCss?.() ?? ''].join('\n');
      undo.push(adoptStyles(shadow, css));

      const container = document.createElement('div');
      container.className = options.containerClass;
      shadow.append(container);
      undo.push(() => container.remove());

      const beforeRender = options.setup?.({ el, shadow, container, ctx, cleanup: (step) => undo.push(step) }) ?? undefined;
      if (options.followHashLink !== undefined) undo.push(followHashLinks(shadow, options.followHashLink));

      const root = createRoot(container);
      const render = (next: Ctx): void => {
        beforeRender?.(next);
        root.render(<StrictMode>{options.render(next)}</StrictMode>);
      };
      undo.push(() => root.unmount());
      render(ctx);

      let mounted = true;
      return {
        update: (next) => {
          if (!mounted) return;
          hostTheme?.set(next.theme);
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
  };
}
