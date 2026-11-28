/**
 * Who hears that a recording changed on disk. Every writer of the recordings directory says so here
 * once its write has landed: the recorder finishing a match and moving an earlier epoch aside
 * (`writer.ts`), retention removing a file (`retention.ts`), an account erase rewriting one
 * (`erase/recordings.ts`), a rebuild writing its stream back. A reader that keeps the directory in
 * memory (the replay list's index) listens and reads that one recording again. Nothing watches the
 * directory, so a file put there by anything else is seen at the next boot, never before.
 */
import { resolve } from 'node:path';

type Listener = (id: string) => void;

const listeners = new Map<string, Set<Listener>>();

/** `id` is the recording's own (`<matchId>` or `<matchId>-e<N>`): its files were written, moved or removed. */
export function recordingChanged(dir: string, id: string): void {
	for (const listener of listeners.get(resolve(dir)) ?? []) listener(id);
}

export function onRecordingChanged(dir: string, listener: Listener): () => void {
	const key = resolve(dir);
	const set = listeners.get(key) ?? new Set();
	set.add(listener);
	listeners.set(key, set);
	return () => set.delete(listener);
}
