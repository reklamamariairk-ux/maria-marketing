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

// SSL не нужен для локального Postgres (docker-сеть Hostinger, hostname `postgres`,
// sslmode=disable) и для localhost. Для облачных БД (Neon и т.п.) — TLS с
// rejectUnauthorized:false.
const noSsl = /localhost|127\.0\.0\.1/.test(connectionString)
  || /[?&]sslmode=disable/.test(connectionString)
  || /@postgres[:/]/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: noSsl ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] pool error:', err.message);
});

module.exports = { pool };
