const provider = require('./provider');

function availability(product) {
  if (!product) return 'unavailable';
  return product.availability || 'available';
}

async function currentProduct(id) {
  try {
    return await provider.getProduct(Number(id), { allowStale: false });
  } catch (error) {
    if (error instanceof provider.FakeStoreError) {
      return { availability: error.status === 404 ? 'unavailable' : 'unknown', description: '' };
    }
    throw error;
  }
}
module.exports = { availability, currentProduct };
