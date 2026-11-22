/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/erase`'s id walks (`placeholderId`/`replaceIds`
 * for an erase, `renameIds`/`moveIds`/`namesAny` for a merge; w93-K3). All are fully generic (no
 * cardtable value baked in), so this is a pure re-export kept at this path for its importers
 * (`erase/recordings.ts`, `room/draftRooms.ts`, `room/events.ts`, `room/lobby.ts`, `room/tournaments.ts`).
 */
export { moveIds, namesAny, placeholderId, renameIds, replaceIds, type IdMove } from '@hadoku/service-kernel/erase';
