/*
 * Which of Forge's two-button bars is a question: the predicates `ConfirmPrompt.tsx` draws by, in a
 * file with no component in it, so a headless client (the monkey's card sweep) can ask the same
 * thing of a bar. `ConfirmPrompt.tsx`'s header has the Forge citations behind each branch.
 */
import { AUTO_PAY_LABEL, type LiveButtons } from '../live/match.ts';

/** Forge's own `lblOK` (`en-US.properties:598`) — see the module header's mechanical set. */
export const BAR_OK_LABEL = 'OK';

/** Forge's own two labels for the coin toss (`en-US.properties`'s `lblPlay`/`lblDraw`). */
export const PLAY_LABEL = 'Play';
export const DRAW_LABEL = 'Draw';

/** True only for the coin-toss winner's own "play or draw" question — see the module header. */
export function isPlayOrDrawPrompt(buttons: LiveButtons | null): boolean {
  return (
    buttons !== null &&
    buttons.label1 === PLAY_LABEL &&
    buttons.label2 === DRAW_LABEL &&
    buttons.enable1 &&
    buttons.enable2
  );
}

/**
 * True for a Forge bar question that is an ANSWER (yes/no, Keep/Mulligan, a
 * scry's Top/Bottom, …), false for a priority pass, a mana payment, the
 * London mulligan's OK/Auto, an attack declaration, a default OK/Cancel
 * selection, or the coin toss (its own branch below). See the module header
 * for the Forge citations behind each branch.
 */
export function isConfirmPrompt(bar: LiveButtons | null): boolean {
  if (bar === null || !bar.enable1 || !bar.enable2) return false;
  if (isPlayOrDrawPrompt(bar)) return false;
  return bar.label1 !== BAR_OK_LABEL && bar.label1 !== AUTO_PAY_LABEL && bar.label1 !== '';
}
