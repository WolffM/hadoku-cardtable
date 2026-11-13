import { describe, expect, it } from 'vitest';

import { tierOfWhoami } from './whoami.ts';

describe('tierOfWhoami', () => {
  it('shows a member the operator has verified as a friend', () => {
    expect(tierOfWhoami({ userType: 'member', verified: true })).toBe('friend');
  });

  it('leaves a plain member a member, and with the flag promotes nobody but a member', () => {
    expect(tierOfWhoami({ userType: 'member' })).toBe('member');
    for (const userType of ['public', 'member', 'friend', 'service', 'wife', 'admin'] as const) {
      expect(tierOfWhoami({ userType, verified: true }), userType).toBe(userType === 'member' ? 'friend' : userType);
    }
  });
});
