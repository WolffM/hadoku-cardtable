/*
 * The lobby's way to `#/inventory` (AF305 §B) — ported from `DecksButton.tsx`,
 * beside it. `.ct-round-button` is `chrome/chrome.css`'s own (a global
 * sheet), so unlike `DecksButton.tsx` this imports no screen stylesheet of
 * its own: `css-ownership.test.ts`'s shared-stylesheet guard already lists
 * `DecksScreen.css` as an accepted two-tree sheet, but `InventoryScreen.css`
 * is not on that list (another lane holds `select-forge-tests.ts` right
 * now), and this button draws nothing that needs it.
 */

import { Icon } from '@wolffm/themes';

import { routeHash } from './route.ts';
import { uiLength } from '../settings/ui-scale.ts';

export function InventoryButton() {
  return (
    <a className="ct-round-button" href={routeHash({ kind: 'inventory' })} aria-label="Inventory" title="Inventory" data-testid="lobby-inventory">
      <Icon name="package" size={uiLength('1.1rem')} />
    </a>
  );
}
