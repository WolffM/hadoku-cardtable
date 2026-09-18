/*
 * The prompt seam: one ask in, one answer out.
 *
 * Forge's 15 blocking `ProtocolMethod`s (`BLOCKING_METHODS` in
 * `@hadoku/forge-wire`) each park a game thread until the browser answers.
 * Every component in this directory is the browser half of exactly one of
 * them, and they all have the same shape:
 *
 *     <Prompt ask={parsedAskFrame} lookup={...} onAnswer={(reply) => …} />
 *
 * `ask` is the frame `parseServerFrame` produced; `onAnswer` receives a value
 * that has already passed `REPLY_SCHEMAS[method]`. **No component touches a
 * socket.** Wrapping the reply in `{ kind: 'reply', callId, method, result }`
 * and sending it is lane B's seam (`apps/ui/src/play/live/`), and keeping it
 * there is what lets every component here be rendered from a committed fixture
 * and tested with no transport at all.
 *
 * `showConfirmDialog` is the fifteenth and is NOT here: lane B builds it,
 * beside the socket it was proven over. `PromptMethod` is therefore the other
 * fourteen, and the index's coverage test holds that count.
 */

import {
  BLOCKING_METHODS,
  REPLY_SCHEMAS,
  type BlockingMethod,
  type ServerFrame,
} from '@hadoku/forge-wire';

import type { PromptLookup } from './lookup.ts';

/** The one blocking method this directory does not own. */
export const LANE_B_METHOD = 'showConfirmDialog' as const;

export type PromptMethod = Exclude<BlockingMethod, typeof LANE_B_METHOD>;

/** The fourteen, in `BLOCKING_METHODS` (i.e. `ProtocolMethod`) order. */
export const PROMPT_METHODS: readonly PromptMethod[] = BLOCKING_METHODS.filter(
  (m): m is PromptMethod => m !== LANE_B_METHOD,
);

/** The parsed ask frame for one method. */
export type AskOf<M extends BlockingMethod> = Extract<ServerFrame, { method: M }>;

/**
 * The reply payload for one method, as `REPLY_SCHEMAS[method]` outputs it.
 * Read off the schema's own `parse` so this package needs no `zod` import of
 * its own — the schema is the single source of the type.
 */
export type ReplyOf<M extends BlockingMethod> = ReturnType<(typeof REPLY_SCHEMAS)[M]['parse']>;

export interface PromptProps<M extends PromptMethod> {
  ask: AskOf<M>;
  /** Called once, with a reply that has already passed `REPLY_SCHEMAS[method]`. */
  onAnswer: (reply: ReplyOf<M>) => void;
  /** Names and combat facts for the ids an ask carries. See `lookup.ts`. */
  lookup: PromptLookup;
}

/** Thrown when a component builds an answer the wire schema rejects — a bug in the component. */
export class PromptAnswerError extends Error {
  constructor(
    readonly method: PromptMethod,
    readonly issues: readonly string[],
  ) {
    super(`reply to ${method} fails its wire schema:\n  ${issues.join('\n  ')}`);
    this.name = 'PromptAnswerError';
  }
}

/**
 * Parse a candidate reply through the method's wire schema, or throw.
 *
 * Every component answers through this, so a component that computes a
 * malformed reply fails loudly at the seam instead of handing the bridge
 * something `parseClientFrame` will refuse a hop later.
 */
export function checkedReply<M extends PromptMethod>(method: M, value: unknown): ReplyOf<M> {
  const schema = REPLY_SCHEMAS[method];
  const result = schema.safeParse(value);
  if (result.success) return result.data as ReplyOf<M>;
  throw new PromptAnswerError(
    method,
    result.error.issues.map((i) => `$${i.path.map((p) => `.${String(p)}`).join('')}: ${i.message}`),
  );
}

/**
 * Refuse, loudly, an answer `rules.ts` rejects. Components disable the button
 * that would send one, so reaching this is a component bug, never a user error.
 */
export function assertAnswerable(method: PromptMethod, problems: readonly string[]): void {
  if (problems.length > 0) throw new PromptAnswerError(method, problems);
}
