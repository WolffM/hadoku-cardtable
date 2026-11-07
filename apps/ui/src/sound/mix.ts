/*
 * `mix.ts` moved to `@hadoku/ui-shell/sound` (w92-C): the planner is generic
 * over an injected role registry now, and holds no role names of its own.
 *
 * A few screens (`SoundSandbox.tsx`, `SoundBuilder.tsx`, `MusicReview.tsx`)
 * build a mixer through `createMixer`'s zero-argument default planner, which
 * the package can no longer fill in with this game's roles by itself. This
 * import's own side effect — evaluated before anything importing this file
 * runs — gives it cardtable's registry, so every call site that leaned on
 * the default keeps working unedited.
 */
import { FALLBACK_ROLES, REVERSED_ROLES, SOUND_ROLES } from '@hadoku/shared';
import { configureSoundRoles } from '@hadoku/ui-shell/sound';

configureSoundRoles({ roles: SOUND_ROLES, fallback: FALLBACK_ROLES, reversed: REVERSED_ROLES });

export * from '@hadoku/ui-shell/sound';
