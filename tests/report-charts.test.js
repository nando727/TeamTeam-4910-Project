// Stories AD-31 and AD-32: the numbers behind the sales charts.
import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { compactDollars, shortLabel, buildRankedBars, buildTimeColumns } = require('../src/reports/charts');

const item = (name, totalCents, sales = 1, points = 10) => ({ name, totalCents, sales, points });

describe('totals by sponsor or driver', () => {
  test('no sales at all means no chart', () => {
    expect(buildRankedBars([], { noun: 'driver' })).toBeNull();
    expect(buildRankedBars([item('Quiet', 0, 0, 0)], { noun: 'sponsor' })).toBeNull();
  });

  test('one entity with sales is a figure, not a one-bar chart', () => {
    const chart = buildRankedBars([item('Northstar', '48816', '10', '4883'), item('Quiet', 0, 0, 0)], { noun: 'sponsor' });
    expect(chart.single).toMatchObject({ name: 'Northstar', totalCents: 48816, sales: 10, points: 4883 });
    expect(chart.notShown).toBe(1);
    expect(chart.bars).toBeUndefined();
  });

  test('bars run largest first, scale to the largest, and read string totals from the database', () => {
    const chart = buildRankedBars([item('Small', '100'), item('Big', '400'), item('Quiet', 0, 0, 0)], { noun: 'sponsor' });
    expect(chart.bars.map(bar => bar.name)).toEqual(['Big', 'Small']);
    expect(chart.bars[0].value).toBe('$4.00');
    expect(chart.notShown).toBe(1);
    expect(chart.folded).toBe(false);
    const width = bar => bar.valueX - 8 - chart.L;
    expect(width(chart.bars[0]) / width(chart.bars[1])).toBeCloseTo(4, 1);
  });

  test('bars stay thin, are rounded only at the data end, and a tiny value stays visible', () => {
    const chart = buildRankedBars([item('Huge', 100000000), item('Tiny', 1)], { noun: 'driver' });
    expect(chart.bars[1].valueX).toBeGreaterThanOrEqual(chart.L + 2 + 8);
    expect(chart.bars[0].d.startsWith(`M${chart.L} `)).toBe(true);
    expect(chart.bars[0].d).toContain('Q');
    expect(chart.bars[0].hit.h).toBeLessThanOrEqual(32);
  });

  test('the tail folds into one bar, so every sale is still counted', () => {
    const items = Array.from({ length: 13 }, (_, i) => item(`Driver ${i}`, (i + 1) * 100, 2, 5));
    const chart = buildRankedBars(items, { noun: 'driver' });
    expect(chart.bars).toHaveLength(11);
    expect(chart.folded).toBe(true);
    expect(chart.shownCount).toBe(10);
    const others = chart.bars[10];
    expect(others).toMatchObject({ name: 'All others (3 drivers)', other: true, totalCents: 600, sales: 6, points: 15 });
    expect(chart.bars.reduce((sum, bar) => sum + bar.totalCents, 0)).toBe(9100);
  });

  test('a long name is shortened on the axis and kept whole in the tooltip', () => {
    const name = 'The Extremely Long Named Freight and Logistics Company of South Carolina';
    const chart = buildRankedBars([item(name, 200), item('Short', 100)], { noun: 'sponsor' });
    expect(chart.bars[0].label.length).toBeLessThanOrEqual(26);
    expect(chart.bars[0].label.endsWith('…')).toBe(true);
    expect(chart.bars[0].name).toBe(name);
    expect(chart.bars[0].tipLabel).toContain(name);
    expect(shortLabel('Short name')).toBe('Short name');
  });
});

describe('sales over time', () => {
  const day = (date, totalCents, sales = 1) => ({ day: date, totalCents, sales });
  const sum = chart => chart.bars.reduce((total, bar) => total + bar.totalCents, 0);

  test('no sales means no chart', () => {
    expect(buildTimeColumns([], {})).toBeNull();
  });

  test.each([
    ['2026-10-01', '2026-10-31', 'day', 31],
    ['2026-10-01', '2026-11-01', 'week', 5],
    ['2026-04-01', '2026-09-29', 'week', 26],
    ['2026-04-01', '2026-09-30', 'month', 6],
    ['2025-11-15', '2026-06-01', 'month', 8],
  ])('%s to %s is drawn by %s', (from, to, unit) => {
    const chart = buildTimeColumns([day(from, 100), day(to, 250)], { from, to });
    expect(chart.unit).toBe(unit);
    // Both ends of the range land in a period, so no sale is lost.
    expect(sum(chart)).toBe(350);
    expect(chart.start).toBe(from);
    expect(chart.end).toBe(to);
  });

  test('sums each period, reads strings from the database, and draws only periods with sales', () => {
    const chart = buildTimeColumns([day('2026-10-02', '500', '2'), day('2026-10-05', '1500', '1'), day('2026-10-06', '250', '3')], { from: '2026-10-01', to: '2026-10-07' });
    expect(chart.unit).toBe('day');
    expect(chart.bars.map(bar => [bar.name, bar.totalCents, bar.sales])).toEqual([
      ['Oct 2, 2026', 500, 2], ['Oct 5, 2026', 1500, 1], ['Oct 6, 2026', 250, 3],
    ]);
    expect(chart.peak).toMatchObject({ value: '$15.00', when: 'on Oct 5, 2026' });
  });

  test('weeks count from the start of the range, and months name the calendar month', () => {
    const weekly = buildTimeColumns([day('2026-08-20', 8999), day('2026-10-19', 12999)], { from: '2026-08-20', to: '2026-10-22' });
    expect(weekly.bars.map(bar => bar.name)).toEqual(['Week of Aug 20, 2026', 'Week of Oct 15, 2026']);
    expect(weekly.peak.when).toBe('in the week of Oct 15, 2026');
    const monthly = buildTimeColumns([day('2025-12-31', 100), day('2026-01-01', 300)], { from: '2025-06-01', to: '2026-03-31' });
    expect(monthly.bars.map(bar => bar.name)).toEqual(['December 2025', 'January 2026']);
    expect(monthly.peak.when).toBe('in January 2026');
  });

  test('with no dates chosen the axis runs from the first sale to the last', () => {
    const chart = buildTimeColumns([day('2026-08-20', 100), day('2026-10-22', 100)], {});
    expect(chart.start).toBe('2026-08-20');
    expect(chart.end).toBe('2026-10-22');
  });

  test('an enormous date range shrinks to the sales instead of drawing decades of empty months', () => {
    const chart = buildTimeColumns([day('2026-08-20', 100), day('2026-10-22', 100)], { from: '1990-01-01', to: '2040-12-31' });
    expect(chart.start).toBe('2026-08-20');
    expect(chart.end).toBe('2026-10-22');
    expect(chart.unit).toBe('week');
  });

  test('the dollar axis starts at zero, clears the peak, and uses clean labels', () => {
    const chart = buildTimeColumns([day('2026-10-01', 12999)], { from: '2026-10-01', to: '2026-10-02' });
    expect(chart.ticks.map(tick => tick.label)).toEqual(['$0', '$50', '$100', '$150']);
    expect(compactDollars(50)).toBe('$0.50');
    expect(compactDollars(100000)).toBe('$1K');
    expect(compactDollars(150000)).toBe('$1.5K');
    expect(compactDollars(250000000)).toBe('$2.5M');
  });

  test('sales worth nothing do not break the chart', () => {
    const chart = buildTimeColumns([day('2026-10-01', 0, 2)], { from: '2026-10-01', to: '2026-10-03' });
    expect(chart.bars[0].d).toBeNull();
    expect(chart.peak.value).toBe('$0.00');
  });

  test('axis labels never crowd each other, whatever the number of periods', () => {
    for (let months = 7; months <= 60; months++) {
      const to = new Date(Date.UTC(2020, months - 1, 28)).toISOString().slice(0, 10);
      const chart = buildTimeColumns([day('2020-01-01', 100), day(to, 100)], { from: '2020-01-01', to });
      const xs = chart.xLabels.map(label => label.x);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(45);
    }
  });
});
