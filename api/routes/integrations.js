// Интеграции с внешними рекламными системами.
// На старте: CSV-импорт расходов (для Авито, блогеров, любых источников).
// Дальше: Яндекс.Директ, ВК Реклама, Telegram Ads (через каркас в lib/).

const { pool } = require('../lib/db');
const { parseCsv, parseAmount, parseDate } = require('../lib/csv');
const yandexDirect = require('../lib/yandex-direct');
const yandexMetrika = require('../lib/yandex-metrika');

// Алиасы колонок CSV с расходами по дням
const DAILY_ALIASES = {
  date:        ['date', 'дата', 'день', 'period'],
  cost:        ['cost', 'стоимость', 'расход', 'затраты', 'spend', 'amount', 'сумма'],
  impressions: ['impressions', 'показы', 'просмотры', 'views'],
  clicks:      ['clicks', 'клики', 'переходы', 'click'],
  conversions: ['conversions', 'конверсии', 'заявки', 'обращения', 'leads'],
};

function findColumnIndex(header, aliases) {
  const lowered = header.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = lowered.indexOf(alias.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

// POST /api/campaigns/:id/daily/import-csv
// Body: { csv: "...", source: "avito" } (source — опц. метка происхождения)
async function importDailyCsv(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id кампании' }); return; }

    let csv = null;
    if (typeof req.body === 'string') csv = req.body;
    else if (req.body && typeof req.body.csv === 'string') csv = req.body.csv;
    const source = (req.body && req.body.source) || 'csv-import';

    if (!csv || !csv.trim()) {
      res.status(400).json({ error: 'csv обязателен' });
      return;
    }

    const rows = parseCsv(csv);
    if (rows.length < 2) {
      res.status(400).json({ error: 'Нужна шапка и хотя бы одна строка данных' });
      return;
    }

    const header = rows[0];
    const colMap = {};
    for (const [key, aliases] of Object.entries(DAILY_ALIASES)) {
      colMap[key] = findColumnIndex(header, aliases);
    }
    if (colMap.date === -1 || colMap.cost === -1) {
      res.status(400).json({
        error: 'Не найдены обязательные колонки date и cost',
        expected: { date: DAILY_ALIASES.date, cost: DAILY_ALIASES.cost },
      });
      return;
    }

    const errors = [];
    let inserted = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const line = r + 1;

        const date = parseDate(cells[colMap.date]);
        if (!date) { errors.push({ line, error: `Невалидная дата: "${cells[colMap.date]}"` }); continue; }
        const cost = parseAmount(cells[colMap.cost]);
        if (cost < 0) { errors.push({ line, error: `cost не может быть < 0` }); continue; }
        const impressions = colMap.impressions >= 0 ? Math.round(parseAmount(cells[colMap.impressions]) || 0) || null : null;
        const clicks      = colMap.clicks      >= 0 ? Math.round(parseAmount(cells[colMap.clicks])      || 0) || null : null;
        const conversions = colMap.conversions >= 0 ? Math.round(parseAmount(cells[colMap.conversions]) || 0) || null : null;

        await client.query(
          `INSERT INTO mk_campaign_daily (campaign_id, date, cost, impressions, clicks, conversions, source)
           VALUES ($1, $2::date, $3::numeric, $4, $5, $6, $7)
           ON CONFLICT (campaign_id, date) DO UPDATE SET
             cost = EXCLUDED.cost,
             impressions = COALESCE(EXCLUDED.impressions, mk_campaign_daily.impressions),
             clicks = COALESCE(EXCLUDED.clicks, mk_campaign_daily.clicks),
             conversions = COALESCE(EXCLUDED.conversions, mk_campaign_daily.conversions),
             source = EXCLUDED.source,
             imported_at = NOW()`,
          [id, date.slice(0,10), cost, impressions, clicks, conversions, source]
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }

    res.json({
      ok: true,
      campaign_id: id,
      total_rows: rows.length - 1,
      inserted,
      errors: errors.slice(0, 50),
      error_count: errors.length,
      columns_mapped: Object.fromEntries(
        Object.entries(colMap).filter(([_, idx]) => idx >= 0).map(([k, idx]) => [k, header[idx]])
      ),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/integrations/status — какие внешние системы настроены
async function status(_req, res) {
  res.json({
    yandex_direct: {
      configured: !!process.env.YANDEX_DIRECT_TOKEN,
      hint: 'Получи токен на https://oauth.yandex.ru через client_id приложения Я.Директ, потом задай env YANDEX_DIRECT_TOKEN',
    },
    yandex_metrika: {
      configured: !!process.env.YANDEX_METRIKA_TOKEN,
      hint: 'Можно использовать тот же OAuth-токен Яндекса',
    },
    vk_ads: {
      configured: !!process.env.VK_ADS_TOKEN,
      hint: 'VK Ads API — токен через my.target.ru или ads.vk.com',
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      hint: 'Bot Token — для статистики канала (нужен админ-доступ к каналу)',
    },
    instagram: {
      configured: !!process.env.IG_ACCESS_TOKEN,
      hint: 'Meta Graph API: business account + long-lived token',
    },
    groq_llm: {
      configured: !!process.env.GROQ_API_KEY,
      hint: 'Для AI-аналитика. Ключ gsk_...',
    },
  });
}

// POST /api/integrations/yandex-direct/sync?campaign_id=&from=&to=
// Тянет статистику из Я.Директ через ReportService и кладёт в mk_campaign_daily.
async function yandexDirectSync(req, res) {
  try {
    const campaignId = parseInt(req.query.campaign_id, 10);
    const from = req.query.from;
    const to = req.query.to;
    const yandexCampaignIds = req.query.yandex_campaign_ids; // через запятую
    if (isNaN(campaignId)) { res.status(400).json({ error: 'campaign_id обязателен' }); return; }
    if (!from || !to) { res.status(400).json({ error: 'from и to обязательны (YYYY-MM-DD)' }); return; }
    if (!process.env.YANDEX_DIRECT_TOKEN) {
      res.status(400).json({ error: 'YANDEX_DIRECT_TOKEN не задан в env' }); return;
    }

    const stats = await yandexDirect.fetchDailyStats({
      token: process.env.YANDEX_DIRECT_TOKEN,
      from, to,
      campaignIds: yandexCampaignIds ? yandexCampaignIds.split(',').map(s => s.trim()) : null,
    });

    let inserted = 0;
    for (const day of stats) {
      await pool.query(
        `INSERT INTO mk_campaign_daily (campaign_id, date, cost, impressions, clicks, conversions, source)
         VALUES ($1, $2::date, $3::numeric, $4, $5, $6, 'yandex-direct-api')
         ON CONFLICT (campaign_id, date) DO UPDATE SET
           cost = EXCLUDED.cost,
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           source = 'yandex-direct-api',
           imported_at = NOW()`,
        [campaignId, day.date, day.cost, day.impressions, day.clicks, day.conversions]
      );
      inserted++;
    }

    res.json({ ok: true, days_synced: inserted, period: { from, to } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/integrations/yandex-metrika/counters — список счётчиков
async function metrikaCounters(_req, res) {
  try {
    if (!process.env.YANDEX_METRIKA_TOKEN) {
      res.status(400).json({ error: 'YANDEX_METRIKA_TOKEN не задан в env' }); return;
    }
    const counters = await yandexMetrika.listCounters({ token: process.env.YANDEX_METRIKA_TOKEN });
    res.json(counters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/integrations/yandex-metrika/goals?counter_id=...
async function metrikaGoals(req, res) {
  try {
    if (!process.env.YANDEX_METRIKA_TOKEN) {
      res.status(400).json({ error: 'YANDEX_METRIKA_TOKEN не задан в env' }); return;
    }
    const counterId = req.query.counter_id;
    if (!counterId) { res.status(400).json({ error: 'counter_id обязателен' }); return; }
    const goals = await yandexMetrika.listGoals({
      token: process.env.YANDEX_METRIKA_TOKEN,
      counterId,
    });
    res.json(goals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/integrations/yandex-metrika/sync
// Query: campaign_id, counter_id, from, to, utm_campaign?, utm_source?, goal_ids? (csv)
// Кладёт визиты в mk_campaign_daily.clicks и достижения целей в .conversions
async function metrikaSync(req, res) {
  try {
    if (!process.env.YANDEX_METRIKA_TOKEN) {
      res.status(400).json({ error: 'YANDEX_METRIKA_TOKEN не задан в env' }); return;
    }
    const campaignId = parseInt(req.query.campaign_id, 10);
    const counterId = req.query.counter_id;
    const from = req.query.from;
    const to = req.query.to;
    if (isNaN(campaignId)) { res.status(400).json({ error: 'campaign_id обязателен' }); return; }
    if (!counterId) { res.status(400).json({ error: 'counter_id обязателен' }); return; }
    if (!from || !to) { res.status(400).json({ error: 'from и to обязательны' }); return; }

    const goalIds = req.query.goal_ids
      ? String(req.query.goal_ids).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
      : null;

    const stats = await yandexMetrika.fetchDailyStats({
      token: process.env.YANDEX_METRIKA_TOKEN,
      counterId,
      from, to,
      goalIds,
      utmCampaign: req.query.utm_campaign || null,
      utmSource: req.query.utm_source || null,
    });

    let updated = 0;
    for (const day of stats) {
      // Метрика не знает наших расходов — обновляем только clicks/conversions,
      // не трогая cost. INSERT с cost=0, ON CONFLICT обновляет clicks/conversions
      await pool.query(
        `INSERT INTO mk_campaign_daily (campaign_id, date, cost, clicks, conversions, source)
         VALUES ($1, $2::date, 0, $3, $4, 'yandex-metrika-api')
         ON CONFLICT (campaign_id, date) DO UPDATE SET
           clicks = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           imported_at = NOW()`,
        [campaignId, day.date, day.visits, day.conversions]
      );
      updated++;
    }

    res.json({ ok: true, days_synced: updated, period: { from, to }, sample: stats.slice(0, 3) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  importDailyCsv, status, yandexDirectSync,
  metrikaCounters, metrikaGoals, metrikaSync,
};
