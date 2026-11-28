import { generateKeyPairSync } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  RELAY_PROTOCOL,
  SHARED_HOLD_MS,
  SHARED_SILENT_MS,
} from "@hadoku/host-wire";

import { AgentClient, LinkGroup, WATCH_STALL_MS } from "./client.js";

function client() {
  const clock = { t: 1_000_000 };
  const logs: Record<string, unknown>[] = [];
  const c = new AgentClient({
    url: "http://claw-9:7621",
    key: generateKeyPairSync("ed25519").privateKey,
    fenceMs: 10_000,
    now: () => clock.t,
    log: (e) => logs.push(e),
  });
  const lost: string[] = [];
  c.onLost((r) => lost.push(r));
  /** One tick of the link clock every second for `ms`, as `connect`'s interval runs it. */
  const tick = (ms: number) => {
    for (let i = 0; i < ms / 1000; i++) {
      clock.t += 1000;
      c.watch();
    }
  };
  return { c, clock, logs, lost, tick };
}

describe("AgentClient link clock", () => {
  it("fails the claw after the fencing window of real silence", () => {
    const k = client();
    k.tick(10_000);
    expect(k.lost).toEqual([]);
    k.tick(1000);
    expect(k.lost).toEqual(["agent heartbeat lost for 11 s (window 10 s)"]);
  });

  it("does not count its own stall as the claw going silent (hokon, 2026-10-31 21:59Z)", () => {
    const k = client();
    k.tick(2000);
    // The process froze for 24 s: no tick ran, and the heartbeats that came are still unread.
    k.clock.t += 24_000;
    k.c.watch();
    expect(k.lost).toEqual([]);
    expect(k.logs).toContainEqual({
      evt: "agent-watch-stalled",
      agent: "claw-9:7621",
      gapMs: 24_000,
      silentMs: 26_000,
    });
    // From the resume the claw has a whole window again, and real silence past it is still loss.
    k.tick(10_000);
    expect(k.lost).toEqual([]);
    k.tick(1000);
    expect(k.lost).toEqual(["agent heartbeat lost for 11 s (window 10 s)"]);
  });

  it("reports only the silence it was awake to hear, while its own stall is not yet ticked (hokon, 2026-11-24 00:31Z)", () => {
    const k = client();
    k.tick(2000);
    // Another claw's loss ran first after the resume and asked every claw's silence before this
    // claw's tick did: its heartbeats are still unread, so 19 s of "silence" is mostly our own
    // stall. What counts is the 2 s it heard before it froze.
    k.clock.t += 17_000;
    expect(k.c.silentMs()).toBe(2000);
    k.c.watch();
    expect(k.c.silentMs()).toBe(0);
    k.clock.t += 2000;
    expect(k.c.silentMs()).toBe(2000);
  });

  it("a late tick inside the stall threshold is not a stall", () => {
    const k = client();
    k.tick(8000);
    k.clock.t += WATCH_STALL_MS;
    k.c.watch();
    expect(k.lost).toEqual(["agent heartbeat lost for 11 s (window 10 s)"]);
  });
});

describe("AgentClient shared silence (hokon network stalls: 11-27 04:09Z, 05:32Z, 06:39Z; 11-28 09:33Z)", () => {
  /** Three claws on one link group and one clock, as `placement/index.ts` makes them. */
  function fleet() {
    const clock = { t: 1_000_000 };
    const logs: Record<string, unknown>[] = [];
    const stalls: unknown[] = [];
    const group = new LinkGroup((s) => stalls.push(s));
    const lost: Record<string, string> = {};
    const make = (name: string) => {
      const c = new AgentClient({
        url: `http://${name}:7621`,
        key: generateKeyPairSync("ed25519").privateKey,
        fenceMs: 10_000,
        now: () => clock.t,
        log: (e) => logs.push(e),
        group,
      });
      c.onLost((r) => (lost[name] = r));
      return c;
    };
    const claws = {
      "claw-8": make("claw-8"),
      "claw-9": make("claw-9"),
      "claw-10": make("claw-10"),
    };
    /** Heartbeats from these claws, as `receive` takes them. */
    const beat = (...names: (keyof typeof claws)[]) => {
      for (const n of names)
        (claws[n] as unknown as { receive(f: unknown): void }).receive({
          t: "hb",
          at: clock.t,
          jvms: [],
          slice: {},
          draftbot: null,
        });
    };
    const tick = (ms: number, beating: (keyof typeof claws)[] = []) => {
      for (let i = 0; i < ms / 1000; i++) {
        clock.t += 1000;
        if (i % 2 === 1) beat(...beating);
        for (const c of Object.values(claws)) c.watch();
      }
    };
    return { clock, logs, lost, claws, beat, tick, stalls };
  }

  it("waits out a silence every claw shares, and takes them all back with nothing failed over", () => {
    const f = fleet();
    f.tick(40_000);
    expect(f.lost).toEqual({});
    expect(
      f.logs
        .filter((e) => e.evt === "agent-silence-shared")
        .map((e) => e.agent),
    ).toEqual(["claw-8:7621", "claw-9:7621", "claw-10:7621"]);
    f.beat("claw-8", "claw-9", "claw-10");
    f.tick(1000);
    expect(
      f.logs
        .filter((e) => e.evt === "agent-silence-ended")
        .map((e) => [e.agent, e.silentMs]),
    ).toEqual([
      ["claw-8:7621", 40_000],
      ["claw-9:7621", 40_000],
      ["claw-10:7621", 40_000],
    ]);
    // Named once for the whole episode, not once a claw.
    expect(f.stalls).toEqual([
      { kind: "network", phase: "began", claws: 3, silentMs: 11_000 },
      { kind: "network", phase: "ended", claws: 3, silentMs: 40_000 },
    ]);
    // Healthy again: a real silence after it is judged on the plain window.
    f.tick(12_000, ["claw-9", "claw-10"]);
    expect(f.lost).toEqual({
      "claw-8": "agent heartbeat lost for 11 s (window 10 s)",
    });
  });

  it("fails over as usual once a shared silence outlasts SHARED_HOLD_MS", () => {
    const f = fleet();
    f.tick(SHARED_HOLD_MS);
    expect(f.lost).toEqual({});
    f.tick(1000);
    expect(Object.keys(f.lost).sort()).toEqual(["claw-10", "claw-8", "claw-9"]);
    expect(f.lost["claw-8"]).toBe(
      `agent heartbeat lost for ${SHARED_HOLD_MS / 1000 + 1} s (window 10 s, shared by every claw)`,
    );
  });

  it("a claw silent alone is lost at the plain window: the others are beating", () => {
    const f = fleet();
    f.tick(11_000, ["claw-9", "claw-10"]);
    expect(f.lost).toEqual({
      "claw-8": "agent heartbeat lost for 11 s (window 10 s)",
    });
  });

  it("a claw still silent when the others come back gets one more window from then, not the rest of the hold", () => {
    const f = fleet();
    f.tick(30_000);
    f.beat("claw-9", "claw-10");
    f.tick(10_000, ["claw-9", "claw-10"]);
    expect(f.lost).toEqual({});
    f.tick(1000, ["claw-9", "claw-10"]);
    expect(f.lost).toEqual({
      "claw-8":
        "agent heartbeat lost for 41 s (window 10 s, shared by every claw)",
    });
  });

  it("the claw that crossed the window first counts the others as sharing once they missed two beats (11-28 09:33:47Z: claw-9 and claw-10 at 5 s)", () => {
    const f = fleet();
    f.tick(4000, ["claw-9", "claw-10"]);
    // claw-8 has been silent since the start; claw-9/10 go quiet now.
    f.tick(SHARED_SILENT_MS);
    f.tick(10_000 - 4000 - SHARED_SILENT_MS + 1000);
    expect(f.lost).toEqual({});
  });

  it("one claw alone has no one to share a silence with", () => {
    const clock = { t: 0 };
    const c = new AgentClient({
      url: "http://claw-8:7621",
      key: generateKeyPairSync("ed25519").privateKey,
      fenceMs: 10_000,
      now: () => clock.t,
      group: new LinkGroup(),
    });
    const lost: string[] = [];
    c.onLost((r) => lost.push(r));
    for (let i = 0; i < 11; i++) {
      clock.t += 1000;
      c.watch();
    }
    expect(lost).toEqual(["agent heartbeat lost for 11 s (window 10 s)"]);
  });

  it("names this process's own stall once, however many links saw it", () => {
    const f = fleet();
    f.tick(2000, ["claw-8", "claw-9", "claw-10"]);
    f.clock.t += 17_000;
    for (const c of Object.values(f.claws)) c.watch();
    expect(f.stalls).toEqual([
      { kind: "loop", phase: "began", claws: 3, silentMs: 17_000 },
    ]);
    expect(f.lost).toEqual({});
  });
});

/**
 * An agent's relay over a real socket: it answers the upgrade with the 101 and, in the same write,
 * `after` (its hello, as the agent emits it straight after the 101), then `later` once the client
 * is attached. Node hands the bytes that came with the 101 to the upgrade's `head`, not to `data`.
 */
async function relayWith(
  after: string,
  later: string,
): Promise<{ logs: Record<string, unknown>[]; done: () => void }> {
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    s.once("data", () => {
      s.write(
        `HTTP/1.1 101 Switching Protocols\r\nupgrade: ${RELAY_PROTOCOL}\r\nconnection: Upgrade\r\nx-agent-nonce: n\r\n\r\n${after}`,
      );
      setTimeout(() => s.write(later), 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const logs: Record<string, unknown>[] = [];
  const c = new AgentClient({
    url: `http://127.0.0.1:${port}`,
    key: generateKeyPairSync("ed25519").privateKey,
    log: (e) => logs.push(e),
  });
  await c.connect();
  return {
    logs,
    done: () => {
      c.close();
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

describe("AgentClient relay: the bytes that arrive with the 101 (claw-8, 2026-11-28 18:29Z: relay back, no agent-hello)", () => {
  const hello = JSON.stringify({
    t: "hello",
    agentPid: 7,
    version: "v",
    running: ["h-1"],
    fenceMs: 90_000,
  });
  const hb = JSON.stringify({
    t: "hb",
    at: 1,
    jvms: [],
    slice: { max: 1, used: 0 },
  });

  it("reads a hello sent in the same packet as the 101", async () => {
    const r = await relayWith(`${hello}\n`, "");
    try {
      await vi.waitFor(() =>
        expect(r.logs.filter((e) => e.evt === "agent-hello")).toEqual([
          {
            evt: "agent-hello",
            agent: expect.any(String),
            version: "v",
            pid: 7,
            running: ["h-1"],
            fenceMs: 90_000,
          },
        ]),
      );
    } finally {
      r.done();
    }
  });

  it("joins a line the 101 packet cut short to the rest of it in the next one", async () => {
    const r = await relayWith(
      `${hello}\n${hb.slice(0, 10)}`,
      `${hb.slice(10)}\n${hello}\n`,
    );
    try {
      await vi.waitFor(() =>
        expect(r.logs.filter((e) => e.evt === "agent-hello")).toHaveLength(2),
      );
    } finally {
      r.done();
    }
  });

  it("drops a relay that sends a line it cannot read, and opens it again, instead of throwing", async () => {
    const r = await relayWith(`${hello}\n`, "not json\n");
    try {
      await vi.waitFor(() =>
        expect(r.logs.map((e) => e.evt)).toEqual(
          expect.arrayContaining([
            "agent-hello",
            "agent-relay-garbled",
            "agent-relay-dropped",
          ]),
        ),
      );
    } finally {
      r.done();
    }
  });
});
