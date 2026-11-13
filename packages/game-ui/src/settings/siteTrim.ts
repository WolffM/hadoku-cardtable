/*
 * The site's trim store, moved to `@hadoku/ui-shell/trim` (wave 92 §A): game-neutral apart from where
 * the server lives, which this file wires once, before anything below here renders — every importer
 * of this path (`screens/LobbyScreen.tsx`, `embed/EmbedApp.tsx`) keeps the same names and signatures.
 */
import { apiUrl } from '../http.ts';
import { configureSiteTrim, knownTrim, resetSiteTrimForTests, saveSiteTrim, useSiteTrim, useTrim, type SiteTrim } from '@hadoku/ui-shell/trim';

configureSiteTrim({ apiUrl: apiUrl('trim') });

export { knownTrim, resetSiteTrimForTests, saveSiteTrim, useSiteTrim, useTrim };
export type { SiteTrim };
