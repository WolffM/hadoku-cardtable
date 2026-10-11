/*
 * Searching a card-name ask (`GetChoicesSchema.names`): tens of thousands of
 * names, of which the picker draws a handful. Case- and accent-insensitive, so
 * "lim dul" finds "Lim-Dûl's Vault" and "jotun" finds "Jötun Grunt".
 */

/** How many matches the picker draws. */
export const NAME_MATCHES_SHOWN = 40;

/** Lower case, accents and punctuation off, runs of anything else one space. */
export function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface NameIndex {
  readonly names: readonly string[];
  readonly folded: readonly string[];
}

/** Each name once: Forge can list a name twice (two faces of one name), and a name is its own key. */
export function nameIndex(names: readonly string[]): NameIndex {
  const unique = [...new Set(names)];
  return { names: unique, folded: unique.map(foldName) };
}

/**
 * The names matching `query`: those that start with it first, then those with a
 * word that starts with it, then any that contain it — each group in the ask's
 * own order. An empty query lists a short ask whole and a long one not at all.
 */
export function searchNames(index: NameIndex, query: string, limit = NAME_MATCHES_SHOWN): string[] {
  const q = foldName(query);
  if (q === '') return index.names.length <= limit ? [...index.names] : [];
  const starts: string[] = [];
  const words: string[] = [];
  const inside: string[] = [];
  for (let i = 0; i < index.names.length && starts.length < limit; i++) {
    const f = index.folded[i]!;
    const at = f.indexOf(q);
    if (at === -1) continue;
    const name = index.names[i]!;
    if (at === 0) starts.push(name);
    else if (f[at - 1] === ' ' || f.includes(` ${q}`)) words.push(name);
    else inside.push(name);
  }
  return [...starts, ...words, ...inside].slice(0, limit);
}
