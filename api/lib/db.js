// Подключение к Postgres — общая БД с sales-plan-dashboard.
// DATABASE_URL прописывается в env (Render → maria-marketing → Environment).
//
// Не закрываем pool явно при graceful shutdown — Render всё равно убьёт
// процесс через 30 сек после SIGTERM. Express обработчики просто отвалятся.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] DATABASE_URL не задан в env');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  // Neon требует TLS, кроме локальной разработки через docker
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] pool error:', err.message);
});

module.exports = { pool };
