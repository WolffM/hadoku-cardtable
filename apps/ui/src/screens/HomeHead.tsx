/* A page the lobby opens (Decks, Inventory): its way home, its name, its tools at the right end. */

import { BackLink } from './BackLink.tsx';
import { SettingsGear } from '../settings/Settings.tsx';

export function HomeHead({ title }: { title: string }) {
  return (
    <header className="shell__head">
      <BackLink to={{ kind: 'lobby' }} label="Lobby" testId="back-to-lobby" />
      <h1 className="shell__title">{title}</h1>
      <div className="shell__tools">
        <SettingsGear />
      </div>
    </header>
  );
}
