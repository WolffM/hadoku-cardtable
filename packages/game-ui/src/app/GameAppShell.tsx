/*
 * A game's standalone page frame: everything a game's `App.tsx` would otherwise copy.
 *
 * Three things resolve ONCE, here, and are handed down:
 *
 *   the theme      `<HadokuThemeRoot>` owns the theme, its persistence and the picker. A game adds no
 *                  `useTheme` of its own: the fleet's apps each carried a copy once, and they drifted
 *                  into real bugs.
 *   the identity   one `/session/whoami` (`../room/whoami.ts`), handed to every `useWhoami` below
 *                  through `WhoProvider`: the header's settings popout (`GameHeader`) and the room
 *                  chrome (`../room/RoomShell.tsx`) read the same answer.
 *   the platform   `usePlatform`'s `narrow` and `touchFirst`, rendered as `data-narrow` /
 *                  `data-touch-first` on the `<main>` from the first paint, so the game's CSS keys
 *                  off the same source as its JS. (`usePlatform` stamps them itself, but in an effect
 *                  that runs on a change, and on the first render the `<main>` does not exist yet:
 *                  the skeleton holds the theme's first resolve. On a phone the stamp found no element
 *                  and never came back.)
 *
 * The skeleton holds the page through the theme's first resolve, so it never flashes the wrong
 * palette. Inside, the game lays out its own column: `children` is called with what was resolved.
 *
 * This is the standalone page only. Embedded in a host's page the room and the theme are the host's,
 * and a game draws none of this (`@hadoku/ui-shell/embed`'s `mountEmbed`).
 */

import { lazy, Suspense, useRef, type ReactNode, type RefObject } from 'react';
import { AppHeader, LoadingSkeleton, type AppHeaderProps } from '@wolffm/task-ui-components';
import { HadokuThemeRoot, useHadokuTheme, usePlatform } from '@wolffm/themes';

import { useResolvedWhoami, useWhoami, WhoProvider, type Who } from '../room/whoami.ts';

/** What the frame resolved, for the game's own layout. */
export interface GameShell {
  /** The viewer, or null while asked and when the fleet could not say. */
  who: Who | null;
  narrow: boolean;
  touchFirst: boolean;
  isDarkTheme: boolean;
}

export interface GameAppShellProps {
  /** The `<main>`'s class: the game's own container (`bomberman-container`). */
  className: string;
  children: (shell: GameShell) => ReactNode;
}

export function GameAppShell(props: GameAppShellProps) {
  const containerRef = useRef<HTMLElement>(null);
  return (
    <HadokuThemeRoot containerRef={containerRef}>
      <ShellInner containerRef={containerRef} {...props} />
    </HadokuThemeRoot>
  );
}

function ShellInner({ containerRef, className, children }: GameAppShellProps & { containerRef: RefObject<HTMLElement | null> }) {
  const { isDarkTheme, isThemeReady, isInitialThemeLoad } = useHadokuTheme();
  const { narrow, touchFirst } = usePlatform({ containerRef });
  const who = useResolvedWhoami();

  if (isInitialThemeLoad && !isThemeReady) return <LoadingSkeleton isDarkTheme={isDarkTheme} />;

  return (
    <WhoProvider who={who}>
      <main
        ref={containerRef}
        className={className}
        data-dark-theme={isDarkTheme ? 'true' : 'false'}
        data-narrow={narrow ? '' : undefined}
        data-touch-first={touchFirst ? '' : undefined}
      >
        {children({ who: who === 'pending' ? null : who, narrow, touchFirst, isDarkTheme })}
      </main>
    </WhoProvider>
  );
}

/**
 * The fleet's `<AppHeader>`, handed the identity the page already resolved, so the settings popout
 * does not fetch whoami a second time. An identity HINT, never a way to present a tier the edge did
 * not assign: every gate that matters is enforced server-side off the edge-stamped tier.
 */
export function GameHeader({ children, appTabs, ...props }: Omit<AppHeaderProps, 'settingsProps'>) {
  const who = useWhoami();
  const viewer = who === 'pending' ? null : who;
  // The room chat's sound switch goes beside the game's own sound settings when it has a Sound tab,
  // else in the App tab: never a tab of its own for one row.
  const soundTab = appTabs?.some((t) => t.id === SOUND_TAB_ID) ?? false;
  return (
    <AppHeader
      {...props}
      settingsProps={viewer === null ? undefined : { userType: viewer.tier, name: viewer.name }}
      appTabs={soundTab ? appTabs!.map((t) => (t.id === SOUND_TAB_ID ? { ...t, render: () => <>{t.render()}{chatSound}</> } : t)) : appTabs}
      // Passed only when it holds something: any `children` at all draws an App tab.
      children={soundTab ? children : <>{children}{chatSound}</>}
    />
  );
}

/** The `appTabs` id `GameHeader` adds the chat sound switch to. */
export const SOUND_TAB_ID = 'sound';

/**
 * The room chat's "Chat sound" on/off (watchparty's chime after a quiet minute). It is watchparty's,
 * from the same room-chrome module `RoomShell` loads, so it writes the store that chrome's chime
 * reads. Lazy: the popout renders a tab only while it is open, so the chunk is fetched then (and
 * usually already is, for the room).
 */
const ChatSoundSetting = lazy(() =>
  import('@wolffm/watchparty-ui/room-chrome').then((m) => ({ default: m.ChatSoundSetting })),
);
const chatSound = (
  <Suspense fallback={null}>
    <ChatSoundSetting />
  </Suspense>
);
