/**
 * Mana pips, drawn by us.
 *
 * ## Why this file exists rather than a symbol font
 *
 * Every mana symbol as printed is a WotC trademark, and so is the tap symbol.
 * D13 says we draw our own, so a pip here is a plain circle with an
 * alphanumeric label — `W`, `3`, `X` — and a colour. The five colours are the
 * game's own colour pie and cannot be avoided by anything that renders a cost;
 * what is avoided is their *glyphs*. In particular the Phyrexian symbol is
 * drawn as a dashed ring rather than the Φ mark it is on a real card.
 *
 * Costs arrive as a token list (`['2','W','W']`) rather than a string, so this
 * never has to parse `{2}{W}{W}`. Tokens it understands:
 *
 *   `0`–`20`   generic      grey pip, the numeral
 *   `W U B R G` colour      the colour's pip, the letter
 *   `C`        colourless   grey pip
 *   `S`        snow         grey pip
 *   `X Y Z`    variable     grey pip
 *   `W/U`      hybrid       a 45° split of the two colours
 *   `2/W`      twobrid      grey/colour split
 *   `B/P`      Phyrexian    the colour's pip inside a dashed ring
 *
 * An unrecognised token still renders — as a grey pip carrying its own text —
 * because a cost that silently drops a symbol is worse than an ugly one.
 */

const COLOR_NAME: Record<string, string> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
};

function isColor(token: string): boolean {
  return token in COLOR_NAME;
}

interface PipShape {
  /** CSS class suffix for the base fill. */
  fill: string;
  /** Second fill, for a split pip. */
  fillB?: string;
  label: string;
  phyrexian: boolean;
  title: string;
}

export function readManaToken(token: string): PipShape {
  const parts = token.split('/');

  if (parts.length === 2) {
    const [a, b] = parts;
    if (b === 'P' && isColor(a)) {
      return {
        fill: COLOR_NAME[a],
        label: a,
        phyrexian: true,
        title: `Phyrexian ${COLOR_NAME[a]}`,
      };
    }
    const fillA = isColor(a) ? COLOR_NAME[a] : 'generic';
    const fillB = isColor(b) ? COLOR_NAME[b] : 'generic';
    return {
      fill: fillA,
      fillB,
      label: token,
      phyrexian: false,
      title: `hybrid ${a} or ${b}`,
    };
  }

  if (isColor(token)) {
    return { fill: COLOR_NAME[token], label: token, phyrexian: false, title: COLOR_NAME[token] };
  }
  if (/^\d+$/.test(token)) {
    return { fill: 'generic', label: token, phyrexian: false, title: `${token} generic` };
  }
  return { fill: 'generic', label: token, phyrexian: false, title: token };
}

export function ManaPip({ token }: { token: string }) {
  const shape = readManaToken(token);
  const classes = ['pip', `pip--${shape.fill}`];
  if (shape.fillB) classes.push('pip--split', `pip--split-${shape.fillB}`);
  if (shape.phyrexian) classes.push('pip--phyrexian');

  return (
    <span className={classes.join(' ')} title={shape.title} data-token={token}>
      <span className="pip__label">{shape.label}</span>
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
