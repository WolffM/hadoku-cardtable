/**
 * A minimal socket.io client over Node's own WebSocket — just enough of the
 * protocol to be one more connection of a participant.
 *
 * It exists because the board cannot act (see `hands.ts`), and the e2e package
 * depends on nothing but Playwright. engine.io v4 over a websocket from the
 * first packet: `0{…}` open → we send `40`; `40{sid}` connected; `2` ping →
 * `3` pong; `42[…]` an event; `42<id>[…]` an event wanting an ack, answered by
 * the server as `43<id>[…]`. A namespace-connect refusal is `44{…}`.
 *
 * Identity is the session cookie, sent on the upgrade the way a browser would
 * send it, so the stand-in edge stamps this connection exactly as it stamps
 * that friend's browser: the server sees the same participant.
 */

import { SESSION_COOKIE } from '../identities.ts';

export interface SioClient {
  on(event: string, handler: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  request(event: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  readonly closed: boolean;
}

const PACKET = /^4([0-6])(?:\/[^,]*,)?(\d*)([\s\S]*)$/;

export function connectSio(origin: string, session: string, prefix = '/cardtable'): Promise<SioClient> {
  const url = `${origin.replace(/^http/, 'ws')}${prefix}/socket.io/?EIO=4&transport=websocket`;
  const ws = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${session}` } } as unknown as string[]);
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const acks = new Map<number, (payload: unknown) => void>();
  let nextAck = 0;
  let closed = false;
  const closedP = new Promise<void>((r) => ws.addEventListener('close', () => {
    closed = true;
    r();
  }));

  return new Promise((resolveConnect, rejectConnect) => {
    ws.addEventListener('error', () => rejectConnect(new Error(`websocket error on ${url}`)));
    ws.addEventListener('message', (ev: MessageEvent) => {
      const text = String(ev.data);
      if (text.startsWith('0')) {
        ws.send('40');
        return;
      }
      if (text === '2') {
        ws.send('3');
        return;
      }
      const m = PACKET.exec(text);
      if (m === null) return;
      const [, type, id, body] = m;
      if (type === '0') {
        resolveConnect(client);
      } else if (type === '4') {
        rejectConnect(new Error(`namespace connect refused: ${body}`));
      } else if (type === '2') {
        const [event, payload] = JSON.parse(body) as [string, unknown];
        for (const h of handlers.get(event) ?? []) h(payload);
      } else if (type === '3') {
        const done = acks.get(Number(id));
        acks.delete(Number(id));
        done?.((JSON.parse(body) as unknown[])[0]);
      }
    });

    const client: SioClient = {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      emit(event, payload) {
        ws.send(`42${JSON.stringify([event, payload])}`);
      },
      request(event, payload, timeoutMs = 10_000) {
        const id = nextAck++;
        return new Promise((resolveAck, rejectAck) => {
          const timer = setTimeout(() => {
            acks.delete(id);
            rejectAck(new Error(`${event} was not acked in ${timeoutMs} ms`));
          }, timeoutMs);
          acks.set(id, (response) => {
            clearTimeout(timer);
            resolveAck(response);
          });
          ws.send(`42${id}${JSON.stringify([event, payload])}`);
        });
      },
      close() {
        if (!closed) ws.close();
        return closedP;
      },
      get closed() {
        return closed;
      },
    };
  });
}
