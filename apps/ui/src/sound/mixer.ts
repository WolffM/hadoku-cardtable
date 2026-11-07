/*
 * `mixer.ts` moved to `@hadoku/ui-shell/sound` (w92-C). See `./mix.ts` for why
 * this stub also configures the package's role registry: `SoundSandbox.tsx`,
 * `SoundBuilder.tsx` and `MusicReview.tsx` import `createMixer` from here
 * without importing `./mix.ts`.
 */
import { FALLBACK_ROLES, REVERSED_ROLES, SOUND_ROLES } from '@hadoku/shared';
import { configureSoundRoles } from '@hadoku/ui-shell/sound';

configureSoundRoles({ roles: SOUND_ROLES, fallback: FALLBACK_ROLES, reversed: REVERSED_ROLES });

export * from '@hadoku/ui-shell/sound';
