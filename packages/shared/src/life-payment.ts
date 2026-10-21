/**
 * Forge's payment prompt saying life can pay it: `InputPayManaOfCostPayment.getMessage`'s last line,
 * `{U/P}\n(Click on your life total to pay life for phyrexian mana.)` and its variants
 * (`lblClickOnYourLifeTotalToPayLife…`, `en-US.properties:1799-1801`). The server reads it as a second
 * way to pay (`apps/server/src/play/auto.ts`), the browser as its life button (`live/match.ts`), and
 * the payment window drops the line (`prompts/lookup.ts`). Forge wraps it in parentheses
 * (`InputPayManaOfCostPayment.java:106`), so the opening one is optional: unanchored on the paren alone
 * it never matched the real prompt, and a payable phyrexian cost was cancelled.
 */
export const LIFE_PAYMENT = /^\(?Click on your life total to pay life for /m;

/** The whole line and the newline before it. */
export const LIFE_PAYMENT_LINE = new RegExp(`\\n?${LIFE_PAYMENT.source}[^\\n]*$`, 'm');

/** What one click pays for a life-paid mana ability with no card on the table (Channel's `lblClickOnYourLifeTotalToPayLifeForMana`). */
export const LIFE_PER_CLICK = new RegExp(`${LIFE_PAYMENT.source}mana, (\\d+) life a click\\.`, 'm');
