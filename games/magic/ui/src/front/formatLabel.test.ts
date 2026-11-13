import { describe, expect, it } from 'vitest';

import { formatEraLabel, formatEraYear } from './formatLabel.ts';

describe('formatEraLabel', () => {
  it('reads a Modern/Legacy era id as its family and year', () => {
    expect(formatEraLabel('legacy-2011-07-15')).toBe('Legacy 2011');
    expect(formatEraLabel('modern-2011-07-15')).toBe('Modern 2011');
  });

  it('reads a bare date as a Standard era', () => {
    expect(formatEraLabel('2018-07-13')).toBe('Standard 2018');
  });

  it('returns anything it does not recognise unchanged', () => {
    expect(formatEraLabel('free')).toBe('free');
    expect(formatEraLabel('')).toBe('');
    expect(formatEraLabel('Vintage Cube')).toBe('Vintage Cube');
  });
});

describe('formatEraYear', () => {
  it('reads every era id shape as its year alone', () => {
    expect(formatEraYear('legacy-2011-07-15')).toBe('2011');
    expect(formatEraYear('modern-2025-06-30')).toBe('2025');
    expect(formatEraYear('1995-07-01')).toBe('1995');
  });

  it('returns anything it does not recognise unchanged', () => {
    expect(formatEraYear('free')).toBe('free');
    expect(formatEraYear('')).toBe('');
  });
});
