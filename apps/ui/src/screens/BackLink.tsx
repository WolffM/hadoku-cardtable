/* A page's way back: the arrow alone, named for where it goes. Every page head draws this one. */

import { navigate, routeHash, type Route } from './route.ts';

export function BackLink({ to, label, testId }: { to: Route; label: string; testId: string }) {
  return (
    <a
      className="back-link"
      href={routeHash(to)}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      ←
    </a>
  );
}
