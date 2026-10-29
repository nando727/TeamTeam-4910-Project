const { app } = require('./app');
const { startPruning } = require('./auth/session-store');

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Good Driver Incentive Program running at http://localhost:${port}`);

  // Story AA-71: sessions are rows now, so expired ones need clearing out.
  // Only the process that serves traffic does this; tests import the app
  // without ever starting a timer.
  if (process.env.SESSION_STORE !== 'memory') startPruning();
});
