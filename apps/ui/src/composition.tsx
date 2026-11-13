/* The game's parts, handed to the generic files that draw them: once per composition root (`./App.tsx`, `./embed/EmbedApp.tsx`), and in `./test-setup.ts`. */
import { RallyCatalogueSchema, RallyViewSchema } from '@hadoku/shared';
// Bomberman's own room UI (`rooms/games/bomberman.tsx`) registers itself at module scope the
// moment it is imported, unlike everything below, which `composeGame()` wires explicitly — so a
// side-effect import is this file's whole job for it.
import './rooms/games/bomberman.tsx';
import { registerPlayerMark } from '@hadoku/game-ui/components/Avatar.tsx';
import { forgetCardWidths } from '@hadoku/magic-ui/play/card-size.ts';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS } from '@hadoku/magic-ui/play/live/prefs.ts';
import { PlayerMark } from '@hadoku/magic-ui/play/marks.tsx';
import { registerEmbedAddress } from '@hadoku/game-ui/screens/route.ts';
import { ExperimentalSettings, GameSettings, MatchSettings } from '@hadoku/magic-ui/settings/GameSettings.tsx';
import { registerSettings } from '@hadoku/game-ui/settings/Settings.tsx';
import { SoundSettings } from '@hadoku/magic-ui/settings/SoundSettings.tsx';
import { soundsClient, type SoundsClient } from '@hadoku/magic-ui/sound/builderClient.ts';
import { registerSound } from '@hadoku/game-ui/sound/index.ts';
import { SOUND_REGISTRY } from '@hadoku/magic-ui/sound/registry.ts';

const GameTab = () => (<><GameSettings /><MatchSettings /><ExperimentalSettings /></>);

export function composeGame(): void {
  registerSettings({ Game: GameTab, Sound: SoundSettings, prefs: getPlayPrefsClient, defaultScale: PLAY_PREFS_DEFAULTS.uiScale, onScaled: forgetCardWidths });
  registerPlayerMark(PlayerMark);
  registerEmbedAddress((catalogue, view) => RallyCatalogueSchema.safeParse(catalogue).success && RallyViewSchema.safeParse(view).success);
  // Built on first play, like the mixer itself. `ui.*` roles logged one by one as they sound stay out of the interface tally.
  let client: SoundsClient | undefined;
  const sounds = (): SoundsClient => (client ??= soundsClient());
  registerSound({
    registry: SOUND_REGISTRY,
    individuallyLogged: new Set(['ui.pass', 'ui.prompt', 'ui.priority']),
    client: { takeUrl: (file, version) => sounds().takeUrl(file, version), loadAssignments: () => sounds().assignments(), loadPack: (pack) => sounds().pack(pack) },
  });
}
