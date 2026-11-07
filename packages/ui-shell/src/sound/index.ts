/*
 * The generic sound mixer — WebAudio playback, the mix planner, the mute
 * store, the queue's mechanics and the gain slider, re-exported below, no
 * role names among them (`./mix.ts`'s header says why) — plus
 * `createSound<R>`, which a game wires its own role registry and server
 * client into: `R` outside it is a compile error on `playRole`; a role the
 * registry does not hold plays nothing at runtime regardless — the
 * planner's own `unknown-role` skip, never re-checked here.
 */

export * from './mix.ts';
export * from './mixer.ts';
export * from './mute.ts';
export * from './queue.ts';
export { GainSlider, type GainSliderProps } from './GainSlider.tsx';

import { configureSoundRoles, type RoleRegistry, type SoundEvent } from './mix.ts';
import { createMixer, type Mixer, type MusicChoice } from './mixer.ts';
import { getLevel, getMusicPick, isMuted, subscribeSound } from './mute.ts';

export interface RolePlayer {
  play(event: SoundEvent): unknown;
  loop?(role: MusicChoice, pick?: (role: string) => string | null): void;
  nowPlaying?(): { role: string; file: string } | null;
  /** A cell's takes, as assigned. */
  takes?(cell: string): readonly string[];
}

/** What loops now, and every track its role could play instead: sound settings' track picker. */
export interface MusicTrack {
  role: string;
  file: string;
  tracks: readonly { file: string; name: string }[];
}

/** A sound event that starts a little after the moment it belongs to. */
export interface DelayedSoundEvent extends SoundEvent {
  delayMs?: number;
}

/** What a game's server answers for role-cell assignments: cells, gains, music-take names, `takeUrl`-pinning versions, and the cue pack's version (empty: no cues). */
export interface SoundAssignments {
  cells: Readonly<Record<string, readonly string[]>>;
  gains: Readonly<Record<string, number>>;
  names: Readonly<Record<string, string>>;
  versions: Readonly<Record<string, string>>;
  pack: string;
}

/** What `createSound` needs from the game's server. */
export interface SoundClient {
  takeUrl(file: string, version?: string): string;
  loadAssignments(): Promise<SoundAssignments>;
  loadPack(pack: string): Promise<ReadonlyMap<string, ArrayBuffer> | undefined>;
}

export interface SoundConfig<R extends string> {
  registry: RoleRegistry;
  client: SoundClient;
  /** `ui`-bus roles already logged one by one elsewhere: left out of `takeUiTally`. Default: none. */
  individuallyLogged?: ReadonlySet<R>;
}

/** Where there is no WebAudio (jsdom, an old browser) nothing is built and nothing is fetched. */
const SILENT: RolePlayer = { play: () => undefined };

function hasWebAudio(): boolean {
  const g = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return g.AudioContext !== undefined || g.webkitAudioContext !== undefined;
}

/** A game's sound, wired to its own role registry and server client. */
export function createSound<R extends string>(config: SoundConfig<R>) {
  configureSoundRoles(config.registry);
  const { registry, client } = config;
  const individuallyLogged: ReadonlySet<R> = config.individuallyLogged ?? new Set<R>();

  let injected: RolePlayer | null = null;
  let production: Mixer | null = null;
  /** The screen's music (`null`: a silent screen), and the match's while one is on it. */
  let screenMusic: R | null = null;
  let matchMusic: readonly R[] | null = null;
  /** Holds out against a match's own sound: while any is held, its moments and music stay off, the page's `ui` cues still play. Never persisted. */
  let quietHolds = 0;
  let unsubscribeSound: (() => void) | null = null;
  let trackNames: Readonly<Record<string, string>> = {};
  let musicTrack: MusicTrack | null = null;
  const trackListeners = new Set<() => void>();
  const uiTally = new Map<string, number>();

  function setRolePlayer(player: RolePlayer | null): void {
    injected = player;
  }

  function resetRolePlayerForTests(): void {
    injected = null;
    production = null;
    screenMusic = null;
    matchMusic = null;
    quietHolds = 0;
    trackNames = {};
    musicTrack = null;
    trackListeners.clear();
    uiTally.clear();
    unsubscribeSound?.();
    unsubscribeSound = null;
  }

  function player(): RolePlayer {
    if (injected !== null) return injected;
    if (production === null) {
      if (!hasWebAudio()) return SILENT;
      let versions: Readonly<Record<string, string>> = {};
      const mixer = createMixer((f) => client.takeUrl(f, versions[f]));
      production = mixer;
      applyLevels();
      unsubscribeSound ??= subscribeSound(applyPrefs);
      void client.loadAssignments().then(async (a) => {
        versions = a.versions;
        mixer.planner.setAssignments(a.cells, a.gains);
        setTrackNames(a.names);
        applyMusic();
        mixer.preload(await client.loadPack(a.pack));
      });
    }
    return production;
  }

  function takeUiTally(): Record<string, number> {
    const out = Object.fromEntries(uiTally);
    uiTally.clear();
    return out;
  }

  function playEvent(event: SoundEvent): void {
    if (registry.roles.get(event.role)?.bus === 'ui' && !individuallyLogged.has(event.role as R)) {
      uiTally.set(event.role, (uiTally.get(event.role) ?? 0) + 1);
    }
    try {
      if (isMuted()) return;
      player().play(event);
    } catch {
      // Sound is decoration. Nothing it does is worth breaking a click over.
    }
  }

  function holdMatchQuiet(): () => void {
    quietHolds += 1;
    applyMusic();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      quietHolds -= 1;
      applyMusic();
    };
  }

  function playRole(role: R): void {
    if (quietHolds > 0 && registry.roles.get(role)?.bus !== 'ui') return;
    playEvent({ role });
  }

  function playSoundEvents(events: readonly DelayedSoundEvent[]): void {
    if (quietHolds > 0) return;
    for (const { delayMs, ...event } of events) {
      if (delayMs === undefined || delayMs <= 0) playEvent(event);
      else setTimeout(() => playEvent(event), delayMs);
    }
  }

  function applyLevels(): void {
    production?.setLevels({ volume: getLevel('volume'), music: getLevel('music') });
  }

  function applyPrefs(): void {
    applyLevels();
    applyMusic();
  }

  function applyMusic(): void {
    try {
      const wanted = screenMusic === null ? null : ((quietHolds > 0 ? null : matchMusic) ?? screenMusic);
      const p = player();
      p.loop?.(isMuted() ? null : wanted, getMusicPick);
      publishTrack(p);
    } catch {
      // Music is decoration too.
    }
  }

  function publishTrack(p: RolePlayer): void {
    const now = p.nowPlaying?.() ?? null;
    const files = now === null ? [] : (p.takes?.(`${now.role}|play`) ?? [now.file]);
    const next: MusicTrack | null =
      now === null ? null : { ...now, tracks: files.map((file) => ({ file, name: trackNames[file] ?? file.split('/')[0]! })) };
    const same =
      next === musicTrack ||
      (next !== null &&
        musicTrack !== null &&
        next.role === musicTrack.role &&
        next.file === musicTrack.file &&
        next.tracks.length === musicTrack.tracks.length &&
        next.tracks.every((t, i) => t.file === musicTrack!.tracks[i]!.file && t.name === musicTrack!.tracks[i]!.name));
    if (same) return;
    musicTrack = next;
    for (const fn of trackListeners) fn();
  }

  function setTrackNames(names: Readonly<Record<string, string>>): void {
    trackNames = names;
    if (production !== null || injected !== null) publishTrack(player());
  }

  function getMusicTrack(): MusicTrack | null {
    return musicTrack;
  }

  function subscribeMusicTrack(fn: () => void): () => void {
    trackListeners.add(fn);
    return () => {
      trackListeners.delete(fn);
    };
  }

  function setScreenMusic(role: R | null): void {
    screenMusic = role;
    unsubscribeSound ??= subscribeSound(applyPrefs);
    applyMusic();
  }

  function setMatchMusic(roles: readonly R[] | null): void {
    matchMusic = roles;
    applyMusic();
  }

  const handlers = new Map<R, () => void>();

  function roleHandler(role: R): () => void {
    const existing = handlers.get(role);
    if (existing !== undefined) return existing;
    const fn = (): void => playRole(role);
    handlers.set(role, fn);
    return fn;
  }

  return {
    setRolePlayer,
    resetRolePlayerForTests,
    takeUiTally,
    holdMatchQuiet,
    playRole,
    playSoundEvents,
    setTrackNames,
    getMusicTrack,
    subscribeMusicTrack,
    setScreenMusic,
    setMatchMusic,
    roleHandler,
  };
}
