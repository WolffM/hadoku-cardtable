// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { GainSlider } from './GainSlider.tsx';

afterEach(() => cleanup());

describe('GainSlider', () => {
  it('moves freely while dragged, and commits once on release', () => {
    const commits: number[] = [];
    render(createElement(GainSlider, { label: 'Role', value: 1, onCommit: (v) => commits.push(v) }));
    const input = screen.getByRole('slider') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Role gain');
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.change(input, { target: { value: '0.4' } });
    expect(commits).toEqual([]);
    expect(screen.getByText('0.40')).toBeTruthy();
    fireEvent.pointerUp(input);
    expect(commits).toEqual([0.4]);
  });

  it('does not commit when it is let go back where it started', () => {
    const commits: number[] = [];
    render(createElement(GainSlider, { label: 'Role', value: 1, onCommit: (v) => commits.push(v) }));
    fireEvent.pointerUp(screen.getByRole('slider'));
    expect(commits).toEqual([]);
  });

  it('follows a new value prop in from outside (another tab’s save)', () => {
    const { rerender } = render(createElement(GainSlider, { label: 'Role', value: 1, onCommit: () => undefined }));
    rerender(createElement(GainSlider, { label: 'Role', value: 1.8, onCommit: () => undefined }));
    expect(screen.getByText('1.80')).toBeTruthy();
  });
});
