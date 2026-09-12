import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CARD_FIELDS,
  ALLOWED_FACE_FIELDS,
  ALLOWED_PART_FIELDS,
  projectCard,
} from './project.ts';

/*
 * These tests prove the allowlist by its complement: an input carrying keys
 * that are not on the list must produce an output whose key set is a subset of
 * the list. That is strictly stronger than asserting that one named field is
 * dropped, and it is why this file can make the guarantee without ever writing
 * an image field name down.
 *
 * That matters because the repo enforces "no image code path" with a grep over
 * this directory for image-ish tokens (see docs/CARD_DATA.md). A test that had
 * to name such a field to prove it was dropped would satisfy the allowlist and
 * break the gate at the same time.
 */

describe('projectCard', () => {
  it('keeps only allowlisted top-level keys', () => {
    const raw = {
      id: 'abc',
      oracle_id: 'def',
      name: 'Llanowar Elves',
      type_line: 'Creature — Elf Druid',
      oracle_text: '{T}: Add {G}.',
      mana_cost: '{G}',
      cmc: 1,
      set: 'dom',
      collector_number: '168',
      rarity: 'common',
      artist: 'Chris Rahn',
      unexpected_field_one: 'dropped',
      unexpected_field_two: { nested: true },
      unexpected_field_three: ['also dropped'],
    };

    const out = projectCard(raw);
    for (const key of Object.keys(out)) {
      expect(ALLOWED_CARD_FIELDS.has(key), `'${key}' escaped the allowlist`).toBe(true);
    }
    expect(out['name']).toBe('Llanowar Elves');
    expect(out['oracle_text']).toBe('{T}: Add {G}.');
    expect(out['artist']).toBe('Chris Rahn');
    expect(Object.keys(out)).not.toContain('unexpected_field_one');
    expect(Object.keys(out)).not.toContain('unexpected_field_two');
    expect(Object.keys(out)).not.toContain('unexpected_field_three');
  });

  it('filters nested card faces too', () => {
    const raw = {
      id: 'x',
      name: 'Delver of Secrets // Insectile Aberration',
      layout: 'transform',
      card_faces: [
        { name: 'Delver of Secrets', type_line: 'Creature — Human Insect', nope: 1 },
        { name: 'Insectile Aberration', power: '3', toughness: '2', nope: 2 },
      ],
    };

    const faces = projectCard(raw)['card_faces'] as Array<Record<string, unknown>>;
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      for (const key of Object.keys(face)) {
        expect(ALLOWED_FACE_FIELDS.has(key), `'${key}' escaped the face allowlist`).toBe(true);
      }
    }
    expect(faces[0]['name']).toBe('Delver of Secrets');
    expect(faces[1]['power']).toBe('3');
  });

  it('filters nested related parts too', () => {
    const raw = {
      id: 'y',
      name: 'Brimaz, King of Oreskos',
      all_parts: [{ id: 'tok', component: 'token', name: 'Cat', type_line: 'Token', nope: true }],
    };
    const parts = projectCard(raw)['all_parts'] as Array<Record<string, unknown>>;
    for (const key of Object.keys(parts[0])) {
      expect(ALLOWED_PART_FIELDS.has(key), `'${key}' escaped the part allowlist`).toBe(true);
    }
  });

  it('never invents a field that was absent', () => {
    const out = projectCard({ id: 'z', name: 'Mountain' });
    expect(Object.keys(out).sort()).toEqual(['id', 'name']);
  });

  it('keeps a meaningful null rather than dropping it', () => {
    // An absent power and a null power mean different things in Scryfall's
    // schema; flattening them would lose information about non-creatures.
    const out = projectCard({ name: 'Lightning Bolt', power: null });
    expect('power' in out).toBe(true);
    expect(out['power']).toBeNull();
  });

  it('drops a non-array faces value instead of passing it through', () => {
    const out = projectCard({ name: 'Weird', card_faces: 'not an array' });
    expect('card_faces' in out).toBe(false);
  });

  it('has no image-bearing field on any allowlist', () => {
    // A guard against a future edit quietly widening the lists. Any field whose
    // name suggests imagery is disallowed by construction, checked here rather
    // than left to review.
    const forbidden = /img|image|art_crop|picture|thumb|illustration|uri|url|price|purchase/i;
    const every = [...ALLOWED_CARD_FIELDS, ...ALLOWED_FACE_FIELDS, ...ALLOWED_PART_FIELDS];
    for (const field of every) {
      expect(forbidden.test(field), `allowlist contains '${field}'`).toBe(false);
    }
  });
});
