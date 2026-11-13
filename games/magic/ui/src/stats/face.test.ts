import { describe, expect, it } from 'vitest';

import { faceOfAvatar } from './face.tsx';

describe('faceOfAvatar', () => {
  it('carries the picture, the character and what they wear onto the face', () => {
    expect(
      faceOfAvatar({ source: 'discord', url: 'https://cdn.discordapp.com/avatars/1/a.png', sprite: 'rook', cosmetics: { overlay: 'overlay.petals' } }),
    ).toEqual({ id: 'rook', look: { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.petals' } } });
  });

  it('is the character alone when they chose no picture', () => {
    expect(faceOfAvatar({ source: 'sprite', sprite: 'rook' })).toEqual({ id: 'rook', look: {} });
  });

  it('drops a picture that is not https, and keeps the rest', () => {
    expect(faceOfAvatar({ source: 'upload', url: 'http://example.com/a.png', sprite: 'rook' })).toEqual({ id: 'rook', look: {} });
  });

  it('is nobody when the store sent no avatar', () => {
    expect(faceOfAvatar(undefined)).toEqual({ id: null });
  });
});
