/**
 * Mana pips and set symbols, drawn by the fonts.
 *
 * ## Why this file no longer draws its own
 *
 * It used to. Under D13 every pip here was a plain disc with an alphanumeric
 * label and the Phyrexian mark was a dashed ring, because "no WotC trademarks in
 * the UI" was absolute. **D20 (operator, 2026-09-27) superseded that:** *"naw
 * we're not drawing our own"*. Mana symbols, the tap symbol and set symbols now
 * ship from two third-party icon fonts, vendored at `../symbols/` and imported
 * from `styles.css`:
 *
 *   - **Mana** 1.18.0 — mana, tap and cost symbols, class `ms ms-<x>`.
 *   - **Keyrune** 3.19.0 — set symbols, class `ss ss-<setcode>`.
 *
 * `docs/LICENSING.md` §3.2 records what each pack actually licenses, and the two
 * are NOT the same position — read it before changing what ships. Still
 * forbidden, and not loosened by D20: the WotC logo, the Magic wordmark, and
 * card frames.
 *
 * **What survived the change is the token PARSER below.** It was already the
 * interesting half, and it maps 1:1 onto the font's class names — which is why
 * this is a small change and not a rewrite.
 *
 * ## A hybrid pip is not a glyph
 *
 * `{W/U}` is not one character in the font. It is Mana's `.ms-cost` split
 * system: the disc's background is a 135° gradient between `--ms-split-top` and
 * `--ms-split-bottom`, and the two halves are `::before` and `::after` drawn at
 * `0.55em` and positioned into the corners (`../symbols/mana.css` ~:1432-1504).
 * So every pip here carries `ms-cost`, and a hybrid carries `ms-cost ms-wu` and
 * nothing of ours. Hand-rolling the split renders `{W}` correctly and breaks
 * `{W/U}` silently; that is why the vendored CSS ships whole.
 *
 * ## Tokens this understands
 *
 * Costs arrive as a token list (`['2','W','W']`) rather than a string, so this
 * never has to parse `{2}{W}{W}`. `play/adapter.ts`'s `SHARD_TOKEN` is the
 * authority for what Forge sends, and every entry in it is covered here.
 *
 *   `0`–`20`, `100`, `1000000`  generic
 *   `W U B R G`                 colour
 *   `C`                         colourless
 *   `S`                         snow
 *   `X Y Z`                     variable
 *   `E`                         energy
 *   `T` / `Q`                   tap / untap
 *   `½` `∞`                     Unhinged's half, Mox Lotus's infinity
 *   `W/U`                       hybrid      → `ms-wu`
 *   `2/W`                       twobrid     → `ms-2w`
 *   `C/W`                       colourless hybrid → `ms-cw`
 *   `B/P`                       Phyrexian   → `ms-bp`
 *   `W/U/P`                     hybrid Phyrexian → `ms-wup`
 *
 * **An unrecognised token still renders — as itself, in a plain capsule.** That
 * rule predates the fonts and outlives them: a cost that silently drops a symbol
 * is worse than an ugly one. A token the fonts have no glyph for therefore comes
 * out as its own text rather than as an empty box, and `ManaPip.test.ts` proves
 * both halves — that every class we emit exists in the vendored CSS, and that a
 * token outside the table is printed.
 *
 * ## The `.pip` wrapper, and why it carries an inline style
 *
 * `styles.css` still holds the pre-D20 `.pip` rules — a 16px grey disc, 9px
 * text. That file is owned by nobody this wave (wave 26 §"Owned by nobody"), so
 * those rules cannot be deleted here, and left to apply they would fight the
 * font: a 9px glyph in a 16px box puts a hybrid's two halves in the wrong
 * corners, because Mana positions them in `em` against a box it expects to be
 * `1.3em`.
 *
 * So the outer `<span class="pip">` is a compatibility shim and nothing else:
 * `display: contents` makes it generate no box at all, which discards every one
 * of those rules, and `font-size: inherit` undoes the one that still inherits
 * through. The glyph is the inner `<i class="ms ms-cost ms-…">`, which the old
 * rules cannot reach. The class stays because three test files outside this lane
 * locate symbols with `.pip` + `data-token`
 * (`DraftScreen.test.ts`, `DraftStates.test.ts`, `play/Board.test.ts`); it is a
 * selector contract, not styling. **When `styles.css`'s pips section is deleted,
 * delete this style object with it.**
 */

/** Mana's hybrid pairs, in the order the font names its classes. */
const HYBRID_PAIRS = ['WU', 'WB', 'UB', 'UR', 'BR', 'BG', 'RW', 'RG', 'GW', 'GU'] as const;

/**
 * Both orders of each pair → the font's own order. Scryfall and Forge both emit
 * the canonical one, so the reverse entries are belt-and-braces: `{U/W}` from
 * some other source resolves to `ms-wu` rather than to an `ms-uw` that does not
 * exist.
 */
const HYBRID: Record<string, string> = {};
for (const pair of HYBRID_PAIRS) {
  HYBRID[pair] = pair.toLowerCase();
  HYBRID[`${pair[1]}${pair[0]}`] = pair.toLowerCase();
}

const COLOR_NAME: Record<string, string> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
};

/** Single-character (and a couple of symbol) tokens → the font's class suffix. */
const SINGLE: Record<string, string> = {
  W: 'w',
  U: 'u',
  B: 'b',
  R: 'r',
  G: 'g',
  C: 'c',
  S: 's',
  X: 'x',
  Y: 'y',
  Z: 'z',
  E: 'e',
  P: 'p',
  T: 'tap',
  Q: 'untap',
  '½': '1-2',
  '∞': 'infinity',
};

const SINGLE_TITLE: Record<string, string> = {
  C: 'colourless',
  S: 'snow',
  E: 'energy',
  P: 'Phyrexian',
  T: 'tap',
  Q: 'untap',
  X: 'variable X',
  Y: 'variable Y',
  Z: 'variable Z',
  '½': 'one half generic',
  '∞': 'infinite generic',
};

/** The generic amounts the font has a glyph for: 0–20, plus these two jokes. */
const GENERIC = new Set([...Array.from({ length: 21 }, (_, i) => String(i)), '100', '1000000']);

function isColor(token: string): boolean {
  return token in COLOR_NAME;
}

export interface ManaSymbol {
  /**
   * Mana's class suffix — `w`, `wu`, `2w`, `bp`, `tap` — or `null` when the
   * fonts have no glyph for this token, in which case it is printed instead.
   */
  mana: string | null;
  /** What to print when there is no glyph: the token, as itself. */
  label: string;
  /** Hover text and the accessible name. */
  title: string;
}

export function readManaToken(token: string): ManaSymbol {
  const parts = token.split('/');

  if (parts.length === 3) {
    // Hybrid Phyrexian: `{W/U/P}`. The pair keeps the font's order, then `p`.
    const [a, b, p] = parts;
    const pair = HYBRID[`${a}${b}`];
    if (p === 'P' && pair !== undefined) {
      return {
        mana: `${pair}p`,
        label: token,
        title: `Phyrexian hybrid ${COLOR_NAME[a]} or ${COLOR_NAME[b]}`,
      };
    }
  }

  if (parts.length === 2) {
    const [a, b] = parts;
    // Phyrexian: `{B/P}`.
    if (b === 'P' && isColor(a)) {
      return { mana: `${a.toLowerCase()}p`, label: token, title: `Phyrexian ${COLOR_NAME[a]}` };
    }
    // Twobrid `{2/W}` and colourless hybrid `{C/W}`: the font names these with
    // the generic half FIRST, which is also how the token is written.
    if ((a === '2' || a === 'C') && isColor(b)) {
      const which = a === '2' ? 'two generic' : 'colourless';
      return {
        mana: `${a.toLowerCase()}${b.toLowerCase()}`,
        label: token,
        title: `${which} or ${COLOR_NAME[b]}`,
      };
    }
    // Hybrid: `{W/U}`.
    const pair = HYBRID[`${a}${b}`];
    if (pair !== undefined) {
      return { mana: pair, label: token, title: `hybrid ${COLOR_NAME[a]} or ${COLOR_NAME[b]}` };
    }
  }

  const single = SINGLE[token];
  if (single !== undefined) {
    return { mana: single, label: token, title: SINGLE_TITLE[token] ?? COLOR_NAME[token] ?? token };
  }

  if (GENERIC.has(token)) {
    return { mana: token, label: token, title: `${token} generic` };
  }

  return { mana: null, label: token, title: token };
}

/**
 * The shim described in the header. Two properties, both of them undoing
 * `styles.css`'s pre-D20 `.pip` rules rather than styling anything.
 */
const PIP_SHIM = { display: 'contents', fontSize: 'inherit' } as const;

export function ManaPip({ token }: { token: string }) {
  const symbol = readManaToken(token);

  if (symbol.mana === null) {
    // No glyph: the token, printed. `pip--wide` is the existing capsule, which
    // fits a label of more than one character.
    return (
      <span className="pip pip--wide pip--unknown" title={symbol.title} data-token={token}>
        {symbol.label}
      </span>
    );
  }

  return (
    <span className="pip pip--symbol" style={PIP_SHIM} data-token={token}>
      {/* `ms-cost` is the disc AND, for a hybrid, the split. Vendored classes
          only — nothing of ours reaches inside. The name and the hover text go
          HERE and not on the wrapper: `display: contents` leaves the wrapper
          with no box, so a `title` on it has nothing to hover. */}
      <i
        className={`ms ms-${symbol.mana} ms-cost`}
        role="img"
        aria-label={symbol.title}
        title={symbol.title}
      />
    </span>
  );
}

/** A whole cost. Renders nothing at all for a land or a cost-free permanent. */
export function ManaCost({ cost, label }: { cost: readonly string[]; label?: string }) {
  if (cost.length === 0) return null;
  return (
    <span className="cost" aria-label={label ?? `mana cost ${cost.join(' ')}`}>
      {cost.map((token, i) => (
        <ManaPip key={`${token}-${i}`} token={token} />
      ))}
    </span>
  );
}

/**
 * A set symbol, from Keyrune.
 *
 * The glyph is `ss ss-<code>` lowercased, and **the raw code is the element's
 * text content beside it**. That is deliberate and it is what item 3's "a set
 * that has no glyph degrades to its code rather than to nothing" buys: nothing
 * in CSS can tell us whether `ss-h2r` exists, and three of the cube's 124 set
 * codes have no Keyrune glyph (`H2R`, `J12`, `PRM`). Printing the code
 * unconditionally means those read as their code instead of as an empty box, and
 * the 121 that do have a glyph read as glyph-plus-code — which is what a print
 * line looks like anyway, and is the only way a 10px symbol is identifiable.
 *
 * No rarity class: Keyrune's `ss-common` / `ss-rare` / `ss-mythic` recolour the
 * glyph, and rarity is already a letter next to this in `CardTile`. Adding it
 * here would make colour the only signal for it.
 */
export function SetSymbol({ code, label }: { code: string; label?: string }) {
  return (
    <span className="setsym" data-set={code} aria-label={label ?? `set ${code}`}>
      <i className={`ss ss-${code.toLowerCase()}`} aria-hidden="true" />
      <span className="setsym__code">{code}</span>
    </span>
  );
}
