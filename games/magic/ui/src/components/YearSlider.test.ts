// @vitest-environment jsdom
/*
 * The year slider: a ruler with a tick every year, taller every five and tallest every ten; a held
 * pill follows the pointer between years and settles on the nearest when let go, choosing once; a run
 * of nudges (‹ ›, keys) chooses once, where it rests; a year with no stop is muted and never chosen;
 * and it reads the year it is on, as text and as the slider's value text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { closest, lineFraction, nudged, SETTLE_MS, snapped, yearLine, YearSlider, type YearStop } from './YearSlider.tsx';
import { dragYearSlider, layOutYearSlider, pressYearSlider, yearSliderX } from './YearSlider.testing.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const year = (y: number): YearStop => ({ id: `y-${y}`, label: String(y), year: y });
const YEARS: YearStop[] = Array.from({ length: 12 }, (_, i) => year(2010 + i));

function mount(value: string | null, stops: YearStop[] = YEARS, onChange = vi.fn()): { onChange: typeof onChange; rerender: (value: string | null) => void } {
  const el = (v: string | null) => createElement(YearSlider, { stops, value: v, label: 'Standard year', testId: 'years', onChange });
  const { rerender } = render(el(value));
  return { onChange, rerender: (v) => rerender(el(v)) };
}

/** A room that takes what it is asked at once, as Classic's does (it holds the ask until the room answers). */
function Live({ stops, initial, onChange }: { stops: YearStop[]; initial: string; onChange: (id: string) => void }) {
  const [value, setValue] = useState(initial);
  return createElement(YearSlider, { stops, value, label: 'Standard year', testId: 'years', onChange: (id: string) => (onChange(id), setValue(id)) });
}

/** 2010 to 2021 on a 272 px line from x 100 with a 52 px pill: a year every 20 px, 2010 at x 126. */
const BOX = { left: 100, width: 272, pill: 52 };
const xOf = (place: number): number => yearSliderX(BOX, (place - 2010) / 11);

const root = (): HTMLElement => screen.getByTestId('years');
const slider = (): HTMLInputElement => within(root()).getByRole('slider');
/** Where the pill is drawn along the line, 0 to 1. */
const pillAt = (): number => Number(root().querySelector<HTMLElement>('.year-slider__track')!.style.getPropertyValue('--at'));
const thumb = (): string => screen.getByTestId('years').querySelector('.year-slider__thumb')?.textContent ?? '';
const ticks = (): HTMLElement[] => [...screen.getByTestId('years').querySelectorAll<HTMLElement>('.year-slider__tick')];

describe('yearLine', () => {
  it('ticks every year, taller every five and tallest every ten, labelling the fives and tens', () => {
    const line = yearLine([year(1995), year(1996), year(2003), year(2010), year(2011)]);
    expect([line.min, line.max]).toEqual([1995, 2011]);
    expect(line.ticks).toHaveLength(17);
    const ranked = line.ticks.filter((t) => t.rank !== 'year').map((t) => [t.at, t.rank, t.label]);
    expect(ranked).toEqual([
      [1995, 'half', '1995'],
      [2000, 'decade', '2000'],
      [2005, 'half', '2005'],
      [2010, 'decade', '2010'],
    ]);
    // A year with no stop is still a tick, marking no stop.
    expect(line.ticks.find((t) => t.at === 1999)?.stop).toBe(-1);
    expect(line.ticks.find((t) => t.at === 2003)?.stop).toBe(2);
  });

  it('labels an end that has no label within two years of it, and no other plain year', () => {
    const modern = yearLine(Array.from({ length: 15 }, (_, i) => year(2011 + i)));
    expect(modern.ticks.filter((t) => t.label !== null).map((t) => t.label)).toEqual(['2011', '2015', '2020', '2025']);
    expect(modern.ticks[0]!.rank).toBe('year');
    // 2009 sits a year from 2010's label, so it goes without one of its own.
    expect(yearLine([year(2009), year(2010), year(2013)]).ticks.filter((t) => t.label !== null).map((t) => t.label)).toEqual(['2010', '2013']);
  });

  it('puts the stop that is not a year one place left of the oldest', () => {
    const line = yearLine([{ id: '', label: 'All', year: null }, year(2012), year(2013)]);
    expect(line.places).toEqual([2011, 2012, 2013]);
    expect(line.ticks[0]).toEqual({ at: 2011, stop: 0, rank: 'other', label: 'All' });
  });

  it('keeps a year label from crowding the stop that is not a year: within two years of it, the year goes unlabelled', () => {
    const line = yearLine([{ id: '', label: 'Random', year: null }, year(2010), year(2015), year(2024)]);
    expect(line.ticks.filter((t) => t.label !== null).map((t) => t.label)).toEqual(['Random', '2015', '2020', '2024']);
  });

  it('spreads the places end to end, and a lone place sits in the middle', () => {
    expect([2010, 2015, 2020].map((at) => lineFraction(at, { min: 2010, max: 2020 }))).toEqual([0, 0.5, 1]);
    expect(lineFraction(2010, { min: 2010, max: 2010 })).toBe(0.5);
  });
});

describe('snapped and nudged', () => {
  const places = [2010, 2011, 2014, 2015];

  it('lands on a stop as it is, and past a year with none, carries on the way it was moving', () => {
    expect(snapped(places, 2014, 2011)).toBe(2);
    expect(snapped(places, 2012, 2011)).toBe(2);
    expect(snapped(places, 2013, 2014)).toBe(1);
    // A drag straight onto a gap from afar takes the nearest stop on the far side of it.
    expect(snapped(places, 2012, 2015)).toBe(1);
    expect(snapped(places, 2016, 2014)).toBe(3);
  });

  it('the closest stop to a place between years, the first of two as near', () => {
    expect(closest(places, 2012.4)).toBe(1);
    expect(closest(places, 2012.6)).toBe(2);
    expect(closest(places, 2012.5)).toBe(1);
    expect(closest(places, 2016, (p) => p < 2014)).toBe(1);
    expect(closest([], 2012)).toBe(-1);
  });

  it('steps one stop, stays on the line, and from nothing chosen starts at the newest', () => {
    expect(nudged(4, -1, 12)).toBe(3);
    expect(nudged(4, 1, 12)).toBe(5);
    expect(nudged(0, -1, 12)).toBe(0);
    expect(nudged(11, 1, 12)).toBe(11);
    expect(nudged(-1, -1, 12)).toBe(11);
    expect(nudged(-1, 1, 12)).toBe(11);
    expect(nudged(-1, 1, 0)).toBe(-1);
  });
});

describe('YearSlider', () => {
  it('is a slider over years that reads its year plainly, ranking its ticks', () => {
    mount('y-2015');
    expect(slider().getAttribute('aria-valuetext')).toBe('2015');
    expect(slider().getAttribute('aria-label')).toBe('Standard year');
    expect([slider().min, slider().max, slider().value]).toEqual(['2010', '2021', '2015']);
    expect(thumb()).toBe('2015');
    expect(ticks().map((t) => t.dataset.rank)).toEqual(['decade', 'year', 'year', 'year', 'year', 'half', 'year', 'year', 'year', 'year', 'decade', 'year']);
    expect(ticks().filter((t) => t.hasAttribute('data-on')).map((t) => t.dataset.at)).toEqual(['2015']);
    // Its words are the year, the ruler's tens and fives, and the two arrows: no dates, no names.
    expect(screen.getByTestId('years').textContent).toBe('‹201020152020' + '2015›');
  });

  it('mutes a year with no stop, and a key past it carries on to the next year that has one', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onChange } = mount('y-2011', [year(2010), year(2011), year(2014)]);
    expect(ticks().filter((t) => t.hasAttribute('data-muted')).map((t) => t.dataset.at)).toEqual(['2012', '2013']);
    expect(ticks().filter((t) => t.hasAttribute('data-muted')).every((t) => t.dataset.era === undefined)).toBe(true);
    fireEvent.change(slider(), { target: { value: '2012' } });
    expect(thumb()).toBe('2014');
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(onChange.mock.calls).toEqual([['y-2014']]);
  });

  it('a drag across many years chooses once, on release, where it let go', () => {
    const { onChange } = mount('y-2010');
    layOutYearSlider(root(), BOX);
    pressYearSlider(root(), xOf(2010));
    for (let y = 2011; y <= 2018; y += 1) fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(y) });
    // The pill follows the drag, and nothing is chosen while it is held; another pointer moves nothing.
    expect(thumb()).toBe('2018');
    fireEvent.pointerMove(window, { pointerId: 2, clientX: xOf(2012) });
    expect(thumb()).toBe('2018');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onChange.mock.calls).toEqual([['y-2018']]);
  });

  it('held, the pill follows the pointer between years and reads the nearest; let go, it settles on that year', () => {
    const onChange = vi.fn();
    render(createElement(Live, { stops: YEARS, initial: 'y-2012', onChange }));
    layOutYearSlider(root(), BOX);
    // Taken 5 px right of its centre, the pill keeps that grip: it does not jump to the pointer.
    pressYearSlider(root(), xOf(2012) + 5);
    expect(pillAt()).toBeCloseTo(2 / 11);
    expect(root().hasAttribute('data-gliding')).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(2015.35) + 5 });
    expect(pillAt()).toBeCloseTo(5.35 / 11);
    expect(root().hasAttribute('data-gliding')).toBe(true);
    expect(thumb()).toBe('2015');
    expect(ticks().filter((t) => t.hasAttribute('data-on')).map((t) => t.dataset.at)).toEqual(['2015']);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(2015.6) + 5 });
    expect(pillAt()).toBeCloseTo(5.6 / 11);
    expect(thumb()).toBe('2016');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onChange.mock.calls).toEqual([['y-2016']]);
    expect(pillAt()).toBeCloseTo(6 / 11);
    expect(root().hasAttribute('data-gliding')).toBe(false);
    expect(root().dataset.value).toBe('y-2016');
  });

  it('a press on the line, away from the pill, takes it straight to the year under it, and lets go on it', () => {
    const { onChange } = mount('y-2018');
    layOutYearSlider(root(), BOX);
    pressYearSlider(root(), xOf(2011) + 4);
    // On the year, not under the pointer: one glide, not a jump to the pointer and a second onto the year.
    expect(thumb()).toBe('2011');
    expect(pillAt()).toBeCloseTo(1 / 11);
    expect(root().hasAttribute('data-gliding')).toBe(false);
    expect(document.activeElement).toBe(slider());
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onChange.mock.calls).toEqual([['y-2011']]);
  });

  it('a press the page takes for a scroll chooses nothing, and the pill goes back', () => {
    const { onChange } = mount('y-2018');
    layOutYearSlider(root(), BOX);
    pressYearSlider(root(), xOf(2011));
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(2012) });
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(thumb()).toBe('2018');
    expect(pillAt()).toBeCloseTo(8 / 11);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a drag over years with no stop reads, and lets go on, the nearest year that has one', () => {
    const { onChange } = mount('y-2012', YEARS.filter((s) => s.year !== 2013 && s.year !== 2014));
    layOutYearSlider(root(), BOX);
    pressYearSlider(root(), xOf(2012));
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(2013.4) });
    expect(thumb()).toBe('2012');
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(2013.6) });
    expect(thumb()).toBe('2015');
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onChange.mock.calls).toEqual([['y-2015']]);
  });

  it('a drag that lets go where it began chooses nothing, and a disabled line takes no press', () => {
    const { onChange } = mount('y-2013');
    layOutYearSlider(root(), BOX);
    dragYearSlider(root(), [xOf(2013), xOf(2016), xOf(2013)]);
    expect(onChange).not.toHaveBeenCalled();
    cleanup();
    render(createElement(YearSlider, { stops: YEARS, value: 'y-2013', label: 'Standard year', disabled: true, testId: 'years', onChange }));
    dragYearSlider(root(), [xOf(2013), xOf(2016)]);
    expect(thumb()).toBe('2013');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a run of nudges chooses once, where it rests', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onChange } = mount('y-2015');
    const later = screen.getByTestId('years-later');
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(later);
      act(() => vi.advanceTimersByTime(SETTLE_MS - 50));
    }
    expect(thumb()).toBe('2019');
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));
    expect(onChange.mock.calls).toEqual([['y-2019']]);
  });

  it('a key that sets it (a nudge, not a drag) also waits to rest', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onChange } = mount('y-2015');
    fireEvent.change(slider(), { target: { value: '2014' } });
    fireEvent.change(slider(), { target: { value: '2013' } });
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(onChange.mock.calls).toEqual([['y-2013']]);
  });

  it('‹ and › step one year and stop at the ends', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onChange } = mount('y-2010');
    expect((screen.getByTestId('years-earlier') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('years-later'));
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(onChange.mock.calls).toEqual([['y-2011']]);
    cleanup();
    mount('y-2021');
    expect((screen.getByTestId('years-later') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('years-earlier') as HTMLButtonElement).disabled).toBe(false);
  });

  it('follows the value it is handed, and draws no thumb while none of its stops is chosen', () => {
    const { rerender } = mount('y-2012');
    rerender('y-2020');
    expect(thumb()).toBe('2020');
    expect(screen.getByTestId('years').dataset.value).toBe('y-2020');
    rerender('elsewhere');
    expect(screen.getByTestId('years').dataset.value).toBe('');
    expect(screen.getByTestId('years').hasAttribute('data-empty')).toBe(true);
    expect(slider().hasAttribute('aria-valuetext')).toBe(false);
    expect(ticks().some((t) => t.hasAttribute('data-on'))).toBe(false);
  });
});
