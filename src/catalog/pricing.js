function pointCost(price, rate = 10) {
  const cents = Math.round(Number(price) * 100);
  const pointsPerDollar = Number(rate);
  const cost = Math.ceil(cents * pointsPerDollar / 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isInteger(pointsPerDollar) || pointsPerDollar < 1 || pointsPerDollar > 10000 || !Number.isSafeInteger(cost) || cost > 2147483647) {
    throw new Error('Invalid catalog price or conversion rate.');
  }
  return Math.max(1, cost);
}

module.exports = { pointCost };
