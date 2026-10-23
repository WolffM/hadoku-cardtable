/* A page the lobby opens (Decks, Inventory): its way home, its name, its tools at the right end. */

import { navigate, routeHash } from './route.ts';
import { SettingsGear } from '../settings/Settings.tsx';

export function HomeHead({ title }: { title: string }) {
  return (
    <header className="shell__head">
      <a
        className="shell__link shell__back"
        href={routeHash({ kind: 'lobby' })}
        aria-label="Lobby"
        data-testid="back-to-lobby"
        onClick={(e) => {
          e.preventDefault();
          navigate({ kind: 'lobby' });
        }}
      >
        ←
      </a>
      <h1 className="shell__title">{title}</h1>
      <div className="shell__tools">
        <SettingsGear />
      </div>
    </header>
  );
}
