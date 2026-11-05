import { describe, expect, it } from 'vitest';

import { tierOfWhoami } from './whoami.ts';

describe('tierOfWhoami', () => {
  it('shows a member the operator has verified as a friend', () => {
    expect(tierOfWhoami({ userType: 'member', verified: true })).toBe('friend');
  });

  it('leaves a plain member a member, and every other tier as the fleet said', () => {
    expect(tierOfWhoami({ userType: 'member' })).toBe('member');
    for (const userType of ['public', 'friend', 'service', 'wife', 'admin'] as const) {
      expect(tierOfWhoami({ userType, verified: true })).toBe(userType);
    }
  });
});
