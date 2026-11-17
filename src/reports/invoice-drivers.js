// Story AD-43: the fee on an invoice, itemized per driver.
//
// The amount due is and stays the sponsor_monthly_fees procedure's number:
// ROUND(total purchases × 1%), rounded once on the sponsor's whole month.
// The per-driver lines are a breakdown of that number, not a second
// calculation of it -- summing each driver's individually rounded 1% can
// land a cent above or below the bill, and an invoice whose itemization does
// not add up to its total looks wrong to exactly the person it is sent to.
//
// So the fee is apportioned by the largest-remainder method. One percent of
// cents is cents over one hundred, which keeps everything in integers: each
// driver's exact fee is totalCents/100, their floor is the whole cents of
// that, and the cents left between the sum of floors and the procedure's
// total go one each to the drivers whose fractional part was largest. Ties
// break by name and then username, so the same invoice always splits the
// same way.
//
// The loop at the end distributes whatever the difference is, in either
// direction. For a consistent invoice that difference is between zero and
// the number of drivers; when a purchase lands mid-preparation the page
// already warns, and the split still reconciles to the total being billed.

function apportionDriverFees(items, feeCents) {
  const byDriver = new Map();
  for (const item of items) {
    let driver = byDriver.get(item.driverUsername);
    if (!driver) {
      driver = { driverName: item.driverName, driverUsername: item.driverUsername, purchases: 0, totalCents: 0, points: 0 };
      byDriver.set(item.driverUsername, driver);
    }
    driver.purchases += 1;
    driver.totalCents += Number(item.amountCents);
    driver.points += Number(item.points);
  }

  const drivers = [...byDriver.values()].sort((a, b) =>
    a.driverName.localeCompare(b.driverName) || a.driverUsername.localeCompare(b.driverUsername));
  for (const driver of drivers) {
    driver.feeCents = Math.floor(driver.totalCents / 100);
    driver.remainder = driver.totalCents % 100;
  }

  let leftover = Number(feeCents) - drivers.reduce((sum, driver) => sum + driver.feeCents, 0);
  const byRemainder = [...drivers].sort((a, b) =>
    b.remainder - a.remainder || a.driverName.localeCompare(b.driverName) || a.driverUsername.localeCompare(b.driverUsername));
  for (let i = 0; leftover !== 0 && byRemainder.length; i++) {
    byRemainder[i % byRemainder.length].feeCents += Math.sign(leftover);
    leftover -= Math.sign(leftover);
  }

  for (const driver of drivers) delete driver.remainder;
  return drivers;
}

module.exports = { apportionDriverFees };
