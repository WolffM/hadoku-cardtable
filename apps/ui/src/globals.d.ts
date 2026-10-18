/**
 * Build-time globals: each is a `define` in ../build-defines.ts, the one object
 * the app build, the embed build and the root vitest config all use. These
 * declares exist so the source typechecks; `globals.test.ts` fails if a name
 * here is missing from any of those builds.
 */
/** The catalogue's display name (../app-name.ts). */
declare const __HADOKU_APP_NAME__: string;
/** apps/ui/package.json's version at build time, reported in a seat's `info` telemetry. */
declare const __HADOKU_UI_VERSION__: string;
