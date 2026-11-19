const db = require('../db');

const POLICIES = {
  forfeit: 'Points are forfeited when a driver leaves.',
  hold: 'Points are held, and restored if the driver rejoins.',
};
const DEFAULT_POLICY = 'forfeit';

const isPolicy = (value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(POLICIES, value);

async function getBalancePolicy(sponsorId) {
  const rows = await db.query('SELECT balance_policy FROM sponsors WHERE id = ?', [sponsorId]);
  const policy = rows[0] && rows[0].balance_policy;
  return isPolicy(policy) ? policy : DEFAULT_POLICY;
}


async function setBalancePolicy(sponsorId, policy) {
  if (!isPolicy(policy)) return false;
  await db.query('UPDATE sponsors SET balance_policy = ? WHERE id = ?', [policy, sponsorId]);
  return true;
}

async function applyBalancePolicy(conn, { driverId, sponsorId }) {
  const [members] = await conn.execute(
    'SELECT point_balance FROM driver_sponsors WHERE driver_id = ? AND sponsor_id = ? FOR UPDATE',
    [driverId, sponsorId]
  );
  if (!members.length) return null;
  const balance = Number(members[0].point_balance) || 0;

  const [sponsors] = await conn.execute('SELECT balance_policy FROM sponsors WHERE id = ?', [sponsorId]);
  const policy = sponsors.length && isPolicy(sponsors[0].balance_policy) ? sponsors[0].balance_policy : DEFAULT_POLICY;

  if (policy === 'hold' && balance !== 0) {
    // Adds to anything already held, so an earlier unclaimed hold is not lost.
    await conn.execute(
      `INSERT INTO held_balances (driver_id, sponsor_id, points) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE points = points + ?`,
      [driverId, sponsorId, balance, balance]
    );
  }
  return { policy, balance };
}

async function restoreHeldBalance(conn, { driverId, sponsorId }) {
  const [held] = await conn.execute(
    'SELECT points FROM held_balances WHERE driver_id = ? AND sponsor_id = ? FOR UPDATE',
    [driverId, sponsorId]
  );
  if (!held.length) return 0;
  const points = Number(held[0].points) || 0;
  await conn.execute(
    'UPDATE driver_sponsors SET point_balance = point_balance + ? WHERE driver_id = ? AND sponsor_id = ?',
    [points, driverId, sponsorId]
  );
  await conn.execute('DELETE FROM held_balances WHERE driver_id = ? AND sponsor_id = ?', [driverId, sponsorId]);
  return points;
}

module.exports = { POLICIES, DEFAULT_POLICY, getBalancePolicy, setBalancePolicy, applyBalancePolicy, restoreHeldBalance };
