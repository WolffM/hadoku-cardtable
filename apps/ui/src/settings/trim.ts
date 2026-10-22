/*
 * Trim: game-UI decoration on the app's panels and its page (the operator, 2026-10-21: "the UI
 * looks very plain … just some generated lines/shapes to make the panels look nicer", then "it
 * would be nice to have a composer view inside the app so i can modify it there").
 *
 * One choice per family, the same for every player: the site's trim (`./siteTrim.ts`), set from
 * `#/ui` by an admin and written as `data-trim-*` attributes where the stylesheet can see them
 * (`../chrome/trim.css`). Every panel that takes trim carries `ct-panel` (and its heading
 * `ct-panel__title`); the page's ground is the chrome root. A site nobody has set draws
 * `DEFAULT_TRIM`; None everywhere is `{}`, which writes no attribute and applies no rule.
 *
 * All of it is CSS drawn from the theme tokens: no images, no requests, nothing animated.
 */

export const TRIM_FAMILIES = {
  frame: {
    label: 'Frame',
    options: { glint: 'Edge glint', chamfer: 'Chamfered corners', hud: 'HUD cut', step: 'Stepped corners', scoop: 'Scooped corners' },
  },
  corner: {
    label: 'Corners',
    options: { brackets: 'Brackets', triangles: 'Triangles', rivets: 'Rivets', gems: 'Gems' },
  },
  title: {
    label: 'Titles',
    options: { rail: 'Rail', centred: 'Centred', ribbon: 'Ribbon' },
  },
  edge: {
    label: 'Edge',
    options: { keystone: 'Keystone gem' },
  },
  texture: {
    label: 'Panel texture',
    options: { felt: 'Felt', linen: 'Linen', lattice: 'Lattice' },
  },
  ground: {
    label: 'Background',
    options: { glow: 'Overhead glow', felt: 'Table felt', dots: 'Dot grid', grid: 'HUD grid', triangles: 'Triangle lattice' },
  },
  groundCorner: {
    label: 'Background corners',
    options: { wedge: 'Wedge glow', gems: 'Gem cluster' },
  },
} as const;

export type TrimFamily = keyof typeof TRIM_FAMILIES;
export type Trim = { [F in TrimFamily]?: keyof (typeof TRIM_FAMILIES)[F]['options'] };

/** What a site nobody has set draws (the operator's pick, 2026-10-21). */
export const DEFAULT_TRIM: Trim = { frame: 'scoop', ground: 'triangles', groundCorner: 'gems' };

export const TRIM_FAMILY_IDS = Object.keys(TRIM_FAMILIES) as TrimFamily[];

export function isTrimOption(family: TrimFamily, value: string): boolean {
  return Object.hasOwn(TRIM_FAMILIES[family].options, value);
}

/** `groundCorner` → `data-trim-ground-corner`. */
export function trimAttribute(family: TrimFamily): string {
  return `data-trim-${family.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Writes one attribute per chosen family and removes the rest. */
export function applyTrim(el: HTMLElement, trim: Trim): void {
  for (const family of TRIM_FAMILY_IDS) {
    const value = trim[family];
    if (value === undefined) el.removeAttribute(trimAttribute(family));
    else el.setAttribute(trimAttribute(family), value);
  }
}

