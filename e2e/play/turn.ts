/**
 * The turn counter on the phase rail (`live-turn-n`), wave 32 Q1: until turn 1 it
 * reads `Start`, not `0`, and the name that used to sit under it is gone (the
 * `data-whose` attribute on the rail stays). A spec that waited for `^\d+$` would
 * wait out its timeout at the coin toss, so every spec reads it through here.
 */

/** What `live-turn-n` shows once the board has a view: a turn number, or Start. */
export const TURN_TEXT = /^(Start|\d+)$/;

/** `Start` is turn 0; anything else is the number. */
export function turnNumber(text: string | null): number {
  const t = (text ?? '').trim();
  return t === 'Start' || t === '' ? 0 : Number(t);
}
