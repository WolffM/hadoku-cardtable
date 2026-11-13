/*
 * Cardtable's sound roles (`SOUND_ROLES`, `@hadoku/shared`) as the package's mixer reads them, and
 * the one place they are handed to it. `sound/index.ts` passes this to `createSound`. It is also
 * registered as an import side effect for `SoundSandbox.tsx`, which plays role events through a
 * mixer built on the package's zero-argument default planner, outside `createSound`. The other
 * screens that build a bare mixer (`SoundBuilder.tsx`, `MusicReview.tsx`) only play files by name,
 * which reads no role, so they need no registry.
 */
import { FALLBACK_ROLES, REVERSED_ROLES, SOUND_ROLES } from '@hadoku/shared';
import { configureSoundRoles, type RoleRegistry } from '@hadoku/ui-shell/sound';

export const SOUND_REGISTRY: RoleRegistry = { roles: SOUND_ROLES, fallback: FALLBACK_ROLES, reversed: REVERSED_ROLES };

configureSoundRoles(SOUND_REGISTRY);
