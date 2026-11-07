/*
 * Cardtable's stylesheet, inside a shadow root.
 *
 * The embed build (`../../vite.embed.config.ts`) emits every sheet the app
 * imports as ONE file, `embed/cardtable-embed.css`, with `:root`, `html` and
 * `body` already rewritten to `:host` — none of the three exists inside a
 * shadow tree, and the theme tokens and the table palette are declared on
 * `:root`. What cannot be fixed at build time is fixed here:
 *
 * - **`@font-face` and `@property` are ignored inside a shadow root** (Chromium
 *   registers neither from a shadow-scoped sheet), so the Mana and Keyrune
 *   glyph fonts and the shimmer's `@property` would silently not exist. They
 *   are lifted into a sheet adopted by the DOCUMENT for the life of the mount.
 *   Both are keyed by a name only cardtable uses, so they cannot restyle the
 *   page they are lent to.
 * - Everything else is adopted by the shadow root alone, so nothing of ours
 *   reaches watchparty's page and nothing of theirs reaches the table except
 *   what CSS inherits across the boundary (custom properties, font, colour).
 */

/** Rules a shadow-scoped sheet does not register; they live on the document while mounted. */
function documentOnly(rule: CSSRule): boolean {
  return rule.cssText.startsWith('@font-face') || rule.cssText.startsWith('@property');
}

/** Split `css` into the shadow root's sheet and the document's, and adopt both. Returns the undo. */
export function adoptStyles(shadow: ShadowRoot, css: string): () => void {
  const scoped = new CSSStyleSheet();
  scoped.replaceSync(css);
  const page = new CSSStyleSheet();
  for (let i = scoped.cssRules.length - 1; i >= 0; i -= 1) {
    const rule = scoped.cssRules[i]!;
    if (!documentOnly(rule)) continue;
    page.insertRule(rule.cssText, 0);
    scoped.deleteRule(i);
  }
  shadow.adoptedStyleSheets = [scoped];
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, page];
  return () => {
    shadow.adoptedStyleSheets = [];
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== page);
  };
}

/** The embed's stylesheet text. A failure is the mount's failure: a table with no styles is not a table. */
export async function fetchStyles(href: string): Promise<string> {
  const res = await fetch(href, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`cardtable embed: ${href} answered ${res.status}`);
  return res.text();
}
