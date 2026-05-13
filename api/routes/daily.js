// CRUD расходов по дням для кампаний.
// Для оффлайн-каналов (ТВ, радио, листовки) — маркетолог вводит руками.
// Для онлайн с API (Директ, VK) — будет авто-импорт из Phase 2.

const { pool } = require('../lib/db');

// GET /api/campaigns/:id/daily — список дневных расходов
async function list(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT id, date, cost, impressions, clicks, conversions, source, imported_at
       FROM mk_campaign_daily
       WHERE campaign_id = $1
       ORDER BY date DESC
       LIMIT 200`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/campaigns/:id/daily — добавить расход за день (upsert по date)
async function upsert(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { date, cost, impressions, clicks, conversions } = req.body;
    if (!date) { res.status(400).json({ error: 'date обязателен' }); return; }
    if (cost === undefined || cost === null || isNaN(Number(cost))) {
      res.status(400).json({ error: 'cost обязателен (число ≥ 0)' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO mk_campaign_daily (campaign_id, date, cost, impressions, clicks, conversions, source)
       VALUES ($1, $2::date, $3::numeric, $4, $5, $6, 'manual')
       ON CONFLICT (campaign_id, date) DO UPDATE SET
         cost = EXCLUDED.cost,
         impressions = COALESCE(EXCLUDED.impressions, mk_campaign_daily.impressions),
         clicks = COALESCE(EXCLUDED.clicks, mk_campaign_daily.clicks),
         conversions = COALESCE(EXCLUDED.conversions, mk_campaign_daily.conversions),
         source = 'manual',
         imported_at = NOW()
       RETURNING *`,
      [
        id, date, Number(cost),
        impressions ? Number(impressions) : null,
        clicks ? Number(clicks) : null,
        conversions ? Number(conversions) : null,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/campaigns/:id/daily/:date
async function remove(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const date = req.params.date;
    const { rowCount } = await pool.query(
      `DELETE FROM mk_campaign_daily WHERE campaign_id = $1 AND date = $2`,
      [id, date]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { list, upsert, remove };
