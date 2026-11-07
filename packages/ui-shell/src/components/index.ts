/*
 * Generic components any game's UI keeps. `Modal` stays in cardtable this wave: it portals through
 * `OverPage.tsx` (the chrome-root-or-body choice, shadow-root-aware via `apps/ui/src/dom.ts`), and
 * neither file is this wave's to move — both have outside importers (`Popover.tsx`, `RoomList.tsx`,
 * `DeckPeek.tsx`, and the embed mount) this lane does not own. Reported, not guessed around.
 */
export { Reveal, REVEAL_MS, type RevealProps } from './Reveal.tsx';
