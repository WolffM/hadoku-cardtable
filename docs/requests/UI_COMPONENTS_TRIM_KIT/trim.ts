/*
 * Trim: game-UI decoration on an app's panels and its page, drawn entirely from theme tokens.
 *
 * Ported from hadoku-cardtable `apps/ui/src/settings/trim.ts` (shipped 2026-10-21, the operator:
 * "the UI looks very plain … just some generated lines/shapes to make the panels look nicer").
 *
 * One choice per family. `applyTrim` writes each choice as a `data-trim-*` attribute on a root
 * (normally `<html>`), and `trim.css` draws it on every `.hdk-panel` / `.hdk-panel__title` below that
 * root, and on the `.hdk-ground` element. `{}` writes no attribute and applies no rule.
 *
 * No images, no requests, nothing animated. Framework-free: no React import, keep it that way.
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

/** cardtable's site default (the operator's pick, 2026-10-21). An app may choose its own. */
export const CARDTABLE_TRIM: Trim = { frame: 'scoop', ground: 'triangles', groundCorner: 'gems' };

export const TRIM_FAMILY_IDS = Object.keys(TRIM_FAMILIES) as TrimFamily[];

export function isTrimOption(family: TrimFamily, value: string): boolean {
  return Object.hasOwn(TRIM_FAMILIES[family].options, value);
}

/** Only the families and options the catalogue has: a stored value from a newer or older catalogue is dropped, never drawn. */
export function knownTrim(value: unknown): Trim {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    TRIM_FAMILY_IDS.flatMap((f) => {
      const v = record[f];
      return typeof v === 'string' && isTrimOption(f, v) ? [[f, v]] : [];
    }),
  ) as Trim;
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
