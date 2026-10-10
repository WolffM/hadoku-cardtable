/**
 * Turning what a browser received into match messages.
 *
 * `../frames.ts` pulls socket.io EVENTS (`2`) out of a capture, which is all a
 * draft needs. A match needs one more packet type: its snapshot is the ACK
 * (`3`) to `forge:join` / `forge:resync`, and that ack is the seat's WHOLE
 * state history — its hand included. An isolation check that skipped acks would
 * skip the biggest payload a seat is ever sent. So this parses both, from
 * websocket frames and long-polling bodies alike (U+001E-separated packets).
 */

import type { RawCapture } from '../frames.ts';

export type PlayKind = 's2c' | 'ack' | 'c2s' | 'join' | 'resync' | 'other';

export interface PlayMessage {
  t: number;
  dir: 'in' | 'out';
  via: 'ws' | 'polling';
  kind: PlayKind;
  /** The socket.io event name, or `ack`. */
  event: string;
  /** The packet's JSON array, byte for byte as it crossed the wire. */
  raw: string;
  /** The payload: an envelope, a snapshot, a request, a client envelope. */
  msg: unknown;
}

const RECORD_SEPARATOR = '\u001e';
const PACKET = /^([23])(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/;

const KIND: Readonly<Record<string, PlayKind>> = {
  'forge:s2c': 's2c',
  'forge:c2s': 'c2s',
  'forge:join': 'join',
  'forge:resync': 'resync',
};

export function playMessagesIn(capture: RawCapture): PlayMessage[] {
  const packets = capture.via === 'polling' ? capture.text.split(RECORD_SEPARATOR) : [capture.text];
  const out: PlayMessage[] = [];
  for (const packet of packets) {
    if (!packet.startsWith('4')) continue;
    const m = PACKET.exec(packet.slice(1));
    if (m === null) continue;
    const arr = JSON.parse(m[2]) as unknown[];
    const base = { t: capture.t, dir: capture.dir, via: capture.via, raw: m[2] };
    if (m[1] === '3') {
      out.push({ ...base, kind: 'ack', event: 'ack', msg: arr[0] });
      continue;
    }
    const [event, payload] = arr;
    if (typeof event !== 'string') throw new Error(`socket.io event with no name: ${packet.slice(0, 80)}`);
    out.push({ ...base, kind: KIND[event] ?? 'other', event, msg: payload });
  }
  return out;
}

export function playMessagesOf(captures: readonly RawCapture[]): PlayMessage[] {
  return captures.flatMap(playMessagesIn);
}

/** Is this ack a match snapshot (and not a draft ack or an `{ error }`)? */
export function isSnapshot(msg: unknown): msg is Snapshot {
  return typeof msg === 'object' && msg !== null && 'frames' in msg && 'playerId' in msg && 'seat' in msg;
}

export interface Cursor {
  epoch: string;
  seq: number;
}

export interface Frame {
  kind: string;
  method: string;
  callId?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Snapshot {
  matchId: string;
  seat: number;
  playerId: number;
  cursor: Cursor | null;
  frames: Frame[];
}

export interface ServerEnvelope {
  matchId: string;
  cursor: Cursor;
  frame: Frame;
  /** A notice the server already answered (a reveal): nothing replies to it (`packages/shared` `match-wire.ts`). */
  displayOnly?: true;
}
