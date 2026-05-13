// Простой раннер миграций — применяет .sql из migrations/ в алфавитном порядке.
// Отслеживает применённые в служебной таблице mk_schema_migrations,
// чтобы не пересекаться с migrations dashboard'а (там своя schema_migrations).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const dir = path.join(__dirname, '..', '..', 'migrations');

  // Создаём служебную таблицу для своих миграций (имя с префиксом mk_
  // чтобы не пересекаться с миграциями dashboard'а в той же БД)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mk_schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query(
    `SELECT filename FROM mk_schema_migrations`
  );
  const appliedSet = new Set(applied.map(r => r.filename));

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;
    console.log(`[migrate] → ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO mk_schema_migrations (filename) VALUES ($1)`,
        [file]
      );
      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] ✗ ${file} failed:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    console.log('[migrate] ✓ Все миграции уже применены');
  } else {
    console.log(`[migrate] ✓ Применено: ${count}`);
  }
}

// Если запущен как CLI (npm run migrate) — выполняем и закрываем pool.
// Если импортирован сервером — pool остаётся открытым для последующих запросов.
if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(err => {
      console.error('[migrate] FATAL:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
