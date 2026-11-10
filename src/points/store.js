const db = require('../db');

// Every point change goes through here: the point_transactions row, the
// balance, and the driver's alert are written in one transaction.
//
// `purchase` (sprint 8) makes the change a catalog purchase: { description,
// amountCents }. The amount must then be negative, the driver must have at
// least that many points with this sponsor (checked under the row lock, so two
// purchases at once cannot both spend the same points), and a purchases row is
// written in the same transaction, which is what the sales, fee, and invoice
// reports read.
async function adjustPoints({ driverId, sponsorId, userId, amount, reason, purchase = null }) {
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 2147483647 ||
      typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) {
    const error = new Error('Enter a nonzero whole number of points and a reason (up to 255 characters).');
    error.status = 400;
    throw error;
  }
  if (purchase && (amount > 0 || typeof purchase.description !== 'string' || !purchase.description.trim() ||
      purchase.description.trim().length > 255 || !Number.isInteger(purchase.amountCents) || purchase.amountCents < 0)) {
    const error = new Error('A purchase spends points and needs a description (up to 255 characters) and a dollar amount.');
    error.status = 400;
    throw error;
  }
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [members] = await conn.execute(
      'SELECT point_balance FROM driver_sponsors WHERE driver_id = ? AND sponsor_id = ? FOR UPDATE',
      [driverId, sponsorId]
    );
    if (!members.length) {
      const error = new Error('Driver does not belong to your sponsor.');
      error.status = 404;
      throw error;
    }
    const current = Number(members[0].point_balance);
    if (purchase && current < -amount) {
      const error = new Error(`Not enough points: the driver has ${current} and this costs ${-amount}.`);
      error.status = 409;
      error.code = 'INSUFFICIENT_POINTS';
      error.balance = current;
      error.cost = -amount;
      throw error;
    }
    const balance = current + amount;
    if (balance < -2147483648 || balance > 2147483647) {
      const error = new Error('This adjustment would exceed the supported point balance.');
      error.status = 400;
      throw error;
    }
    const [result] = await conn.execute(
      'INSERT INTO point_transactions (driver_id, sponsor_id, changed_by_user_id, points_change, reason) VALUES (?, ?, ?, ?, ?)',
      [driverId, sponsorId, userId, amount, reason.trim()]
    );
    await conn.execute(
      'UPDATE driver_sponsors SET point_balance = ? WHERE driver_id = ? AND sponsor_id = ?',
      [balance, driverId, sponsorId]
    );
    await conn.execute('INSERT INTO point_alerts (transaction_id) VALUES (?)', [result.insertId]);
    if (purchase) {
      await conn.execute(
        'INSERT INTO purchases (driver_id, sponsor_id, description, amount_cents, points_spent) VALUES (?, ?, ?, ?, ?)',
        [driverId, sponsorId, purchase.description.trim(), purchase.amountCents, -amount]
      );
    }
    await conn.commit();
    return balance;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { adjustPoints };
