/*
 * `GET /api/sounds/pack`'s body: every cue take (`cueTakes`) in one answer.
 *
 * A first visit used to ask the edge for each take on its own, some two hundred requests of a
 * few kilobytes, every one a run of the edge worker. The pack is one, and like a take it is kept
 * for good at its version (`/api/sounds/assignments`' `pack`).
 *
 * The layout: the header's length as 4 bytes big-endian, the header (UTF-8 JSON
 * `{ takes: [{ file, size }] }`, in body order), then each take's bytes back to back.
 */

import { z } from 'zod';

const HeaderSchema = z.object({ takes: z.array(z.object({ file: z.string(), size: z.number().int().nonnegative() })) });

export function encodeSoundPack(takes: readonly { file: string; bytes: Uint8Array }[]): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify({ takes: takes.map((t) => ({ file: t.file, size: t.bytes.length })) }));
	const out = new Uint8Array(4 + header.length + takes.reduce((n, t) => n + t.bytes.length, 0));
	new DataView(out.buffer).setUint32(0, header.length);
	out.set(header, 4);
	let at = 4 + header.length;
	for (const t of takes) {
		out.set(t.bytes, at);
		at += t.bytes.length;
	}
	return out;
}

/** Each take's bytes by file, each in a buffer of its own (decoding audio detaches it). `null`: not a whole pack. */
export function decodeSoundPack(body: ArrayBuffer): Map<string, ArrayBuffer> | null {
	if (body.byteLength < 4) return null;
	const headerLength = new DataView(body).getUint32(0);
	if (4 + headerLength > body.byteLength) return null;
	let header: z.infer<typeof HeaderSchema>;
	try {
		const parsed = HeaderSchema.safeParse(JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, headerLength))));
		if (!parsed.success) return null;
		header = parsed.data;
	} catch {
		return null;
	}
	const out = new Map<string, ArrayBuffer>();
	let at = 4 + headerLength;
	for (const { file, size } of header.takes) {
		if (at + size > body.byteLength) return null;
		out.set(file, body.slice(at, at + size));
		at += size;
	}
	return at === body.byteLength ? out : null;
}
