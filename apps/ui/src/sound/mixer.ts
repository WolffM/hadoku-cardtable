// `mixer.ts` moved to `@hadoku/ui-shell/sound` (w92-C); this import's side effect (`./mix.ts` configures the registry) covers `SoundSandbox.tsx`/`SoundBuilder.tsx`/`MusicReview.tsx`, which import `createMixer` from here without importing `./mix.ts` themselves.
import './mix.ts';

export * from '@hadoku/ui-shell/sound';
