/*
 * The front page's own glyphs — inline stroke SVGs, never a card image and never a WotC mark
 * (AGENTS.md). Each one is `aria-label` AND `title`-ed, so a screen reader and a mouse hover both
 * learn the same word, and no caption is written beside it (`no-explanatory-ui-text`).
 *
 * Kept to exactly the set the room card and the banner draw (`docs/planning/wave77-2026-10-27.md`
 * §A): a draft is two fanned cards, a constructed table is a stacked deck, a tournament is a trophy,
 * a seat count is a person, and each Constructed mode has its own mark — Classic crossed swords,
 * Gauntlet a staircase, All Random a die. The carousel's arrows and dot are drawn here too, since
 * the wildcard card (`./WildcardCard.tsx`) is the only other place that needs one.
 */

import type { ReactNode } from 'react';

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

/** A draft room: two fanned cards. */
export function DraftIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph label="Draft" size={size}>
      <rect x="4" y="7" width="11" height="15" rx="1.5" transform="rotate(-12 9.5 14.5)" />
      <rect x="9" y="5" width="11" height="15" rx="1.5" />
    </Glyph>
  );
}

/** A constructed room: a deck, stacked. */
export function ConstructedIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph label="Constructed" size={size}>
      <rect x="5" y="9" width="14" height="11" rx="1.5" />
      <path d="M7 9V6.5A1.5 1.5 0 0 1 8.5 5h7A1.5 1.5 0 0 1 17 6.5V9" />
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

/** Classic: crossed swords. */
export function SwordsIcon({ size = 14 }: { size?: number }) {
  return (
    <Glyph label="Classic" size={size}>
      <path d="M4 4l8 8M12 12l8 8M20 4l-8 8M8 12l-4 4M4 20l1.5-4" />
      <path d="M16 20l-1.5-4" />
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
