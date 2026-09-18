/**
 * Turning what a browser received into draft envelopes.
 *
 * socket.io starts on HTTP long-polling and upgrades to a websocket
 * (`apps/ui/src/draft/socket.ts` keeps the default transports on purpose), so
 * the first envelopes a context gets — often its `state` snapshot — can arrive
 * in a polling RESPONSE body rather than a websocket frame. A capture that only
 * listened to the websocket would miss exactly the payload that matters most.
 * The spec records both, as raw text, and this file parses either.
 *
 * engine.io v4 text framing: a polling body is packets joined by U+001E; each
 * packet is one type digit then data. Type `4` is a message, whose data is a
 * socket.io packet: type digit, optional `/namespace,`, optional ack id, JSON.
 * Only socket.io EVENTs (`2`) carry draft envelopes: `["draft:s2c", {...}]`.
 */

export type Direction = 'in' | 'out';
export type Via = 'ws' | 'polling';

/** One raw capture, exactly as the browser saw it. */
export interface RawCapture {
  t: number;
  dir: Direction;
  via: Via;
  text: string;
}

/** One socket.io event pulled out of a capture. */
export interface Envelope {
  t: number;
  dir: Direction;
  via: Via;
  event: string;
  /** The whole event, `["draft:s2c",{…}]`, byte for byte as received. */
  raw: string;
  // The whole point is that nothing about its shape is assumed.
  msg: unknown;
}

const RECORD_SEPARATOR = '\u001e';
const EVENT = /^2(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/;

/** Every socket.io event in one capture. Non-event packets are skipped. */
export function eventsIn(capture: RawCapture): Envelope[] {
  const packets = capture.via === 'polling' ? capture.text.split(RECORD_SEPARATOR) : [capture.text];
  const out: Envelope[] = [];
  for (const packet of packets) {
    if (!packet.startsWith('4')) continue; // open/ping/pong/upgrade/noop
    const m = EVENT.exec(packet.slice(1));
    if (m === null) continue; // CONNECT, DISCONNECT, acks — no draft payload
    const arr = JSON.parse(m[1]) as unknown[];
    const [event, payload] = arr;
    if (typeof event !== 'string') throw new Error(`socket.io event with no name: ${packet.slice(0, 80)}`);
    out.push({
      t: capture.t,
      dir: capture.dir,
      via: capture.via,
      event,
      raw: m[1],
      msg: payload,
    });
  }
  return out;
}

/** Every event in a capture log, in capture order. */
export function envelopesOf(captures: readonly RawCapture[]): Envelope[] {
  return captures.flatMap(eventsIn);
}
