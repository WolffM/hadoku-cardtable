// @vitest-environment jsdom
/*
 * The viewer's avatar, read from their account (`@wolffm/prefs-client/avatar`).
 * The SDK is mocked at its edge; what is asserted is which value comes back
 * and what happens when it cannot be read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { get, create } = vi.hoisted(() => {
  const get = vi.fn();
  const create = vi.fn(() => ({ get }));
  return { get, create };
});

vi.mock('@wolffm/prefs-client/avatar', () => ({ createAvatarClient: create }));

import { accountAvatarId } from './avatar.ts';

afterEach(() => {
  get.mockReset();
});

describe('accountAvatarId', () => {
  it('reads the account', async () => {
    get.mockResolvedValue({ avatar: { source: 'discord', url: 'https://cdn.example/a.png' }, sprite: 'knight' });
    expect(await accountAvatarId()).toBe('knight');
  });

  it('points the SDK at this page’s origin, not a hardcoded host', async () => {
    get.mockResolvedValue({ sprite: null });
    await accountAvatarId();
    expect(create).toHaveBeenCalledWith({ baseUrl: `${globalThis.location.origin}/prefs` });
  });

  it('is null when the viewer has never picked one', async () => {
    get.mockResolvedValue({ sprite: null });
    expect(await accountAvatarId()).toBeNull();
  });

  it('is null when the account cannot be read, rather than guessing', async () => {
    get.mockRejectedValue(new Error('offline'));
    expect(await accountAvatarId()).toBeNull();
  });
});
