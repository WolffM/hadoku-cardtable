/**
 * Filled by the vite `define` from the catalogue (see ../app-name.ts): by the
 * time this reaches the browser it is a string, and this declare exists so the
 * source typechecks. The root vitest.config.ts defines it too, or a test that
 * renders the app hits a bare ReferenceError that looks like anything but.
 */
declare const __HADOKU_APP_NAME__: string;
/** apps/ui/package.json's version at build time (vite.config.ts), reported in a seat's `info` telemetry. */
declare const __HADOKU_UI_VERSION__: string;
