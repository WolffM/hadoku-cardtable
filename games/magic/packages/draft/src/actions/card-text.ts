/*
 * What a draft card's printed text says, for the cards that note it: a draft
 * card carries its type line and oracle text, not Forge's parsed card.
 */

/** The keywords Animus of Predation looks for, lower case to Forge's own spelling of each. */
const KEYWORDS: Readonly<Record<string, string>> = {
  flying: 'Flying',
  'first strike': 'First Strike',
  'double strike': 'Double Strike',
  deathtouch: 'Deathtouch',
  haste: 'Haste',
  hexproof: 'Hexproof',
  indestructible: 'Indestructible',
  lifelink: 'Lifelink',
  menace: 'Menace',
  reach: 'Reach',
  vigilance: 'Vigilance',
};

/**
 * The keywords a card has among `KEYWORDS`, in the card's own order, each once.
 *
 * Read from the card's keyword lines: a line that, less its reminder text, is
 * a list of abilities and no sentence (no full stop, no cost's colon). So a
 * card that gives flying to something else has none, and "hexproof from black"
 * is not hexproof.
 */
export function keywordsOf(oracleText: string): string[] {
  const out: string[] = [];
  for (const raw of oracleText.split('\n')) {
    const line = raw.replace(/\([^)]*\)/g, '').trim();
    if (line === '' || /[.:]/.test(line)) continue;
    for (const part of line.split(/[,;]/)) {
      const keyword = KEYWORDS[part.trim().toLowerCase()];
      if (keyword !== undefined && !out.includes(keyword)) out.push(keyword);
    }
  }
  return out;
}

/** Creature types of two words, which a type line's spaces would split. */
const TWO_WORD_TYPES = ['Time Lord'];

/** A creature's types: the front face's words after the dash; none for a card that is no creature. */
export function creatureTypesOf(typeLine: string): string[] {
  const [types, subtypes] = (typeLine.split(' // ')[0] ?? '').split('—');
  if (subtypes === undefined || !/\bCreature\b/.test(types ?? '')) return [];
  let rest = subtypes.trim();
  const joined = new Map<string, string>();
  for (const two of TWO_WORD_TYPES) {
    const key = two.replace(' ', '\u0000');
    joined.set(key, two);
    rest = rest.replace(two, key);
  }
  return rest.split(/\s+/).filter((w) => w !== '').map((w) => joined.get(w) ?? w);
}
