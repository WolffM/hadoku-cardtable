/*
 * Marks we draw ourselves — shapes in an inline `<svg>`, no image, no asset —
 * shared by the board and the prompts so each is drawn once.
 */

/**
 * The mark a player with no avatar is drawn as: our own shapes in an inline
 * `<svg>`, no image and no asset (`Board.tsx`'s `PlayerFace` has the why).
 * A seat's face draws it, and so does a prompt that names a player
 * (`prompts/PromptShell.tsx`'s `promptThumb`). Its look is `card.css`'s
 * `.face__*` rules.
 */
export function PlayerMark() {
  return (
    <svg className="face__art" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle className="face__plate" cx="24" cy="24" r="22.5" />
      <circle className="face__brow" cx="24" cy="18" r="7.5" />
      <path className="face__bust" d="M10.5 40.5a13.5 13.5 0 0 1 27 0Z" />
    </svg>
  );
}

/** A tick: a card picked on the board (`Board.tsx`), a recipient given lethal damage (`prompts/AssignPrompts.tsx`). */
export function CheckMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6 10.8 3.2 8 2.3 8.9 6 12.7 14 4.7 13.1 3.7Z" />
    </svg>
  );
}
