import { APP_NAME } from './app-name.js';
import pkg from './package.json' with { type: 'json' };

/**
 * Every build-time global the UI source reads, in ONE place. `define` is a
 * textual substitution, so a build that leaves one out ships the bare
 * identifier and the browser throws a ReferenceError where it is read — the
 * embed build once lacked `__HADOKU_UI_VERSION__`, and LiveBoard's mount effect
 * threw in watchparty: the match screen unmounted 100 ms after joining and
 * left only the chat. vite.config.ts, vite.embed.config.ts and the root
 * vitest.config.ts all spread this; `src/globals.d.ts` declares the same names,
 * and `src/globals.test.ts` holds the two lists equal.
 *
 * A define lands in the browser bundle, so what goes in must be PUBLIC data.
 */
export const BUILD_DEFINES = {
  /** The catalogue's display name for this app (see app-name.ts). */
  __HADOKU_APP_NAME__: JSON.stringify(APP_NAME),
  /**
   * apps/ui/package.json's version, reported in a seat's `info` telemetry: the
   * one fact that tells a stale tab from a regression when a player reports an
   * animation the deploy had replaced.
   */
  __HADOKU_UI_VERSION__: JSON.stringify(pkg.version),
};
