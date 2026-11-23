/* The lobby's way to `#/library`, beside the trophy: the decks, the cubes and the cards, one button (wave 125). */

import { Icon } from '@wolffm/themes';

import { routeHash } from '@hadoku/game-ui/screens/route.ts';
import './LibraryScreen.css';
import { uiLength } from '@hadoku/ui-shell/settings';

export function DecksButton() {
  return (
    <a className="ct-round-button" href={routeHash({ kind: 'library' })} aria-label="Library" title="Library" data-testid="lobby-library">
      <Icon name="layers" size={uiLength('1.1rem')} />
    </a>
  );
}
