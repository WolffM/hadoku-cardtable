// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';

import { HOST_CSS, mountEmbed } from './mount.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Ctx {
  theme: string;
  label: string;
}

let el: HTMLElement;
const fetched: string[] = [];

beforeEach(() => {
  document.adoptedStyleSheets ??= [];
  fetched.length = 0;
  vi.stubGlobal('fetch', (href: string) => {
    fetched.push(href);
    return Promise.resolve(new Response('.game { color: red; }', { status: 200 }));
  });
  el = document.createElement('div');
  document.body.append(el);
});

afterEach(() => {
  el.remove();
  vi.unstubAllGlobals();
});

function Game({ ctx, log }: { ctx: Ctx; log: string[] }) {
  useEffect(() => {
    log.push('effect');
    return () => void log.push('react unmounted');
  }, [log]);
  return createElement('p', { 'data-testid': 'game' }, ctx.label);
}

describe('mountEmbed', () => {
  it('draws the game in a shadow root with the frame’s rules first, and takes everything down in reverse', async () => {
    const log: string[] = [];
    const mount = mountEmbed<Ctx>({
      name: 'g',
      stylesheet: '/g/embed/g-embed.css',
      extraCss: () => '.extra {}',
      containerClass: 'g-embed',
      setup: ({ cleanup, container }) => {
        log.push(`setup in ${container.className}`);
        cleanup(() => log.push('setup undone'));
        return (next) => log.push(`before render ${next.label}`);
      },
      render: (ctx) => createElement(Game, { ctx, log }),
    });
    const mounted = await act(() => mount(el, { theme: 'dark', label: 'one' }));
    const shadow = el.shadowRoot!;
    expect(fetched).toEqual(['/g/embed/g-embed.css']);
    const css = [...shadow.adoptedStyleSheets[0]!.cssRules].map((r) => r.cssText).join('\n');
    expect(css.indexOf(':host')).toBeLessThan(css.indexOf('.game'));
    expect(css).toContain('.extra');
    expect(HOST_CSS).toContain('height: 100%');
    expect(shadow.querySelector('.g-embed [data-testid="game"]')?.textContent).toBe('one');
    expect(el.hasAttribute('data-theme'), 'no host theme unless asked').toBe(false);

    act(() => mounted.update({ theme: 'dark', label: 'two' }));
    expect(shadow.querySelector('[data-testid="game"]')?.textContent).toBe('two');

    act(() => mounted.unmount());
    expect(shadow.querySelector('.g-embed')).toBeNull();
    expect(shadow.adoptedStyleSheets).toEqual([]);
    // StrictMode runs the game's first effect twice; what matters is the order around it.
    const steps = log.filter((l) => l !== 'effect');
    expect(steps.slice(0, 2)).toEqual(['setup in g-embed', 'before render one']);
    expect(steps).toContain('before render two');
    expect(steps.slice(-2), 'React unmounts before the setup is undone').toEqual(['react unmounted', 'setup undone']);
  });

  it('refuses a second mount while one is live, and allows one after unmount', async () => {
    const mount = mountEmbed<Ctx>({ name: 'g', stylesheet: '/s.css', containerClass: 'c', render: () => null });
    const first = await act(() => mount(el, { theme: 'light', label: '' }));
    const other = document.createElement('div');
    await expect(mount(other, { theme: 'light', label: '' })).rejects.toThrow('g embed: already mounted');
    act(() => first.unmount());
    const again = await act(() => mount(other, { theme: 'light', label: '' }));
    act(() => again.unmount());
  });

  it('stamps the host’s theme when asked, follows it, and restores what was there', async () => {
    el.setAttribute('data-theme', 'host-own');
    const mount = mountEmbed<Ctx>({ name: 'g', stylesheet: '/s.css', containerClass: 'c', hostTheme: true, render: () => null });
    const mounted = await act(() => mount(el, { theme: 'ocean-dark', label: '' }));
    expect(el.getAttribute('data-theme')).toBe('ocean-dark');
    act(() => mounted.update({ theme: 'light', label: '' }));
    expect(el.getAttribute('data-theme')).toBe('light');
    act(() => mounted.unmount());
    expect(el.getAttribute('data-theme')).toBe('host-own');
  });

  it('hands an in-game hash link to the game, not the host’s address bar', async () => {
    const followed: string[] = [];
    const mount = mountEmbed<Ctx>({
      name: 'g',
      stylesheet: '/s.css',
      containerClass: 'c',
      followHashLink: (href) => followed.push(href),
      render: () => createElement('a', { href: '#/stats', 'data-testid': 'link' }, 'stats'),
    });
    globalThis.location.hash = '#/host';
    const mounted = await act(() => mount(el, { theme: 'light', label: '' }));
    act(() => (el.shadowRoot!.querySelector('[data-testid="link"]') as HTMLAnchorElement).click());
    expect(followed).toEqual(['#/stats']);
    expect(globalThis.location.hash).toBe('#/host');
    act(() => mounted.unmount());
  });

  it('undoes what it had set up when the stylesheet will not load, and can mount again', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 500 })));
    el.setAttribute('data-theme', 'host-own');
    const mount = mountEmbed<Ctx>({ name: 'g', stylesheet: '/s.css', containerClass: 'c', hostTheme: true, render: () => null });
    await expect(mount(el, { theme: 'dark', label: '' })).rejects.toThrow('/s.css answered 500');
    expect(el.getAttribute('data-theme')).toBe('host-own');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 200 })));
    const mounted = await act(() => mount(el, { theme: 'dark', label: '' }));
    act(() => mounted.unmount());
  });
});
