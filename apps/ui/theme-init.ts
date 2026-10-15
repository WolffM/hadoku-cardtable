import { THEME_FAMILIES } from '@wolffm/themes';

/**
 * The theme, before the first paint.
 *
 * The stylesheet resolves every colour against `<html data-theme>`, and
 * `@wolffm/themes`' provider only sets it once the bundle has mounted. Until
 * then `:root` reads the light defaults, so a dark theme painted white first
 * and then swapped — the flash on load. This script runs in `<head>`, ahead of
 * the stylesheet, and seeds the attribute the way the provider's own
 * `seedTheme` does: this tab's choice, then this browser's, then the system
 * preference. A bare family name the hadoku.me host may store (`coffee`) takes
 * the variant the system preference picks, and a name that is no theme is
 * ignored rather than painted.
 *
 * Built at CONFIG TIME (like ./app-name.ts) from the package's own theme list,
 * so a family added there is known here without a copy to keep in step.
 */
export function themeInitScript(): string {
  const families = THEME_FAMILIES.map((f) => [f.lightTheme, f.darkTheme]);
  return `(function () {
  var families = ${JSON.stringify(families)};
  var dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function resolve(value) {
    var raw = (value || '').trim();
    for (var i = 0; i < families.length; i++) {
      var f = families[i];
      if (raw === f[0] || raw === f[1]) return raw;
      if (raw && raw + '-light' === f[0]) return dark ? f[1] : f[0];
    }
    return null;
  }
  var stored = null;
  try {
    stored = resolve(sessionStorage.getItem('hadoku-theme')) || resolve(localStorage.getItem('hadoku-theme'));
  } catch (err) {
    console.warn('[theme-init] storage unavailable', err);
  }
  document.documentElement.setAttribute('data-theme', stored || (dark ? 'dark' : 'light'));
})();`;
}
