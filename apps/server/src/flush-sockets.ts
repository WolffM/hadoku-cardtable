/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/lifecycle`'s `sendThenFlush`/
 * `closeConnections`. Both are fully generic (no cardtable value baked in), so this is a pure
 * re-export kept at this path (w93-K2).
 */
export { closeConnections, sendThenFlush, type Closable, type Flushable } from '@hadoku/service-kernel/lifecycle';
