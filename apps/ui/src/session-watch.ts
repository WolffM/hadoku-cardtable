/**
 * The page's session watch (`@hadoku/ui-shell/session`) over this app's base, standalone and in the
 * embed alike: a 401 from the edge under `/cardtable/`, or a socket the edge will not let back in,
 * is checked against the server's `/api/whoami`, and a lost session stops every socket and request
 * and reloads the page through the edge's sign-in wall.
 */
import { startSessionWatch, type SessionWatch } from '@hadoku/ui-shell/session';
import { apiUrl, appBase } from '@hadoku/game-ui/http.ts';

export function watchSession(): SessionWatch {
  return startSessionWatch({ scope: appBase(), probeUrl: apiUrl('whoami') });
}
