import { describe, expect, it } from 'vitest';

import { tierOfWhoami } from './whoami.ts';

const TIERS = ['public', 'guest', 'member', 'friend', 'service', 'wife', 'admin'] as const;

describe('tierOfWhoami', () => {
  it('shows a member (a guest the operator verified) as a friend, from the tier alone', () => {
    expect(tierOfWhoami({ userType: 'member' })).toBe('friend');
  });

  it('never promotes a guest, whatever the fleet says about verification', () => {
    expect(tierOfWhoami({ userType: 'guest' })).toBe('guest');
    expect(tierOfWhoami({ userType: 'guest', verified: true } as Parameters<typeof tierOfWhoami>[0])).toBe('guest');
  });

  it('promotes nobody but a member, with or without the flag', () => {
    for (const userType of TIERS) {
      const want = userType === 'member' ? 'friend' : userType;
      expect(tierOfWhoami({ userType }), userType).toBe(want);
      expect(tierOfWhoami({ userType, verified: true } as Parameters<typeof tierOfWhoami>[0]), userType).toBe(want);
      expect(tierOfWhoami({ userType, verified: false } as Parameters<typeof tierOfWhoami>[0]), userType).toBe(want);
    }
  });
});
