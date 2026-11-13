/* The lobby's way to `#/decks`, beside the trophy (operator, 2026-10-19: "a new button next to leaderboard on the first page"). */

import { Icon } from '@wolffm/themes';

import { routeHash } from '@hadoku/game-ui/screens/route.ts';
import './DecksScreen.css';
import { uiLength } from '@hadoku/ui-shell/settings';

export function DecksButton() {
  return (
    <a className="ct-round-button" href={routeHash({ kind: 'decks' })} aria-label="Decks" title="Decks" data-testid="lobby-decks">
      <Icon name="layers" size={uiLength('1.1rem')} />
    </a>
  );
}
