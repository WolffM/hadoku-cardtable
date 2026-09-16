/*
 * The child process `sigterm.test.ts` kills.
 *
 * §4.4's claim is about a real signal arriving at a real process, so the test
 * sends one. Faking it — calling `flushAllSync()` directly and asserting the
 * file — would test the flush and not the thing the flush is for: that the
 * handler is installed, that it runs before the process goes away, and that a
 * debounce which has not fired does not cost the room its state.
 *
 * Run as: `node sigtermChild.ts <dir> <roomId>`. Node 24 strips the types, which
 * is the same no-build posture the rest of the workspace runs on.
 */

import { FileRoomStore } from './fileStore.ts';
import { RoomPersistence } from './persistence.ts';
import { jsonCodec } from './snapshot.ts';

interface App {
  picks: string[];
}

const dir = process.argv[2];
const roomId = process.argv[3];
if (!dir || !roomId) {
  console.error('usage: sigtermChild.ts <dir> <roomId>');
  process.exit(2);
}

const persistence = new RoomPersistence<App>({
  store: new FileRoomStore(dir),
  codec: { app: jsonCodec<App>(1) },
  createApp: () => ({ picks: [] }),
  // Long enough that nothing can possibly flush on its own: everything the
  // parent reads off disk got there because of the signal.
  persist: { debounceMs: 600_000, maxIntervalMs: 3_600_000 },
});

const room = await persistence.loadOrCreate(roomId, 'room-key');
for (let i = 0; i < 25; i++) {
  room.app.picks.push(`pick-${i}`);
  room.lastEventSeq += 1;
  room.updatedAt = Date.now();
  persistence.markDirty(roomId);
}

persistence.installSignalHandlers(['SIGTERM']);

// The parent reads this line, then sends the signal. Everything it asserts is
// compared against these numbers — the room's state at the instant it arrived.
process.stdout.write(
  `${JSON.stringify({ ready: true, seq: room.lastEventSeq, picks: room.app.picks.length })}\n`,
);

// Stay up. A process with nothing scheduled exits on its own and would flush by
// accident, which is the one way this test could pass while proving nothing.
setInterval(() => {}, 60_000);
