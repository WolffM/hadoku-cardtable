/*
 * Reading something again while the tab is shown, and never while it is hidden.
 *
 * A hidden tab reads nothing; shown again, it reads at once, then on the timer. The room feed's
 * resilience read (`rooms/follow.ts`) and the front page's calendar and polls (`front/events.ts`,
 * `front/polls.ts`) all re-read on a timer, and a tab left open in the background used to keep
 * the last two going around the clock, each poll a request through the edge (and the polls one a
 * read of Rally behind it).
 */

/** The tab's visibility. */
export interface PageVisibility {
  hidden(): boolean;
  /** Called on every visibility change. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export function documentVisibility(doc: Document | undefined = globalThis.document): PageVisibility {
  return {
    hidden: () => doc?.visibilityState === 'hidden',
    onChange: (listener) => {
      doc?.addEventListener('visibilitychange', listener);
      return () => doc?.removeEventListener('visibilitychange', listener);
    },
  };
}

export interface RereadDeps {
  page?: PageVisibility;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Calls `read` now, every `ms` while the tab is shown, and once whenever it is shown again. Returns the stop. */
export function rereadWhileVisible(read: () => void, ms: number, deps: RereadDeps = {}): () => void {
  const page = deps.page ?? documentVisibility();
  const every = deps.setInterval ?? ((fn, at) => globalThis.setInterval(fn, at));
  const stopEvery = deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
  const whileVisible = (): void => {
    if (!page.hidden()) read();
  };
  whileVisible();
  const timer = every(whileVisible, ms);
  const stopVisibility = page.onChange(whileVisible);
  return () => {
    stopEvery(timer);
    stopVisibility();
  };
}
