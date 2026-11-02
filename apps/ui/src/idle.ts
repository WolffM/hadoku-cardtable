/** Run `fn` when the page is idle, or within two seconds. Imports nothing, so a module the server also runs may use it. */
export function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}
