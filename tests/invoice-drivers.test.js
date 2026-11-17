// Story AD-43: the per-driver fee split. The one property that matters above
// all others is exactness: however the cents fall, the per-driver fees sum to
// precisely the number the stored procedure bills.
import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { apportionDriverFees } = require('../src/reports/invoice-drivers');

const item = (driverName, driverUsername, amountCents, points = 1) => ({ driverName, driverUsername, amountCents, points });
const sum = drivers => drivers.reduce((total, driver) => total + driver.feeCents, 0);

describe('grouping', () => {
  test('one row per driver, keyed by username, with purchases, totals, and points, sorted by name', () => {
    const drivers = apportionDriverFees([
      item('John Doe', 'driver1', 8999, 900),
      item('Dana Driver', 'driver2', 5900, 590),
      item('John Doe', 'driver1', 1299, 130),
    ], 162);
    expect(drivers.map(d => [d.driverName, d.driverUsername, d.purchases, d.totalCents, d.points])).toEqual([
      ['Dana Driver', 'driver2', 1, 5900, 590],
      ['John Doe', 'driver1', 2, 10298, 1030],
    ]);
    // Internal working values do not leak onto the invoice.
    expect(drivers[0]).not.toHaveProperty('remainder');
  });

  test('two drivers who happen to share a display name stay two drivers', () => {
    const drivers = apportionDriverFees([item('John Doe', 'jd1', 1000), item('John Doe', 'jd2', 2000)], 30);
    expect(drivers.map(d => d.driverUsername)).toEqual(['jd1', 'jd2']);
  });

  test('no purchases, no rows', () => {
    expect(apportionDriverFees([], 0)).toEqual([]);
  });
});

describe('rounding by largest remainder', () => {
  test('the odd cent goes to the larger fractional part, and the fees sum to the bill', () => {
    // Exact fees 59.00c and 102.98c; the procedure bills ROUND(161.98) = 162.
    const drivers = apportionDriverFees([item('Dana', 'd2', 5900), item('John', 'd1', 10298)], 162);
    expect(drivers.map(d => [d.driverName, d.feeCents])).toEqual([['Dana', 59], ['John', 103]]);
    expect(sum(drivers)).toBe(162);
  });

  test('every driver at half a cent: ties break by name, and the total still reconciles', () => {
    // Three drivers at 1050 cents each: exact fees 10.5c, total 3150 cents,
    // procedure bills ROUND(31.5) = 32. Floors are 10+10+10; two cents left.
    const drivers = apportionDriverFees([item('Ada', 'a', 1050), item('Bea', 'b', 1050), item('Cal', 'c', 1050)], 32);
    expect(drivers.map(d => d.feeCents)).toEqual([11, 11, 10]);
    expect(sum(drivers)).toBe(32);
  });

  test('a driver can owe zero cents when their purchases round away', () => {
    // 49 cents of purchases is a 0.49c fee; the other driver carries the bill.
    const drivers = apportionDriverFees([item('Ada', 'a', 49), item('Bea', 'b', 10000)], 100);
    expect(drivers.map(d => [d.driverName, d.feeCents])).toEqual([['Ada', 0], ['Bea', 100]]);
    expect(sum(drivers)).toBe(100);
  });

  test('the same invoice always splits the same way', () => {
    const items = [item('John', 'd1', 10298), item('Dana', 'd2', 5900), item('Ada', 'd3', 333)];
    const first = apportionDriverFees(items, 166);
    const second = apportionDriverFees([...items].reverse(), 166);
    expect(second).toEqual(first);
    expect(sum(first)).toBe(166);
  });

  test('fuzz: across many random invoices the split always sums to the procedure total', () => {
    let seed = 20261116;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 200; run++) {
      const driverCount = 1 + Math.floor(random() * 6);
      const items = [];
      for (let d = 0; d < driverCount; d++) {
        const buys = 1 + Math.floor(random() * 4);
        for (let b = 0; b < buys; b++) items.push(item(`Driver ${d}`, `user${d}`, 1 + Math.floor(random() * 20000)));
      }
      const totalCents = items.reduce((a, i) => a + i.amountCents, 0);
      const feeCents = Math.round(totalCents / 100); // what the procedure bills
      const drivers = apportionDriverFees(items, feeCents);
      expect(sum(drivers)).toBe(feeCents);
      // Nobody's fee drifts more than a cent from their exact share.
      for (const driver of drivers) {
        expect(Math.abs(driver.feeCents - driver.totalCents / 100)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('a total that disagrees with the line items still reconciles to what is billed', () => {
    // The page already warns about the inconsistency; the split must not make
    // it worse by showing fees that sum to some third number.
    const items = [item('Ada', 'a', 5000), item('Bea', 'b', 5000)];
    expect(sum(apportionDriverFees(items, 105))).toBe(105);
    expect(sum(apportionDriverFees(items, 97))).toBe(97);
  });
});
