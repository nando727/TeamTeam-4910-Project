// Creates the database (if needed) and applies db/schema.sql.
// Usage: npm run db:setup
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const dbName = process.env.DB_NAME;
  if (!dbName) {
    console.error('DB_NAME is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.query(`USE \`${dbName}\``);

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await conn.query(schema);

  console.log(`Database "${dbName}" is ready.`);
  await conn.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
