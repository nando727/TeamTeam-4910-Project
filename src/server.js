const { app } = require('./app');

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Good Driver Incentive Program running at http://localhost:${port}`);
});
