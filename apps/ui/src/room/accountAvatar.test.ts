// @vitest-environment jsdom
/*
 * Wave 31 P3b: a fresh browser has no prefs cache, so the avatar has to come from
 * the ACCOUNT (`@wolffm/prefs-client`, app `watchparty`). The SDK is mocked at its
 * edge; what is asserted is which value wins and what happens when it cannot be
 * read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { read, create } = vi.hoisted(() => {
  const read = vi.fn();
  const create = vi.fn(() => ({ read }));
  return { read, create };
});

vi.mock('@wolffm/prefs-client', () => ({ createPrefsClient: create }));

import { accountAvatarId, watchpartyPrefsCacheKey } from './avatar.ts';

afterEach(() => {
  read.mockReset();
  globalThis.localStorage.clear();
});

describe('accountAvatarId', () => {
  it('reads the account, for a browser with no cache row', async () => {
    read.mockResolvedValue({ sprite: 'knight', theme: 'dark' });
    expect(await accountAvatarId('u-fresh')).toBe('knight');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ appId: 'watchparty' }));
  });

  it('points the SDK at this page’s origin, not a hardcoded host', async () => {
    read.mockResolvedValue({});
    await accountAvatarId('u-x');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ apiBase: `${globalThis.location.origin}/prefs` }),
    );
  });

  it('falls back to this browser’s cache when the account cannot be read', async () => {
    read.mockRejectedValue(new Error('offline'));
    globalThis.localStorage.setItem(
      watchpartyPrefsCacheKey('u-cached'),
      JSON.stringify({ blob: { sprite: 'rogue' } }),
    );
    expect(await accountAvatarId('u-cached')).toBe('rogue');
  });

  it('is null when neither knows: the unset case is watchparty’s to fill', async () => {
    read.mockResolvedValue({});
    expect(await accountAvatarId('u-none')).toBeNull();
  });
});
