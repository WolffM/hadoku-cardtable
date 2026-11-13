/* A page the lobby opens (Decks, Inventory, Stats): its way home, its name and what follows it, its tools at the right end. */

import type { ReactNode } from 'react';

import { BackLink } from './BackLink.tsx';
import { SettingsGear } from '@hadoku/game-ui/settings/Settings.tsx';

export function HomeHead({ title, children, tools }: { title: string; children?: ReactNode; tools?: ReactNode }) {
  return (
    <header className="shell__head">
      <BackLink to={{ kind: 'lobby' }} label="Lobby" testId="back-to-lobby" />
      <h1 className="shell__title">{title}</h1>
      {children}
      <div className="shell__tools">
        {tools}
        <SettingsGear />
      </div>
    </header>
  );
}
