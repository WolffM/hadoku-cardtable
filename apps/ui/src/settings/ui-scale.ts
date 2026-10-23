/*
 * The UI scale (the operator, 2026-10-21: "add a slider to allow scaling the size of the UI").
 *
 * ONE number, `--ui-scale`, and every length the app's own stylesheets author is a multiple of it:
 * `uiScaleCss` rewrites each `Npx` as `calc(N * var(--ui-px))` and each `Nrem` as
 * `calc(N * var(--ui-rem))` at build time, and `styles.css` defines the two units from the scale.
 * Everything the board MEASURES (`play/zone-box.ts`, `play/card-size.ts`) follows from those
 * lengths, so a card, a column, a prompt and a font all scale together and the fit-to-the-window
 * rules that size the table go on fitting it.
 *
 * Not CSS `zoom` and not a `transform` on the root: either one puts the page's boxes in a
 * different space from the px its gestures write back (`getBoundingClientRect()` is zoomed, a
 * `left: …px` written from it is zoomed again), and a hundred places on the board do exactly that.
 * Here a px is a px: the scale changes what the stylesheet asks for, not the coordinate space.
 *
 * Where it is written: the element our tokens resolve on — the document's root standalone, the
 * shadow host embedded (the embed build rewrites `:root` as `:host`). A custom property's `var()`
 * is resolved where it is declared, so a scale written any lower would miss every token `:root`
 * declares.
 */

/** The range, in steps of 5%. Under 80% the text (11px authored) drops below ~9px; over 125% the
 *  side column and the prompt bars take so much of a 1280×800 table that the battlefields fall to
 *  their two-row minimum before a game has begun. */
export const UI_SCALE = { min: 0.8, max: 1.25, step: 0.05 } as const;

/** A saved or dragged value, inside the range and on a step; anything unreadable is 1. */
export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const stepped = Math.round(value / UI_SCALE.step) * UI_SCALE.step;
  return Math.round(Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, stepped)) * 100) / 100;
}

/** Strings and `url(…)`s pass through untouched; only what is between them is rewritten. */
const OPAQUE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\))/;
/** A px or rem length that is a whole token: not part of a name (`--gap-4px`), a colour or a number. */
const LENGTH = /(?<![\w.#-])(-?)(\d+\.?\d*|\.\d+)(px|rem)(?![\w%-])/g;

export function scaleCssValue(value: string): string {
  return value
    .split(OPAQUE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(LENGTH, (whole, sign: string, n: string, unit: string) =>
            Number(n) === 0 ? whole : `calc(${sign}${n} * var(--ui-${unit}))`,
          ),
    )
    .join('');
}

/** A length a component writes inline (an icon's `size`), in the same units the stylesheets are rewritten to. */
export function uiLength(length: `${number}${'px' | 'rem'}`): string {
  return scaleCssValue(length);
}

/** The units and the scale are defined in px and rem; they are the one place that may be. */
const OWN_UNITS = new Set(['--ui-scale', '--ui-px', '--ui-rem']);
/** Descriptors, not properties: they take no `var()`. */
const DESCRIPTOR_RULES = new Set(['property', 'font-face', 'page', 'counter-style', 'font-palette-values']);

interface CssNode {
  type?: string;
  name?: string;
  parent?: unknown;
}

function inAtRule(node: CssNode | undefined, names: ReadonlySet<string>): boolean {
  for (let n = node; n !== undefined; n = n.parent as CssNode | undefined) {
    if (n.type === 'atrule' && n.name !== undefined && names.has(n.name.toLowerCase())) return true;
  }
  return false;
}

const KEYFRAMES = new Set(['keyframes']);

/** Only the app's own sheets: the fleet's chrome and the symbol packs' vendor CSS keep their sizes. */
function ownSheet(file: string | undefined): boolean {
  return file !== undefined && /[\\/]apps[\\/]ui[\\/]src[\\/]/.test(file) && !/[\\/]node_modules[\\/]/.test(file);
}

/** The PostCSS plugin both builds run (`vite.config.ts`, `vite.embed.config.ts`). Idempotent. */
export const uiScaleCss = {
  postcssPlugin: 'cardtable-ui-scale',
  Declaration(decl: { prop: string; value: string; parent?: CssNode; source?: { input: { file?: string } } }): void {
    if (OWN_UNITS.has(decl.prop) || !ownSheet(decl.source?.input.file) || inAtRule(decl.parent, DESCRIPTOR_RULES)) return;
    const next = scaleCssValue(decl.value);
    if (next === decl.value) return;
    // Firefox plays a registered property's keyframes that hold a `var()` forwards on every
    // iteration, never back, so an `alternate` loop snaps from its end to its start (`card.css`'s
    // flyers, the operator, 2026-10-23). Such a keyframe animates a plain number, and the length is
    // made where it is drawn (`calc(var(--x) * 1px)`), which this rewrites like any other.
    if (decl.prop.startsWith('--') && inAtRule(decl.parent, KEYFRAMES)) {
      throw new Error(`${decl.source?.input.file ?? 'a stylesheet'}: a keyframe sets ${decl.prop} to a length (${decl.value}); animate a number and multiply by 1px where it is used`);
    }
    decl.value = next;
  },
};

/** The element our tokens resolve on: the shadow host when `node` is inside one, else the document's root. */
export function scaleRootOf(node: Node): HTMLElement {
  const root = node.getRootNode();
  if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && root.host instanceof HTMLElement) return root.host;
  return node.ownerDocument?.documentElement ?? document.documentElement;
}

/**
 * A length a component computes with, authored in px at 100% as its stylesheet would be, as the
 * stylesheets draw it now: times the scale on `node`'s root. Every px constant a layout measures
 * against reads through this, so it follows the slider with the CSS it stands beside.
 */
export function uiPx(px: number, node?: Node | null): number {
  const at = node ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (at == null) return px;
  const scale = parseFloat(getComputedStyle(scaleRootOf(at)).getPropertyValue('--ui-scale'));
  return Number.isFinite(scale) && scale > 0 ? px * scale : px;
}

/** Write the scale on `root`; at 1 nothing is written, and the stylesheet's own default stands. */
export function applyUiScale(root: HTMLElement, scale: number): void {
  const value = clampUiScale(scale);
  if (value === 1) root.style.removeProperty('--ui-scale');
  else root.style.setProperty('--ui-scale', String(value));
}
