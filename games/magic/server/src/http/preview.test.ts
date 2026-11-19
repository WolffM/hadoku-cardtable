import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Person } from "@hadoku/game-server/people";
import {
  attachPreview,
  cardOf,
  cardSvg,
  describeRoom,
  fieldOf,
  FIELD_FACES,
  previewFonts,
  seatsOf,
  type PreviewDeps,
  type PreviewRoom,
} from "./preview.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";
/** A 1×1 PNG, as a face's picture. */
const DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function room({
  format = "legacy-2022-04-29",
  mode = "gauntlet",
  modeOptions = { family: "modern" },
  ...over
}: Partial<PreviewRoom> & Partial<PreviewRoom["game"]> = {}): PreviewRoom {
  return {
    name: "Hadoku's Lair",
    gameType: "constructed-1v1",
    locked: false,
    testing: false,
    leader: "fk:host",
    creator: "fk:host",
    game: { format, mode, modeOptions },
    members: [{ id: "fk:host", name: "friend", joinedAt: "", ready: false }],
    tables: [{ players: [{ memberId: "fk:host" }] }],
    ...over,
  };
}

describe("describeRoom: [Format] [Mode] [Year] 1v1", () => {
  it("names a Gauntlet by its family, and its year when one is set", () => {
    expect(describeRoom(room())).toBe("Modern Gauntlet 1v1");
    expect(
      describeRoom(
        room({ modeOptions: { family: "legacy", year: 2015 } }),
      ),
    ).toBe("Legacy Gauntlet 2015 1v1");
    expect(describeRoom(room({ modeOptions: { year: 2019 } }))).toBe(
      "Gauntlet 2019 1v1",
    );
    expect(describeRoom(room({ modeOptions: {} }))).toBe("Gauntlet 1v1");
  });

  it("names Classic by the room's own format, and All Random by its pool", () => {
    expect(
      describeRoom(
        room({ mode: "classic", modeOptions: {}, format: "modern-2018-01-19" }),
      ),
    ).toBe("Modern Classic 2018 1v1");
    expect(
      describeRoom(room({ mode: "classic", modeOptions: {}, format: "free" })),
    ).toBe("Classic 1v1");
    expect(
      describeRoom(room({ mode: "random", modeOptions: { pool: "full" } })),
    ).toBe("All Random 1v1");
    expect(
      describeRoom(room({ mode: "random", modeOptions: { pool: "legacy" } })),
    ).toBe("Legacy All Random 1v1");
    expect(
      describeRoom(
        room({ mode: null, modeOptions: null, format: "2021-02-05" }),
      ),
    ).toBe("Standard 2021 1v1");
  });

  it("calls a draft room a Cube Draft", () => {
    expect(describeRoom(room({ gameType: "draft" }))).toBe("Cube Draft");
    const set = { kind: "set" as const, code: "BLB", style: "set-cube" as const };
    const planned = room({ gameType: "draft" });
    planned.game = { ...planned.game!, pod: { plan: { rounds: [set, set, set] }, roundNames: ["Bloomburrow", "Bloomburrow", "Bloomburrow"] } };
    expect(describeRoom(planned)).toBe("Draft · Bloomburrow · Set-cube");
  });

  it("calls a constructed room that plays a pod a Tournament, never a 1v1", () => {
    expect(describeRoom(tournament([]))).toBe("Modern Gauntlet Tournament");
  });
});

/** A constructed tournament in its lobby, with these seats. */
function tournament(
  seats: NonNullable<NonNullable<PreviewRoom["game"]>["pod"]>["seats"],
  over: Partial<PreviewRoom> = {},
): PreviewRoom {
  const r = room(over);
  r.game = { ...r.game!, pod: { plan: null, roundNames: null, phase: "lobby", seats } };
  return r;
}

describe("seatsOf", () => {
  it("is the host against the table's other player, or an open seat", () => {
    expect(seatsOf(room())).toEqual({ host: "fk:host", other: null });
    expect(
      seatsOf(
        room({
          tables: [
            { players: [{ memberId: "fk:sage" }, { memberId: "fk:host" }] },
          ],
        }),
      ),
    ).toEqual({ host: "fk:host", other: "fk:sage" });
    expect(
      seatsOf(
        room({
          gameType: "draft",
          tables: [{ players: [{ memberId: "fk:sage" }] }],
        }),
      ),
    ).toEqual({ host: "fk:host", other: null });
    // A tournament seats its field, not a table: nobody is the host's opponent.
    expect(
      seatsOf(tournament([], { tables: [{ players: [{ memberId: "fk:host" }, { memberId: "fk:sage" }] }] })),
    ).toEqual({ host: "fk:host", other: null });
  });
});

describe("fieldOf", () => {
  const mentor = { name: "Mentor", avatarId: "mentor" };

  it("is the lobby's seats: members, each AI seat's own character and the open ones, never a closed one", () => {
    expect(
      fieldOf(
        tournament([
          { memberId: "fk:host", name: "friend" },
          { memberId: "ai", ...mentor },
          null,
          { memberId: "closed", name: "" },
        ]),
      ),
    ).toEqual([{ memberId: "fk:host" }, { ai: mentor }, null]);
  });

  it("is everyone who entered once the pod is past its lobby, an AI entrant by its persona", () => {
    const r = tournament([null, null]);
    r.game!.pod = { ...r.game!.pod!, phase: "rounds", drafters: ["fk:host", "ai:1"], personas: { "ai:1": mentor } };
    expect(fieldOf(r)).toEqual([{ memberId: "fk:host" }, { ai: mentor }]);
  });

  it("is the host alone for a draft room with no pod on it", () => {
    expect(fieldOf(room({ gameType: "draft" }))).toEqual([{ memberId: "fk:host" }]);
  });
});

describe("cardSvg", () => {
  const face = (name: string) => ({ name, picture: null, pixel: false });

  it("draws an open seat as You?, escapes names, and cuts a long one", () => {
    const svg = cardSvg(
      { kind: "duel", left: face('A <b> & "c"'), right: null },
      new Map(),
    );
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).toContain(">You?<");
    expect(svg).toContain(">VS<");
    expect(svg).toContain("stroke-dasharray");
    expect(
      cardSvg({ kind: "duel", left: face("x".repeat(30)), right: null }, new Map()),
    ).toContain(`${"x".repeat(15)}…`);
  });

  it("draws a field under its kind, with no VS and no You?: a circle a place, open seats dashed", () => {
    const svg = cardSvg(
      { kind: "field", label: "Tournament", faces: [face("Ann"), face("Bo"), null], more: 0 },
      new Map(),
    );
    expect(svg).toContain(">Tournament<");
    expect(svg).not.toContain(">VS<");
    expect(svg).not.toContain(">You?<");
    expect(svg.match(/<clipPath /g)).toHaveLength(3);
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(1);
  });

  it("keeps every circle of a field on the card, and counts the ones it has no room for", () => {
    for (const n of [1, 2, 8, 9, FIELD_FACES]) {
      const more = n === FIELD_FACES ? 5 : 0;
      const faces = Array.from({ length: more > 0 ? n - 1 : n }, (_, i) => face(`p${i}`));
      const svg = cardSvg({ kind: "field", label: "Draft", faces, more }, new Map());
      const circles = [...svg.matchAll(/<clipPath id="clip-\d+"><circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
      expect([n, circles.length]).toEqual([n, n]);
      for (const [cx, cy, r] of circles) {
        expect(cx! - r!).toBeGreaterThanOrEqual(40);
        expect(cx! + r!).toBeLessThanOrEqual(1160);
        expect(cy! - r!).toBeGreaterThanOrEqual(170);
        expect(cy! + r!).toBeLessThanOrEqual(590);
      }
      // No two overlap.
      for (const [i, a] of circles.entries())
        for (const b of circles.slice(i + 1))
          expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)).toBeGreaterThan(a[2]! + b[2]!);
      if (more > 0) expect(svg).toContain(">+5<");
    }
  });
});

describe("GET /preview/room/:id.{html,png}", () => {
  const rooms = new Map<string, PreviewRoom>();
  const fetched: string[] = [];
  let base: string;
  let close: () => void;
  let deps: PreviewDeps;
  const people: Person = {
    name: "Hadoku",
    sprite: "mentor",
    look: { picture: "https://cdn.discordapp.com/avatars/1/a.png" },
  };

  beforeAll(async () => {
    rooms.set("r-open", room());
    rooms.set("r-locked", room({ locked: true }));
    rooms.set("r-testing", room({ testing: true }));
    rooms.set(
      "r-tournament",
      tournament([
        { memberId: "fk:host", name: "friend" },
        { memberId: "ai", name: "Mentor", avatarId: "mentor" },
        null,
      ]),
    );
    rooms.set("r-crowd", tournament(Array.from({ length: 20 }, (_, i) => ({ memberId: "ai", name: `Bot ${i}`, avatarId: "mentor" }))));
    rooms.set(
      "r-unnamed",
      room({
        members: [
          {
            id: "fk:host",
            name: "friend",
            joinedAt: "",
            ready: false,
            avatarId: "mentor",
          },
        ],
      }),
    );
    rooms.set(
      "r-doll",
      room({
        members: [
          {
            id: "fk:host",
            name: "friend",
            joinedAt: "",
            ready: false,
            avatarId: "doll",
          },
        ],
      }),
    );
    rooms.set(
      "r-evil",
      room({
        members: [
          {
            id: "fk:host",
            name: "Mallory",
            joinedAt: "",
            ready: false,
            look: { picture: "https://169.254.169.254/latest/x.png" },
          },
        ],
      }),
    );
    const app = express();
    const router = express.Router();
    deps = {
      rooms: {
        get: (id) => rooms.get(id),
        usersOf: (id) =>
          rooms.has(id)
            ? [
                {
                  memberId: "fk:host",
                  userId:
                    id === "r-evil" || id === "r-unnamed" || id === "r-doll" ? "u-gone" : "u-host",
                },
              ]
            : [],
      },
      people: {
        resolve: async (ids) =>
          new Map(ids.filter((i) => i === "u-host").map((i) => [i, people])),
      },
      watchpartyBase: "https://hadoku.me/watchparty",
      fontFiles: previewFonts(),
      rateLimit: null,
      fetch: (async (url: string | URL | Request) => {
        fetched.push(String(url));
        return new Response(DOT, { headers: { "content-type": "image/png" } });
      }) as typeof fetch,
    };
    attachPreview(router, deps);
    app.use(router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("answers the room's name and its line as og tags", async () => {
    const res = await fetch(`${base}/preview/room/r-open.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const html = await res.text();
    expect(html).toContain(
      '<meta property="og:title" content="Hadoku&#39;s Lair">',
    );
    expect(html).toContain(
      '<meta property="og:description" content="Modern Gauntlet 1v1">',
    );
  });

  it("draws a 1200×630 PNG with the host’s picture, and keeps it for the next crawler", async () => {
    const res = await fetch(`${base}/preview/room/r-open.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(fetched).toEqual(["https://cdn.discordapp.com/avatars/1/a.png"]);
    await (await fetch(`${base}/preview/room/r-open.png`)).arrayBuffer();
    expect(fetched).toHaveLength(1);
  });

  it("never fetches a picture from a host a look may not name", async () => {
    fetched.length = 0;
    const res = await fetch(`${base}/preview/room/r-evil.png`);
    expect(res.status).toBe(200);
    expect(fetched).toEqual([]);
  });

  // The edge caches a sprite for a year: a portrait redrawn in place is asked for at its revision.
  it("asks for a redrawn character's portrait at its revision", async () => {
    const found = await cardOf("r-doll", rooms.get("r-doll")!, deps);
    expect(found?.card).toMatchObject({ kind: "duel", left: { picture: "https://hadoku.me/watchparty/media/sprites/square_doll.png?v=2" } });
  });

  it("never prints the room's placeholder name, and keeps no card drawn without the person", async () => {
    const found = await cardOf("r-unnamed", rooms.get("r-unnamed")!, deps);
    expect(found).toEqual({
      card: {
        kind: "duel",
        left: {
          name: "",
          picture: "https://hadoku.me/watchparty/media/sprites/square_mentor.png",
          pixel: true,
        },
        right: null,
      },
      complete: false,
    });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/preview/room/r-unnamed.png`);
      expect(res.status).toBe(200);
      // Not kept by us (the second is drawn again) nor by the edge.
      expect(res.headers.get("cache-control")).toBe("no-store");
      await res.arrayBuffer();
    }
  });

  it("draws a tournament as its field, each picture fetched once, and says Tournament in its line", async () => {
    const found = await cardOf("r-tournament", rooms.get("r-tournament")!, deps);
    expect(found).toEqual({
      card: {
        kind: "field",
        label: "Tournament",
        faces: [
          { name: "Hadoku", picture: "https://cdn.discordapp.com/avatars/1/a.png", pixel: false },
          { name: "Mentor", picture: "https://hadoku.me/watchparty/media/sprites/square_mentor.png", pixel: true },
          null,
        ],
        more: 0,
      },
      complete: true,
    });
    fetched.length = 0;
    const res = await fetch(`${base}/preview/room/r-tournament.png`);
    expect(res.status).toBe(200);
    const png = Buffer.from(await res.arrayBuffer());
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(fetched.sort()).toEqual([
      "https://cdn.discordapp.com/avatars/1/a.png",
      "https://hadoku.me/watchparty/media/sprites/square_mentor.png",
    ]);
    expect(await (await fetch(`${base}/preview/room/r-tournament.html`)).text()).toContain(
      '<meta property="og:description" content="Modern Gauntlet Tournament">',
    );
  });

  it("draws the first of a field too large for the card, and counts the rest", async () => {
    const found = await cardOf("r-crowd", rooms.get("r-crowd")!, deps);
    expect(found?.card).toMatchObject({ kind: "field", more: 5 });
    expect(found?.card.kind === "field" && found.card.faces).toHaveLength(FIELD_FACES - 1);
  });

  it("is the same 404 for a room behind a password, a testing room, an unknown room and a bad path", async () => {
    for (const path of [
      "r-locked.html",
      "r-locked.png",
      "r-testing.png",
      "r-nope.html",
      "r-open.jpg",
      "R_BAD.png",
    ]) {
      const res = await fetch(`${base}/preview/room/${path}`);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});
