/* A page's way back: the arrow alone, named for where it goes. Every page head draws this one. */

import type { AnchorHTMLAttributes } from 'react';

import { navigate, routeHash, type Route } from '@hadoku/game-ui/screens/route.ts';

/**
 * A link to one of the app's routes. Pressing it navigates rather than leaving the browser to
 * follow its hash: a room's page lives at a path, and on that path `#/` names nothing, so the
 * lobby's own hash would leave the route on the room.
 */
export function RouteLink({ to, ...anchor }: { to: Route } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  return (
    <a
      {...anchor}
      href={routeHash(to)}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export function BackLink({ to, label, testId }: { to: Route; label: string; testId: string }) {
  return (
    <RouteLink className="back-link" to={to} aria-label={label} title={label} data-testid={testId}>
      ←
    </RouteLink>
  );
}
