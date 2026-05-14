// Main Express server for maria-marketing.
// Деплой: Render web service, общий DATABASE_URL с sales-plan-dashboard.

require('dotenv').config();
const express = require('express');
const path = require('path');

const { migrate } = require('./lib/migrate');
const channels = require('./routes/channels');
const campaigns = require('./routes/campaigns');
const sales = require('./routes/sales');
const daily = require('./routes/daily');
const analyze = require('./routes/analyze');
const integrations = require('./routes/integrations');

const app = express();
// Лимит 10 МБ — для CSV-импорта продаж за месяц должно с запасом хватить
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/csv', limit: '10mb' }));

// CORS — пока открыто, в проде ограничим origin'ами dashboard'а
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Token');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Health для UptimeRobot и Render
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'maria-marketing', startedAt: new Date().toISOString() });
});

// ── Каналы ────────────────────────────────────────────────────────────────
app.get('/api/channels', channels.list);

// ── Кампании ──────────────────────────────────────────────────────────────
app.get('/api/campaigns', campaigns.list);
app.post('/api/campaigns', campaigns.create);
app.put('/api/campaigns/:id', campaigns.update);
app.delete('/api/campaigns/:id', campaigns.remove);
app.get('/api/campaigns/:id/metrics', campaigns.metrics);

// ── Продажи ───────────────────────────────────────────────────────────────
app.post('/api/sales/import-csv', sales.importCsv);
app.get('/api/sales/recent', sales.recent);
app.get('/api/sales/stats', sales.stats);

// ── Дневные расходы по кампании ──────────────────────────────────────────
app.get('/api/campaigns/:id/daily', daily.list);
app.post('/api/campaigns/:id/daily', daily.upsert);
app.delete('/api/campaigns/:id/daily/:date', daily.remove);

// ── LLM-аналитик ──────────────────────────────────────────────────────────
app.post('/api/analyze', analyze.analyze);
app.get('/api/reports', analyze.listReports);

// ── Интеграции (Авито/блогеры — CSV; Я.Директ — API) ─────────────────────
app.post('/api/campaigns/:id/daily/import-csv', integrations.importDailyCsv);
app.get('/api/integrations/status', integrations.status);
app.post('/api/integrations/yandex-direct/sync', integrations.yandexDirectSync);
app.get('/api/integrations/yandex-metrika/counters', integrations.metrikaCounters);
app.get('/api/integrations/yandex-metrika/goals', integrations.metrikaGoals);
app.post('/api/integrations/yandex-metrika/sync', integrations.metrikaSync);

// ── Статика (минимальный UI пока — потом интегрируем во вкладку dashboard'а) ─
app.use('/', express.static(path.join(__dirname, '..', 'web')));

const port = parseInt(process.env.PORT, 10) || 3001;

async function start() {
  console.log('[startup] Maria Marketing');
  console.log('[startup] NODE_ENV:', process.env.NODE_ENV || 'development');
  console.log('[startup] DATABASE_URL:', process.env.DATABASE_URL ? '(set)' : '(empty)');
  console.log('[startup] GROQ_API_KEY:', process.env.GROQ_API_KEY ? '(set)' : '(empty)');

  // Применяем миграции при старте — идемпотентно
  try {
    await migrate();
  } catch (err) {
    console.error('[startup] migrate failed, продолжаем (миграции могут быть применены вручную):', err.message);
  }

  app.listen(port, () => {
    console.log(`[server] ✓ http://localhost:${port}`);
  });
}

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
