const { pointCost } = require('./pricing');
const { availability } = require('../products/availability');
const provider = require('../products/provider');

// Keep sponsor selections and rates, but use the provider's current price.
// Saved prices may be displayed as last-known values, never used to purchase.
function currentOffer(item, product) {
  const status = availability(product);
  const price = product && product.priceValue;
  const priceConfirmed = status !== 'unknown' && typeof price === 'number' && Number.isFinite(price) && price >= 0;
  return {
    ...item,
    price_value: priceConfirmed ? price : item.price_value,
    points_cost: priceConfirmed ? pointCost(price, item.points_per_dollar ?? 10) : item.points_cost,
    availability: status === 'available' && !priceConfirmed ? 'unknown' : status,
    priceConfirmed,
  };
}

async function currentOffers(items) {
  if (!items.length) return [];
  let products;
  try {
    products = await provider.listProducts({ allowStale: false, fresh: true });
  } catch (error) {
    if (!(error instanceof provider.FakeStoreError)) throw error;
    return items.map(item => currentOffer(item, { availability: 'unknown' }));
  }
  const byId = new Map(products.map(product => [product.productId, product]));
  return items.map(item => currentOffer(item, byId.get(item.product_id)));
}

module.exports = { currentOffer, currentOffers };
