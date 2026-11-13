/**
 * The hidden-information audit, over a whole serialised payload.
 *
 * `validate.ts` checks the fields it knows about. This checks the fields it
 * does *not* — it walks the entire JSON tree, finds every object that looks
 * like a card, and reports where it was found. The two are different tests on
 * purpose: a schema validator says "the fields I named are well-formed", which
 * is silent about a field nobody thought to name. A draft payload leaks when
 * someone adds a field, not when they mistype one.
 *
 * So the rule enforced here is positional, not nominal: **the only places a
 * card may appear in a payload are `viewer.pack` and `viewer.pool`.** Anywhere
 * else — a seat summary, a debug echo, a `lastPick` convenience field someone
 * adds later — is a leak, and the test names the path.
 */

/** A card is anything carrying both a `cardId` and a `name`. */
function looksLikeACard(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.cardId === 'string' && typeof o.name === 'string';
}

/** Every path at which a card-shaped object appears, in walk order. */
export function findCardPaths(payload: unknown): string[] {
  const found: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (looksLikeACard(node)) {
      found.push(path);
      return; // a card's own fields are not themselves cards
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };

  walk(payload, '$');
  return found;
}

/**
 * Paths holding a card that the recipient is not entitled to see.
 *
 * Empty means the payload is clean. A spectator payload is clean only when it
 * carries no cards at all, which falls out of the rule without a special case:
 * a spectator has no `viewer.pack` or `viewer.pool`, so every card in it is at
 * some other path.
 */
export function findLeakedCardPaths(payload: unknown): string[] {
  const allowed = (p: string): boolean =>
    p.startsWith('$.viewer.pack[') || p.startsWith('$.viewer.pool[');
  return findCardPaths(payload).filter((p) => !allowed(p));
}

/** Throwing wrapper, for use in a test or a dev-mode boot assertion. */
export function assertNoLeakedCards(payload: unknown, label: string): void {
  const leaks = findLeakedCardPaths(payload);
  if (leaks.length > 0) {
    throw new Error(
      `${label} leaks cards the recipient may not see, at:\n${leaks.map((p) => `  ${p}`).join('\n')}`,
    );
  }
}
