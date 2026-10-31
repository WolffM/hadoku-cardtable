// @vitest-environment jsdom
/*
 * Wave 31 P3b: a fresh browser has no prefs cache, so the avatar has to come from
 * the ACCOUNT (`@wolffm/prefs-client/avatar`). The SDK is mocked at its
 * edge; what is asserted is which value wins and what happens when it cannot be
 * read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { get, create } = vi.hoisted(() => {
  const get = vi.fn();
  const create = vi.fn(() => ({ get }));
  return { get, create };
});

vi.mock('@wolffm/prefs-client/avatar', () => ({ createAvatarClient: create }));

import { accountAvatarId, watchpartyPrefsCacheKey } from './avatar.ts';

afterEach(() => {
  get.mockReset();
  globalThis.localStorage.clear();
});

describe('accountAvatarId', () => {
  it('reads the account, for a browser with no cache row', async () => {
    get.mockResolvedValue({ avatar: { source: 'discord', url: 'https://cdn.example/a.png' }, sprite: 'knight' });
    expect(await accountAvatarId('u-fresh')).toBe('knight');
  });

  it('points the SDK at this page’s origin, not a hardcoded host', async () => {
    get.mockResolvedValue({ sprite: null });
    await accountAvatarId('u-x');
    expect(create).toHaveBeenCalledWith({ baseUrl: `${globalThis.location.origin}/prefs` });
  });

  it('falls back to this browser’s cache when the account cannot be read', async () => {
    get.mockRejectedValue(new Error('offline'));
    globalThis.localStorage.setItem(
      watchpartyPrefsCacheKey('u-cached'),
      JSON.stringify({ blob: { sprite: 'rogue' } }),
    );
    expect(await accountAvatarId('u-cached')).toBe('rogue');
  });

  it('is null when neither knows: the unset case is watchparty’s to fill', async () => {
    get.mockResolvedValue({ sprite: null });
    expect(await accountAvatarId('u-none')).toBeNull();
  });
});
