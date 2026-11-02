const db = require('./db');

// Story INF-10: a public check that the web service is up and can reach the
// database. It answers with status words only. Whatever went wrong stays in the
// server log, so nothing about the database reaches a stranger. It is mounted
// ahead of the session middleware, so it needs no session and sets no cookie.
const DEFAULT_TIMEOUT_MS = 3000;

// Read per call so a test can use a short window.
function databaseTimeoutMs() {
  const configured = Number(process.env.HEALTH_DB_TIMEOUT_MS);
  return configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

async function healthCheck(req, res) {
  res.set('Cache-Control', 'no-store');
  const limit = databaseTimeoutMs();
  let timer;
  try {
    // A database that hangs must not hang the check as well.
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${limit} ms`)), limit);
      }),
    ]);
    res.status(200).json({ status: 'ok', app: 'ok', database: 'ok' });
  } catch (err) {
    console.error('Health check: database unavailable:', err.message);
    res.status(503).json({ status: 'unavailable', app: 'ok', database: 'unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { healthCheck };
