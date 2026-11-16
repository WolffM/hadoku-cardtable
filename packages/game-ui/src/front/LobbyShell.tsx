/*
 * The front page's own shell: nav tools, an optional banner, the room list, and an optional
 * footer (a licensing disclaimer, today) — lifted from `apps/ui/src/screens/LobbyScreen.tsx`
 * (wave 119 §U.3, "the front page is a reusable module"). Every slot is a plain `ReactNode`;
 * `undefined` renders nothing, so a caller with no banner (bomberman's front page, the operator's
 * own words: "Bomberman's front page will be this module with no banner") gets none of its
 * markup, not an empty wrapper.
 *
 * Platform: knows no game's own banner, nav buttons or room list — `LobbyScreen.tsx` still
 * assembles those (`Banner`, `DecksButton`/`InventoryButton`/`StatsButton`, `RoomList`, the Fan
 * Content Policy line) and hands them in as children/props. What stays here is what was already
 * game-agnostic: the shell chrome, the page-reveal gate (`./gate.ts`) and the trim-loaded settle.
 *
 * `LobbyScreen.tsx`'s own DOM is unchanged by this lift: it still always passes a `navTools` and
 * a `disclaimer`, so its rendered markup is the same `<nav>`/`<p className="shell__disclaimer">`
 * it always drew (this lane's closing note has the render diff). A caller that omits either slot
 * is the new behaviour this module exists to offer.
 */

import { useEffect, type ReactNode } from 'react';

import { FrontGateContext, useFrontGateState } from './gate.ts';
import { useSiteTrim } from '../settings/siteTrim.ts';
import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';

export interface LobbyShellProps {
  /** The header's own tools row (settings, decks, stats, …) — omitted renders no `<nav>` at all. */
  navTools?: ReactNode;
  /** A Twitch-like banner above the room list — omitted draws none of its markup. */
  banner?: ReactNode;
  /** The room list itself (create + list), or whatever else a caller puts in the page's main slot. */
  children: ReactNode;
  /** A footer line under the page's own scroll (a licensing disclaimer, today) — omitted draws none. */
  disclaimer?: ReactNode;
}

export function LobbyShell({ navTools, banner, children, disclaimer }: LobbyShellProps) {
  const shellRef = useChromeShell('fit');
  const gate = useFrontGateState();
  const trimLoaded = useSiteTrim().loaded;
  const { settle } = gate;
  useEffect(() => {
    if (trimLoaded) settle('trim');
  }, [trimLoaded, settle]);
  return (
    <div ref={shellRef} className="shell shell--fit" data-testid="lobby">
      {navTools !== undefined && <nav className="shell__tools">{navTools}</nav>}
      <FrontGateContext.Provider value={gate}>
        <main className="front" aria-busy={!gate.revealed}>
          {banner}
          {children}
        </main>
      </FrontGateContext.Provider>
      {disclaimer !== undefined && <p className="shell__disclaimer">{disclaimer}</p>}
    </div>
  );
}
