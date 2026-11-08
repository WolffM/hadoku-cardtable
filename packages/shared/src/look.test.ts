import { describe, expect, it } from 'vitest';

import { SeatIdentitySchema } from './match-wire.ts';
import { RoomMemberSchema } from './room-view.ts';

const PICTURE = 'https://cdn.discordapp.com/avatars/1/a.png';

describe('a look on a member and a seat', () => {
  it('a member or a seat whose look does not read keeps everything else', () => {
    expect(RoomMemberSchema.parse({ id: 'fk:1', name: 'Ari', joinedAt: '', ready: true, avatarId: 'sage', look: 'nonsense' })).toEqual({ id: 'fk:1', name: 'Ari', joinedAt: '', ready: true, avatarId: 'sage' });
    expect(SeatIdentitySchema.parse({ seat: 0, claimed: true, playerId: 1, look: { picture: PICTURE } }).look).toEqual({ picture: PICTURE });
  });
});
