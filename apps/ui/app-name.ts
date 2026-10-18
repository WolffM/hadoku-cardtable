import { labelFor } from '@wolffm/catalogue';

/**
 * THE APP'S ID — the one identifier this repo states about itself. The display
 * NAME is looked up from it, so the two can never disagree. Must match the `id`
 * in hadoku_site's spec/categories.json (`cardtable`).
 */
export const APP_ID = 'cardtable';

/**
 * The display name, resolved at CONFIG TIME (this runs in node).
 *
 * Reaches the bundle through build-defines.ts, which every build and the root
 * vitest.config.ts share: `define` is a build-time substitution, so a run that
 * does not declare it hits a bare ReferenceError and the component renders
 * NOTHING — an unrelated-looking "unable to find element" failure, not a
 * missing constant.
 *
 * The `?? APP_ID` fallback is for a catalogue release that does not know this
 * app yet; it is a lowercase id, visibly wrong, on purpose.
 */
export const APP_NAME = labelFor(APP_ID) ?? APP_ID;
