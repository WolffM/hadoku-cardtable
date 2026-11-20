/*
 * A set's cards, as Forge has them: the names its edition file lists (`res/editions/<Name>.txt`,
 * the `[cards]` section) and, from each card's script (`res/cardsfolder`), the two facts the sweep
 * needs to lay a board out for it. Read from the same `res` the match runs on, so the list is the
 * one a set draft at this pin deals from.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SetCard {
  name: string;
  /** Forge's rarity letter: `C`, `U`, `R`, `M`, `L` (a basic land). */
  rarity: string;
  /** The script's `Types:` line, e.g. `Legendary Creature Frog Druid`. */
  types: string;
  /** The script's keywords, each without its parameters: `Gift`, `Offspring`, `Flying`. */
  keywords: string[];
  /** Whether the script gives the card anything beyond keywords: an ability, a trigger, a static or a replacement. */
  scripted: boolean;
}

/** The edition file whose `Code=` is `code`. */
function editionFile(res: string, code: string): string {
  const dir = join(res, 'editions');
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (new RegExp(`^Code=${code}$`, 'm').test(text)) return text;
  }
  throw new Error(`no edition with Code=${code} under ${dir}`);
}

/** Every card script under `res/cardsfolder`, by the name on its first `Name:` line. */
function scriptsByName(res: string, wanted: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(res, 'cardsfolder');
  for (const letter of readdirSync(root, { withFileTypes: true })) {
    if (!letter.isDirectory()) continue;
    for (const file of readdirSync(join(root, letter.name))) {
      const text = readFileSync(join(root, letter.name, file), 'utf8');
      const name = /^Name:(.*)$/m.exec(text)?.[1]?.trim();
      if (name !== undefined && wanted.has(name)) out.set(name, text);
    }
  }
  return out;
}

/** The set's distinct cards, in collector order. A name the edition lists with no script throws: the sweep would skip it silently. */
export function setCards(res: string, code: string): SetCard[] {
  const listed: { name: string; rarity: string }[] = [];
  let inCards = false;
  for (const line of editionFile(res, code).split('\n')) {
    if (line.startsWith('[')) {
      inCards = line.trim() === '[cards]';
      continue;
    }
    const row = inCards ? /^\S+\s+(\S)\s+(.*?)(?:\s+@.*)?$/.exec(line.trim()) : null;
    if (row !== null && !listed.some((c) => c.name === row[2])) listed.push({ name: row[2]!, rarity: row[1]! });
  }
  const scripts = scriptsByName(res, new Set(listed.map((c) => c.name)));
  return listed.map(({ name, rarity }) => {
    const script = scripts.get(name);
    if (script === undefined) throw new Error(`${code} lists "${name}" but res/cardsfolder has no script for it`);
    return { name, rarity, keywords: [...script.matchAll(/^K:([^:\n]+)/gm)].map((k) => k[1]!.trim()), types: /^Types:(.*)$/m.exec(script)?.[1]?.trim() ?? '', scripted: /^(A|T|S|R):/m.test(script) || /^K:(?!(Flying|First Strike|Double Strike|Deathtouch|Haste|Hexproof|Indestructible|Lifelink|Menace|Reach|Trample|Vigilance|Flash|Defender|Prowess|Changeling)\s*$)/m.test(script) };
  });
}
