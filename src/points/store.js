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
//
// `conn` (sprint 9) lets a caller that already holds a transaction run the
// change inside it, so a cart of several items is one transaction: every line
// is written or none is. The caller then owns begin, commit, and rollback.
// Without it, this function opens and closes its own, as before.
function validate({ amount, reason, purchase }) {
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
}

function insufficient(current, cost) {
  const error = new Error(`Not enough points: the driver has ${current} and this costs ${cost}.`);
  error.status = 409;
  error.code = 'INSUFFICIENT_POINTS';
  error.balance = current;
  error.cost = cost;
  return error;
}

async function adjustPointsOn(conn, { driverId, sponsorId, userId, amount, reason, purchase = null }) {
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
  if (purchase && current < -amount) throw insufficient(current, -amount);
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
  let purchaseId = null;
  if (purchase) {
    const [bought] = await conn.execute(
      'INSERT INTO purchases (driver_id, sponsor_id, description, amount_cents, points_spent) VALUES (?, ?, ?, ?, ?)',
      [driverId, sponsorId, purchase.description.trim(), purchase.amountCents, -amount]
    );
    purchaseId = bought.insertId;
  }
  return { balance, transactionId: result.insertId, purchaseId };
}

async function adjustPoints({ conn = null, ...change }) {
  validate(change);
  if (conn) return (await adjustPointsOn(conn, change)).balance;
  const own = await db.pool.getConnection();
  try {
    await own.beginTransaction();
    const { balance } = await adjustPointsOn(own, change);
    await own.commit();
    return balance;
  } catch (error) {
    await own.rollback();
    throw error;
  } finally {
    own.release();
  }
}

// Sprint 9: a driver checks out a cart. `lines` are { title, pointsCost,
// priceValue, quantity } from the sponsor's catalog, all with the one sponsor
// the cart belongs to. The whole cart is one transaction: the balance is
// locked once and compared with the cart's total before anything is written,
// so a cart that is short by a point writes nothing, and two checkouts at once
// cannot both spend the same points. Each line is then an ordinary purchase
// through adjustPointsOn, which is what the sponsor's buy flow and every
// report already understand: one point_transactions row, one alert, and one
// purchases row per line.
async function purchaseCart({ driverId, sponsorId, userId, lines }) {
  if (!Array.isArray(lines) || !lines.length) {
    const error = new Error('The cart is empty.');
    error.status = 400;
    throw error;
  }
  const total = lines.reduce((sum, line) => sum + line.pointsCost * line.quantity, 0);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [members] = await conn.execute(
      'SELECT point_balance FROM driver_sponsors WHERE driver_id = ? AND sponsor_id = ? FOR UPDATE',
      [driverId, sponsorId]
    );
    if (!members.length) {
      const error = new Error('You no longer belong to this sponsor, so nothing was bought.');
      error.status = 404;
      throw error;
    }
    const current = Number(members[0].point_balance);
    if (current < total) throw insufficient(current, total);

    let balance = current;
    const purchaseIds = [];
    for (const line of lines) {
      const title = String(line.title).trim().slice(0, 255);
      const each = line.quantity === 1 ? title : `${title} ×${line.quantity}`;
      const change = {
        driverId, sponsorId, userId,
        amount: -(line.pointsCost * line.quantity),
        reason: `Catalog purchase: ${each}`.slice(0, 255),
        purchase: { description: each.slice(0, 255), amountCents: Math.round(Number(line.priceValue) * 100) * line.quantity },
      };
      validate(change);
      const written = await adjustPointsOn(conn, change);
      balance = written.balance;
      purchaseIds.push(written.purchaseId);
    }
    await conn.commit();
    return { balance, total, purchaseIds };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { adjustPoints, purchaseCart };
