/**
 * The watchparty embed, for the specs: a friend's browser on the e2e host page, the
 * bound room mounted into it, and that room made playable.
 */

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EMBED_HOST_PATH } from '../edge.ts';
import { SESSION_COOKIE } from '../identities.ts';

/** A friend's browser at the embed's viewport, `init` run in every page before the host's own scripts. */
export async function embedContext(browser: Browser, name: string, init?: () => void): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  if (init !== undefined) await context.addInitScript(init);
  return context;
}

/** The host page for one watchparty room, mounting only when a spec says so. */
export function embedHostUrl(origin: string, roomKey: string, extra = ''): string {
  return `${origin}${EMBED_HOST_PATH}?roomKey=${encodeURIComponent(roomKey)}&mount=manual${extra}#/host-route`;
}

export const mountEmbed = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { embedHost: { mount(): Promise<void> } }).embedHost.mount());

/**
 * The bound room is made by the binding (`lobby.bindWatchparty`) with no mode, so it opens on the
 * leader's mode row with no seats yet, as any room created without one does; its leader picks
 * Classic, as `rooms.ts`'s create helper does for every other spec's room. A click and then the
 * checked state: the radio turns checked only when the server's answer comes back.
 */
export async function chooseClassic(page: Page): Promise<void> {
  const classic = page.getByTestId('constructed-mode-classic');
  await classic.click();
  await expect(classic).toBeChecked();
}
