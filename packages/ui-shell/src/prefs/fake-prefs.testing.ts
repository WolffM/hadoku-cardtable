/*
 * The fleet's preference service, in memory, for tests that mock `@wolffm/prefs-client`.
 *
 * One row per app id. A client holds what it last read or saved and hands it out from `peek()`,
 * the way the real client does: `usePrefs` (prefs-client 1.2.2 and later) renders `peek()` through
 * `useSyncExternalStore`, so a fake without it throws on mount, and a fake whose `read()` does not
 * update `peek()` and tell its subscribers leaves every component on `null`.
 *
 *   vi.mock('@wolffm/prefs-client', async () => {
 *     const { fakePrefs } = await import('@hadoku/ui-shell/prefs/testing');
 *     return { createPrefsClient: fakePrefs.createPrefsClient };
 *   });
 *
 * The test imports the same `fakePrefs` to read `rows`/`saves`, `push` a save from elsewhere, and
 * `reset()` between tests.
 */

type Row = Record<string, unknown>;
type Listener = (row: Row) => void;

/** The part of the real `PrefsClient` cardtable calls. */
export interface FakePrefsClient {
  readonly appId: string;
  read(): Promise<Row>;
  peek(): Row | null;
  save(patch: Row, opts?: { scope?: string }): Promise<void>;
  subscribe(listener: Listener): () => void;
  flush(): Promise<void>;
  reset(): void;
  destroy(): void;
}

export interface FakePrefs {
  /** Every app id's stored row. */
  readonly rows: Map<string, Row>;
  /** Every save, in order, with its scope (`user` when none was given). */
  readonly saves: { appId: string; patch: Row; scope: string }[];
  /** Drop every row, save, client and subscriber. */
  reset(): void;
  /** A save from somewhere else (another tab, another host on the page): every client of `appId` hears it. */
  push(appId: string, patch: Row): void;
  /** Stands in for prefs-client's own `createPrefsClient`. */
  createPrefsClient(opts: { appId: string }): FakePrefsClient;
}

export function createFakePrefs(): FakePrefs {
  const rows = new Map<string, Row>();
  const saves: FakePrefs['saves'] = [];
  const clients = new Set<{ appId: string; adopt: (row: Row) => void }>();

  const tellClientsOf = (appId: string, row: Row): void => {
    for (const c of clients) if (c.appId === appId) c.adopt(row);
  };

  return {
    rows,
    saves,
    reset() {
      rows.clear();
      saves.length = 0;
      clients.clear();
    },
    push(appId, patch) {
      const row = { ...rows.get(appId), ...patch };
      rows.set(appId, row);
      tellClientsOf(appId, row);
    },
    createPrefsClient({ appId }) {
      let held: Row | null = null;
      const listeners = new Set<Listener>();
      const adopt = (row: Row): void => {
        held = row;
        for (const fn of listeners) fn(row);
      };
      clients.add({ appId, adopt });
      return {
        appId,
        read() {
          if (held === null) adopt({ ...rows.get(appId) });
          return Promise.resolve({ ...held });
        },
        peek: () => held,
        save(patch, opts) {
          saves.push({ appId, patch, scope: opts?.scope ?? 'user' });
          const row = { ...rows.get(appId), ...patch };
          rows.set(appId, row);
          tellClientsOf(appId, row);
          return Promise.resolve();
        },
        subscribe(fn) {
          listeners.add(fn);
          return () => void listeners.delete(fn);
        },
        flush: () => Promise.resolve(),
        reset() {
          held = null;
        },
        destroy() {
          listeners.clear();
        },
      };
    },
  };
}

/** The one store every test file's mock shares; `reset()` it in `beforeEach`. */
export const fakePrefs = createFakePrefs();
