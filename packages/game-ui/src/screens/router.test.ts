// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

import { createHashRouter } from './router.ts';

type R = { kind: 'home' } | { kind: 'room'; id: string };
const parse = (hash: string): R => {
  const id = /^#\/room\/([a-z0-9-]+)$/.exec(hash)?.[1];
  return id === undefined ? { kind: 'home' } : { kind: 'room', id };
};
const toHash = (r: R): string => (r.kind === 'room' ? `#/room/${r.id}` : '#/');

beforeEach(() => {
  globalThis.history.replaceState(null, '', '/app/');
});
afterEach(cleanup);

describe('createHashRouter, hash-only', () => {
  it('reads the route from the hash, on whatever path the page is on', () => {
    const router = createHashRouter<R>({ parse, toHash });
    globalThis.history.replaceState(null, '', '/app/some/where#/room/r-1');
    expect(router.currentRoute()).toEqual({ kind: 'room', id: 'r-1' });
  });

  it('navigates with a history entry, keeps the path, and tells the page', () => {
    const router = createHashRouter<R>({ parse, toHash });
    const seen: R[] = [];
    function Probe() {
      seen.push(router.useRoute());
      return null;
    }
    render(createElement(Probe));
    const before = globalThis.history.length;
    act(() => router.navigate({ kind: 'room', id: 'r-2' }));
    expect(`${globalThis.location.pathname}${globalThis.location.hash}`).toBe('/app/#/room/r-2');
    expect(globalThis.history.length).toBe(before + 1);
    expect(seen.at(-1)).toEqual({ kind: 'room', id: 'r-2' });
    act(() => router.navigate({ kind: 'room', id: 'r-2' }));
    expect(globalThis.history.length, 'arriving where it already is adds no entry').toBe(before + 1);
    act(() => router.navigate({ kind: 'home' }, { replace: true }));
    expect(globalThis.history.length).toBe(before + 1);
    expect(globalThis.location.hash).toBe('#/');
  });

  it('follows the address bar moving on its own', () => {
    const router = createHashRouter<R>({ parse, toHash });
    const seen: R[] = [];
    function Probe() {
      seen.push(router.useRoute());
      return null;
    }
    render(createElement(Probe));
    act(() => {
      globalThis.history.replaceState(null, '', '/app/#/room/r-3');
      globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(seen.at(-1)).toEqual({ kind: 'room', id: 'r-3' });
  });

  it('routes in memory for an embed, never touching the address bar, and gives it back', () => {
    const router = createHashRouter<R>({ parse, toHash });
    globalThis.history.replaceState(null, '', '/app/#/host');
    const release = router.routeInMemory({ kind: 'home' });
    expect(router.inMemory()).toBe(true);
    router.navigate({ kind: 'room', id: 'r-4' });
    expect(router.currentRoute()).toEqual({ kind: 'room', id: 'r-4' });
    expect(globalThis.location.hash).toBe('#/host');
    expect(() => router.routeInMemory({ kind: 'home' })).toThrow(/already routing in memory/);
    release();
    expect(router.inMemory()).toBe(false);
    router.navigate({ kind: 'room', id: 'r-5' });
    expect(globalThis.location.hash).toBe('#/room/r-5');
  });

  it('ignores a hash change while in memory', () => {
    const router = createHashRouter<R>({ parse, toHash });
    let renders = 0;
    function Probe() {
      renders += 1;
      router.useRoute();
      return null;
    }
    const release = router.routeInMemory({ kind: 'home' });
    render(createElement(Probe));
    const after = renders;
    act(() => {
      globalThis.history.replaceState(null, '', '/app/#/room/r-6');
      globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(renders).toBe(after);
    expect(router.currentRoute()).toEqual({ kind: 'home' });
    release();
  });
});

describe('createHashRouter, with path-addressed routes', () => {
  const paths = {
    toAddress: (r: R, base: string) => (r.kind === 'room' ? { path: `${base}room/${r.id}`, hash: '' } : { path: base, hash: '' }),
    fromLocation: (l: { pathname: string; hash: string }, base: string): R =>
      l.hash.length > 2 ? parse(l.hash) : parse(`#/${l.pathname.slice(base.length)}`),
    canonical: (l: { pathname: string; search: string; hash: string }, base: string) => {
      const r = l.hash.length > 2 ? parse(l.hash) : null;
      return r?.kind === 'room' ? `${base}room/${r.id}${l.search}` : null;
    },
  };

  it('writes a path for a route that lives at one, and reads it back', () => {
    const router = createHashRouter<R>({ parse, toHash, paths, base: () => '/app/' });
    router.navigate({ kind: 'room', id: 'r-7' });
    expect(globalThis.location.pathname).toBe('/app/room/r-7');
    expect(globalThis.location.hash).toBe('');
    expect(router.currentRoute()).toEqual({ kind: 'room', id: 'r-7' });
  });

  it('moves the page onto its canonical address', () => {
    const router = createHashRouter<R>({ parse, toHash, paths, base: () => '/app/' });
    globalThis.history.replaceState(null, '', '/app/?q=1#/room/r-8');
    router.canonicalize();
    expect(`${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`).toBe('/app/room/r-8?q=1');
  });
});
