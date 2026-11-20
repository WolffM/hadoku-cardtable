/*
 * The page layout with no top bar: Home, the theme picker, the settings and the page's links are in
 * the room chat's toolbar instead (watchparty's own, `RoomChrome`'s `toolbar`), and the screen takes
 * the whole height.
 *
 * A screen opts in by calling `useToolbarPage()`, or its route does (`toolbarRoute`); nothing else
 * about it changes. The page's two
 * halves read the same answer: `TopBar` (around the app's header) draws nothing, and `RoomShell`
 * hands the chrome `PAGE_TOOLBAR`. They are never both drawn — the toolbar's settings gear and the
 * header's are the same fleet control, and a page must mount one.
 *
 * Where no chat can draw (no room, or a viewer the fleet could not name) the top bar stays: it is
 * then the only way to those controls. With the chat hidden the chrome draws no toolbar either, only
 * its own Show chat button, which brings both back.
 *
 * The opt-in is taken in a layout effect and read through an external store, so the page is redrawn
 * before the browser paints: a screen's first frame already has no top bar.
 */
import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { RoomChromeToolbar } from '@wolffm/watchparty-ui/room-chrome';

import { navigate, type Route } from '../screens/route.ts';
import { CardtableSettings } from '../settings/Settings.tsx';
import { PAGE_LINKS } from './HeaderLinks.tsx';

let holders = 0;
let chatless = false;
const watchers = new Set<() => void>();

function changed(): void {
  for (const watcher of watchers) watcher();
}

function watch(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Whether the page is drawn without its top bar. */
export function toolbarPageOn(held: number, noChat: boolean): boolean {
  return held > 0 && !noChat;
}

/**
 * The routes that are toolbar pages whatever their screen has loaded: the game, a table's
 * full-screen step (the sideboard) and the deck builder. The operator, 2026-11-19: *"i wanted the
 * top bar to be gone when in: draft, sideboarding, playing the game, deck construction. only when
 * looking at the room or frontpage would i want the top bar to stay."* The draft is a room's state,
 * not a route, and asks from its screen.
 */
export function toolbarRoute(route: Route): boolean {
  return route.kind === 'match' || route.kind === 'deck' || (route.kind === 'room' && route.step !== undefined);
}

/** This screen is a toolbar page for as long as it is drawn with `on`. */
export function useToolbarPage(on = true): void {
  useLayoutEffect(() => {
    if (!on) return undefined;
    holders += 1;
    changed();
    return () => {
      holders -= 1;
      changed();
    };
  }, [on]);
}

/** `RoomShell`'s word on whether a chat can draw on this page at all. */
export function useChatless(noChat: boolean): void {
  useLayoutEffect(() => {
    if (chatless === noChat) return;
    chatless = noChat;
    changed();
  }, [noChat]);
}

/** True while a drawn screen has opted in and the chat can carry the toolbar. */
export function useToolbarPageOn(): boolean {
  return useSyncExternalStore(watch, () => toolbarPageOn(holders, chatless));
}

/** The app's header: not drawn on a toolbar page. */
export function TopBar({ children }: { children: ReactNode }) {
  return useToolbarPageOn() ? null : children;
}

/** What the chat toolbar carries for the page: the top bar's own Home, settings and links. */
export const PAGE_TOOLBAR: RoomChromeToolbar = {
  onHome: () => navigate({ kind: 'lobby' }),
  settings: { section: <CardtableSettings /> },
  extra: PAGE_LINKS,
};
