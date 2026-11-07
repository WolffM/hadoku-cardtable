// Moved to `@hadoku/ui-shell/chrome/shell` (wave 92 §A): its own subpath, not `./chrome`, so reading
// `useChromeShell` never evaluates `AppChrome.tsx` (and its CSS) — several screens need only this.
export * from '@hadoku/ui-shell/chrome/shell';
