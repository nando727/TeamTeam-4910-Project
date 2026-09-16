// Applies additive migrations in db/migrations/ on top of db/schema.sql.
// Usage: npm run db:migrate
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
    database: dbName,
    multipleStatements: true,
  });


  async function addMissingColumns(table, definitions) {
    const [columns] = await conn.query('SHOW COLUMNS FROM `' + table + '`');
    for (const [name, definition] of Object.entries(definitions)) {
      if (!columns.some(column => column.Field === name)) {
        await conn.query('ALTER TABLE `' + table + '` ADD COLUMN `' + name + '` ' + definition);
      }
    }
  }

  try {
    await addMissingColumns('users', {
      name: 'VARCHAR(255) NULL',
      email: 'VARCHAR(255) NULL',
    });

    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await conn.query(sql);
      console.log(`Applied migration: ${file}`);
    }

    // Compatibility for the earlier local driver table only. Main's sponsor
    // definition is authoritative; existing contact values are never replaced.
    await addMissingColumns('sponsors', {
      contact_email: 'VARCHAR(255) NULL UNIQUE',
      contact_phone: 'VARCHAR(32) NULL',
      address: 'VARCHAR(255) NULL',
      created_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    });
    // The original local seed had no contact fields. Fill only that demo record.
    await conn.execute(
      'UPDATE sponsors SET contact_email = COALESCE(contact_email, ?), address = COALESCE(address, ?) WHERE name = ?',
      ['demo-sponsor@example.com', 'Demo address', 'Demo Sponsor']
    );
    const [missingContacts] = await conn.query(
      'SELECT COUNT(*) AS count FROM sponsors WHERE contact_email IS NULL OR address IS NULL'
    );
    if (missingContacts[0].count > 0) {
      throw new Error('Existing sponsors need contact_email and address values. Fill these in and rerun db:migrate.');
    }
    await conn.query('ALTER TABLE sponsors MODIFY COLUMN contact_email VARCHAR(255) NOT NULL, MODIFY COLUMN address VARCHAR(255) NOT NULL');
    await conn.query('ALTER TABLE sponsors MODIFY COLUMN name VARCHAR(255) NOT NULL');
    // The admin API identifies duplicates by email, rather than organization name.
    const [indexes] = await conn.query('SHOW INDEX FROM sponsors');
    const nameIndex = indexes.filter(index => index.Key_name === 'name');
    if (nameIndex.length === 1 && nameIndex[0].Column_name === 'name' && !nameIndex[0].Non_unique) {
      await conn.query('ALTER TABLE sponsors DROP INDEX name');
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
