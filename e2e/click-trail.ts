/**
 * What a page did with one control's click, read only when the click did not take. tournament.spec's
 * Tournament radio was clicked three times on CI (11-20 twice, 11-22) and the room never heard: the
 * play stack's log shows no settings PATCH at all after the click, and nothing on the client said
 * whether the click reached the input, the input was disabled or replaced under it, or the write was
 * dropped before it left. This records each of those, quietly: a passing run never reads it.
 */
import type { Page, Request } from '@playwright/test';

interface TrailWindow {
  __clickTrail?: { lines: string[]; stop: () => void };
}

/** Starts recording `testId`'s input events, its replacements and its `disabled` flips, and the page's writes. Returns the reader. */
export async function traceControl(page: Page, testId: string): Promise<{ read: () => Promise<string> }> {
  const writes: string[] = [];
  const t0 = Date.now();
  const onRequest = (r: Request): void => {
    if (r.method() !== 'GET') writes.push(`+${Date.now() - t0}ms ${r.method()} ${new URL(r.url()).pathname}`);
  };
  const onFailed = (r: Request): void => {
    writes.push(`+${Date.now() - t0}ms FAILED ${r.method()} ${new URL(r.url()).pathname}: ${r.failure()?.errorText ?? '?'}`);
  };
  const errors: string[] = [];
  const onError = (e: Error): void => {
    errors.push(`+${Date.now() - t0}ms pageerror ${e.message}`);
  };
  page.on('request', onRequest);
  page.on('requestfailed', onFailed);
  page.on('pageerror', onError);
  await page.evaluate((id) => {
    const w = window as unknown as TrailWindow;
    w.__clickTrail?.stop();
    const lines: string[] = [];
    const t0 = performance.now();
    const at = (): string => `+${Math.round(performance.now() - t0)}ms`;
    const nodes = new WeakMap<Element, number>();
    let serial = 0;
    const nodeOf = (el: Element | null): string => {
      if (el === null) return 'none';
      if (!nodes.has(el)) nodes.set(el, ++serial);
      return `#${nodes.get(el)}`;
    };
    const control = (): HTMLInputElement | null => document.querySelector(`[data-testid="${id}"]`);
    const state = (el: HTMLInputElement | null): string => (el === null ? 'absent' : `${nodeOf(el)} disabled=${el.disabled} checked=${el.checked} connected=${el.isConnected}`);
    lines.push(`${at()} start ${state(control())}`);
    const onEvent = (e: Event): void => {
      const target = e.target instanceof Element ? e.target : null;
      const own = target !== null && target.closest(`[data-testid="${id}"]`) !== null;
      const what = target === null ? '?' : (target.closest('[data-testid]')?.getAttribute('data-testid') ?? target.tagName.toLowerCase());
      const point = e instanceof MouseEvent ? ` at ${e.clientX},${e.clientY}` : '';
      lines.push(`${at()} ${e.type} on ${own ? 'the control' : what}${point}; control ${state(control())}`);
    };
    const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'input', 'change'];
    for (const type of types) document.addEventListener(type, onEvent, true);
    let last = control();
    const observer = new MutationObserver(() => {
      const now = control();
      if (now !== last) {
        lines.push(`${at()} control replaced: ${last === null ? 'absent' : nodeOf(last)} -> ${state(now)}`);
        last = now;
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    const flips = new MutationObserver((records) => {
      for (const r of records) if (r.target === control()) lines.push(`${at()} disabled attribute ${r.oldValue === null ? 'added' : 'removed'}; control ${state(control())}`);
    });
    flips.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    w.__clickTrail = {
      lines,
      stop: () => {
        for (const type of types) document.removeEventListener(type, onEvent, true);
        observer.disconnect();
        flips.disconnect();
      },
    };
  }, testId);
  return {
    read: async () => {
      page.off('request', onRequest);
      page.off('requestfailed', onFailed);
      page.off('pageerror', onError);
      const lines = await page
        .evaluate(() => {
          const w = window as unknown as TrailWindow;
          w.__clickTrail?.stop();
          return w.__clickTrail?.lines ?? ['the trail was lost: the page navigated'];
        })
        .catch((err: unknown) => [`the trail could not be read: ${err instanceof Error ? err.message : String(err)}`]);
      return [`what the page saw of ${testId}:`, ...lines, `the page's writes: ${writes.length === 0 ? 'none' : writes.join('; ')}`, ...errors].join('\n');
    },
  };
}
