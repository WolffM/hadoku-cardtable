/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/log`. `jsonLogger`
 * and `JsonLog` are fully generic (no cardtable value baked in), so this is a
 * pure re-export kept at this path for its one remaining importer,
 * `http/rooms.ts` — claimed by another session (w95b) this wave, so its
 * import line was not repointed. Every other importer now binds
 * `@hadoku/service-kernel/log` directly (w93-Z).
 */
export { jsonLogger, type JsonLog } from '@hadoku/service-kernel/log';
