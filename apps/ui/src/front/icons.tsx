/*
 * The front page's own glyphs — inline stroke SVGs, never a card image and never a WotC mark
 * (AGENTS.md). Each one is `aria-label` AND `title`-ed, so a screen reader and a mouse hover both
 * learn the same word, and no caption is written beside it (`no-explanatory-ui-text`).
 *
 * Kept to exactly the set the room card and the banner draw (`docs/planning/wave77-2026-10-27.md`
 * §A): a draft is a card with the pass arrows round it, a constructed table is a stacked deck, a
 * tournament is a trophy, a seat count is a person, and each Constructed mode has its own mark —
 * Classic crossed swords, Gauntlet a staircase, All Random a die. The carousel's arrows and dot are
 * drawn here too, since the wildcard card (`./WildcardCard.tsx`) is the only other place that needs one.
 *
 * The room card's large faint background is a scene of its own, not a glyph scaled up (the operator
 * picked them, 2026-10-27): a draft is the pod passing packs, a constructed room two decks across the
 * table.
 */

import { useId, type ReactNode } from 'react';

/** Every glyph's own box, so a row of them lines up without each caller picking a size. */
function Glyph({ label, size, children }: { label: string; size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {children}
    </svg>
  );
}

/** A draft room: pick and pass — a card with the pass arrows round it. */
export function DraftIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph label="Draft" size={size}>
      <rect x="8.5" y="7" width="7" height="10" rx="1" />
      <path d="M19.5 9.5A8 8 0 0 0 6 5.6" />
      <path d="M6 2.6v3h3" />
      <path d="M4.5 14.5A8 8 0 0 0 18 18.4" />
      <path d="M18 21.4v-3h-3" />
    </Glyph>
  );
}

/** A constructed room: a deck, stacked. */
export function ConstructedIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph label="Constructed" size={size}>
      <rect x="3.5" y="8" width="11" height="13" rx="1.2" />
      <path d="M5.5 8V6.2A1.2 1.2 0 0 1 6.7 5h9.6a1.2 1.2 0 0 1 1.2 1.2v11.6a1.2 1.2 0 0 1-1.2 1.2h-1.8" />
      <path d="M8 5V3.2A1.2 1.2 0 0 1 9.2 2h9.6A1.2 1.2 0 0 1 20 3.2v11.6a1.2 1.2 0 0 1-1.2 1.2h-1.3" />
    </Glyph>
  );
}

/** A tournament, drawn solid gold by its own CSS rather than stroke-only, so it reads at a glance. */
export function TrophyIcon({ size = 16 }: { size?: number }) {
  return (
    <Glyph label="Tournament" size={size}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5 3.5 3.5 0 0 0 7.5 10H8" />
      <path d="M16 5h2.5A1.5 1.5 0 0 1 20 6.5 3.5 3.5 0 0 1 16.5 10H16" />
      <path d="M12 13v3" />
      <path d="M8.5 20h7" />
      <path d="M9.5 20c0-1.8.9-2.7 2.5-3 1.6.3 2.5 1.2 2.5 3" />
    </Glyph>
  );
}

/** A password-protected room: a padlock. */
export function LockIcon({ size = 15 }: { size?: number }) {
  return (
    <Glyph label="Locked" size={size}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Glyph>
  );
}

/** A seat count. */
export function PersonIcon({ size = 14 }: { size?: number }) {
  return (
    <Glyph label="Seats" size={size}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
    </Glyph>
  );
}

/** Classic: crossed swords — blade, point, guard, grip and pommel each. */
export function SwordsIcon({ size = 14 }: { size?: number }) {
  return (
    <Glyph label="Classic" size={size}>
      <path d="M20 4L9 15M20 4h-3.2M20 4v3.2M6.4 12.4l5.2 5.2M9 15l-4 4" />
      <circle cx="4.3" cy="19.7" r="0.9" />
      <path d="M4 4l11 11M4 4h3.2M4 4v3.2M17.6 12.4l-5.2 5.2M15 15l4 4" />
      <circle cx="19.7" cy="19.7" r="0.9" />
    </Glyph>
  );
}

/** Gauntlet: a staircase of eras. */
export function StaircaseIcon({ size = 14 }: { size?: number }) {
  return (
    <Glyph label="Gauntlet" size={size}>
      <path d="M4 20v-4h4v-4h4v-4h4v-4h4" />
    </Glyph>
  );
}

/** All Random: a die. */
export function DieIcon({ size = 14 }: { size?: number }) {
  return (
    <Glyph label="All Random" size={size}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function ChevronLeftIcon({ size = 16 }: { size?: number }) {
  return (
    <Glyph label="Previous" size={size}>
      <path d="M15 5l-7 7 7 7" />
    </Glyph>
  );
}

export function ChevronRightIcon({ size = 16 }: { size?: number }) {
  return (
    <Glyph label="Next" size={size}>
      <path d="M9 5l7 7-7 7" />
    </Glyph>
  );
}

/** A scene's own box: 160 units square, thin strokes, drawn large and faint behind a room card. */
function Scene({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 160 160"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const POD_SEATS = 8;
const POD_SEAT_R = 56;
const POD_ARROW_R = 41;
const at = (r: number, a: number): string => `${(80 + r * Math.cos(a)).toFixed(1)} ${(80 + r * Math.sin(a)).toFixed(1)}`;

/** Each seat of the pod: a card turned to face the table, and the arc that passes its pack on. */
const POD = Array.from({ length: POD_SEATS }, (_, i) => {
  const a = (i / POD_SEATS) * Math.PI * 2 - Math.PI / 2;
  const [cx, cy] = [80 + POD_SEAT_R * Math.cos(a), 80 + POD_SEAT_R * Math.sin(a)];
  const end = a + (Math.PI * 2) / POD_SEATS - 0.26;
  const head = end - 0.12;
  return {
    seat: { x: cx - 8, y: cy - 11, turn: `rotate(${((a * 180) / Math.PI + 90).toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})`, line: `M${(cx - 5).toFixed(1)} ${(cy - 6).toFixed(1)}h10` },
    pass: `M${at(POD_ARROW_R, a + 0.26)}A${POD_ARROW_R} ${POD_ARROW_R} 0 0 1 ${at(POD_ARROW_R, end)}`,
    head: `M${at(POD_ARROW_R + 3.5, head)}L${at(POD_ARROW_R, end)}L${at(POD_ARROW_R - 3.5, head)}`,
  };
});

/** A draft room's background: the pod — eight seats round a table, each passing its pack on. */
export function PodScene({ size = 170 }: { size?: number }) {
  return (
    <Scene size={size}>
      <circle cx="80" cy="80" r="26" />
      {POD.map(({ seat, pass, head }) => (
        <g key={pass}>
          <g transform={seat.turn}>
            <rect x={seat.x} y={seat.y} width="16" height="22" rx="1.6" />
            <path d={seat.line} />
          </g>
          <path d={pass} />
          <path d={head} />
        </g>
      ))}
    </Scene>
  );
}

interface SceneCard {
  x: number;
  y: number;
  r: number;
}

const DECK_CARD = { w: 54, h: 76 };

/** Four cards squared up, each nudged up and along `dir` from the one under it. */
const deck = (x: number, y: number, r: number, dir: 1 | -1): SceneCard[] =>
  [0, 1, 2, 3].map((k) => ({ x: x + k * 2.6 * dir, y: y - k * 3, r }));

/** Both decks, bottom card first: the near one low left, the far one high right. */
const FACING: readonly SceneCard[] = [...deck(6, 78, -10, 1), ...deck(98, 22, 10, -1)];

const turnOf = ({ x, y, r }: SceneCard): string => `rotate(${r} ${x + DECK_CARD.w / 2} ${y + DECK_CARD.h / 2})`;

/** A card's face: its outline, the art window and three lines of text. */
function SceneCardFace({ card }: { card: SceneCard }) {
  const { w, h } = DECK_CARD;
  const pad = w * 0.09;
  const artH = h * 0.42;
  return (
    <g transform={turnOf(card)}>
      <rect x={card.x} y={card.y} width={w} height={h} rx={w * 0.07} />
      <rect x={card.x + pad} y={card.y + pad} width={w - 2 * pad} height={artH} rx={w * 0.03} />
      {[1, 1, 0.6].map((len, i) => (
        <path key={i} d={`M${card.x + pad} ${card.y + pad + artH + h * 0.12 + i * h * 0.09}h${(w - 2 * pad) * len}`} />
      ))}
    </g>
  );
}

/**
 * A constructed room's background: two decks across the table, a spark between them. Every card is
 * masked by the cards on top of it, so a stack reads as solid cards rather than a tangle of outlines.
 */
export function DecksFacingScene({ size = 170 }: { size?: number }) {
  const id = useId();
  const { w, h } = DECK_CARD;
  return (
    <Scene size={size}>
      <defs>
        {FACING.slice(0, -1).map((_, i) => (
          <mask key={i} id={`${id}-${i}`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="200" height="200">
            <rect x="-20" y="-20" width="200" height="200" fill="white" />
            {FACING.slice(i + 1).map((c, j) => (
              <rect key={j} x={c.x - 1} y={c.y - 1} width={w + 2} height={h + 2} rx={w * 0.07} transform={turnOf(c)} fill="black" stroke="none" />
            ))}
          </mask>
        ))}
      </defs>
      {FACING.map((card, i) => (
        <g key={i} mask={i < FACING.length - 1 ? `url(#${id}-${i})` : undefined}>
          <SceneCardFace card={card} />
        </g>
      ))}
      <path d="M86 48l-12 26h14l-12 26" />
      <path d="M68 58l-7-5M96 90l7 5M66 84l-8 2M100 62l8-2" />
    </Scene>
  );
}
