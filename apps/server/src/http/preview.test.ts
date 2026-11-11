import express from "express";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Person } from "../people.js";
import {
  attachPreview,
  facesOf,
  cardSvg,
  describeRoom,
  previewFonts,
  seatsOf,
  type PreviewDeps,
  type PreviewRoom,
} from "./preview.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
  });
});

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
  });
});

describe("cardSvg", () => {
  it("draws an open seat as You?, escapes names, and cuts a long one", () => {
    const svg = cardSvg(
      { name: 'A <b> & "c"', picture: null, pixel: false },
      null,
      new Map(),
    );
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).toContain(">You?<");
    expect(svg).toContain("stroke-dasharray");
    expect(
      cardSvg(
        { name: "x".repeat(30), picture: null, pixel: false },
        null,
        new Map(),
      ),
    ).toContain(`${"x".repeat(15)}…`);
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
                    id === "r-evil" || id === "r-unnamed" ? "u-gone" : "u-host",
                },
              ]
            : [],
      },
      people: {
        resolve: async (ids) =>
          new Map(ids.filter((i) => i === "u-host").map((i) => [i, people])),
      },
      watchpartyBase: "https://hadoku.me/watchparty",
      fontFiles: previewFonts(PKG_ROOT),
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

  it("never prints the room's placeholder name, and keeps no card drawn without the person", async () => {
    const faces = await facesOf("r-unnamed", rooms.get("r-unnamed")!, deps);
    expect(faces).toEqual({
      left: {
        name: "",
        picture: "https://hadoku.me/watchparty/media/sprites/square_mentor.png",
        pixel: true,
      },
      right: null,
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
