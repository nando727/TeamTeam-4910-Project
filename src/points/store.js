const db = require('../db');

async function adjustPoints({ driverId, sponsorId, userId, amount, reason }) {
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 2147483647 ||
      typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) {
    const error = new Error('Enter a nonzero whole number of points and a reason (up to 255 characters).');
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
    const balance = Number(members[0].point_balance) + amount;
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
