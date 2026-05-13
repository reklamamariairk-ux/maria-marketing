// CRUD кампаний + метрики (ROI / ROAS / LTV).

const { pool } = require('../lib/db');

const VALID_GOALS = new Set(['sales', 'leads', 'reach', 'traffic']);
const VALID_STATUSES = new Set(['planned', 'active', 'paused', 'completed', 'archived']);

// ── GET /api/campaigns?status=&channel=&from=&to= ─────────────────────────
async function list(req, res) {
  try {
    const { status, channel, channel_id, from, to } = req.query;
    const params = [];
    const wheres = [];

    if (status) { params.push(status); wheres.push(`c.status = $${params.length}`); }
    if (channel_id) { params.push(parseInt(channel_id, 10)); wheres.push(`c.channel_id = $${params.length}`); }
    else if (channel) { params.push(channel); wheres.push(`ch.code = $${params.length}`); }
    if (from) { params.push(from); wheres.push(`(c.end_date IS NULL OR c.end_date >= $${params.length})`); }
    if (to)   { params.push(to);   wheres.push(`c.start_date <= $${params.length}`); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.promo_code,
              c.start_date, c.end_date,
              c.budget_planned, c.goal, c.status,
              c.partner_name, c.notes, c.creative_url,
              ch.id AS channel_id, ch.code AS channel_code, ch.name AS channel_name,
              ch.category AS channel_category,
              -- актуальные расходы из daily-таблицы
              COALESCE((SELECT SUM(cost) FROM mk_campaign_daily WHERE campaign_id = c.id), 0) AS spent_actual,
              -- выручка по промокоду (если промокод задан и продажи импортированы)
              CASE WHEN c.promo_code IS NOT NULL THEN
                COALESCE((SELECT SUM(amount) FROM sales WHERE promo_code = c.promo_code), 0)
              ELSE 0 END AS revenue_total,
              -- кол-во заказов
              CASE WHEN c.promo_code IS NOT NULL THEN
                COALESCE((SELECT COUNT(*) FROM sales WHERE promo_code = c.promo_code), 0)
              ELSE 0 END AS orders_count
       FROM mk_campaigns c
       JOIN mk_channels ch ON ch.id = c.channel_id
       ${where}
       ORDER BY c.start_date DESC, c.id DESC`,
      params
    );

    // Добавляем расчёт ROI для каждой строки
    const enriched = rows.map(r => {
      const spent = Number(r.spent_actual || 0);
      const revenue = Number(r.revenue_total || 0);
      const roi = spent > 0 ? Math.round(((revenue - spent) / spent) * 100) : null;
      const roas = spent > 0 ? Math.round((revenue / spent) * 100) / 100 : null;
      const cpo = r.orders_count > 0 ? Math.round(spent / r.orders_count) : null;
      return { ...r, roi_percent: roi, roas, cost_per_order: cpo };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/campaigns ───────────────────────────────────────────────────
async function create(req, res) {
  try {
    const {
      name, channel_id, promo_code, start_date, end_date,
      budget_planned, goal, creative_url, status, notes, partner_name,
    } = req.body;

    if (!name?.trim()) { res.status(400).json({ error: 'name обязателен' }); return; }
    if (!channel_id) { res.status(400).json({ error: 'channel_id обязателен' }); return; }
    if (!start_date) { res.status(400).json({ error: 'start_date обязателен' }); return; }
    if (goal && !VALID_GOALS.has(goal)) {
      res.status(400).json({ error: `goal должен быть: ${[...VALID_GOALS].join(', ')}` }); return;
    }
    if (status && !VALID_STATUSES.has(status)) {
      res.status(400).json({ error: `status должен быть: ${[...VALID_STATUSES].join(', ')}` }); return;
    }

    // promo_code: trim + uppercase для удобства
    const promoNorm = promo_code ? promo_code.trim().toUpperCase() : null;

    const { rows } = await pool.query(
      `INSERT INTO mk_campaigns
         (name, channel_id, promo_code, start_date, end_date,
          budget_planned, goal, creative_url, status, notes, partner_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        name.trim(), Number(channel_id), promoNorm, start_date, end_date ?? null,
        Number(budget_planned) || 0, goal ?? null, creative_url ?? null,
        status ?? 'planned', notes ?? null, partner_name ?? null,
      ]
    );

    // Если задан промокод — создаём запись в mk_promo_codes для централизованного учёта
    if (promoNorm) {
      await pool.query(
        `INSERT INTO mk_promo_codes (code, campaign_id, discount_type, active)
         VALUES ($1, $2, 'none', true)
         ON CONFLICT (code) DO UPDATE SET campaign_id = EXCLUDED.campaign_id`,
        [promoNorm, rows[0].id]
      );
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    if (/duplicate key/i.test(err.message) && /promo_code/i.test(err.message)) {
      res.status(409).json({ error: 'Этот промокод уже используется в другой кампании' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
}

// ── PUT /api/campaigns/:id ────────────────────────────────────────────────
async function update(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }

    const allowed = ['name', 'channel_id', 'promo_code', 'start_date', 'end_date',
                     'budget_planned', 'goal', 'creative_url', 'status', 'notes', 'partner_name'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if (key === 'promo_code' && val) val = String(val).trim().toUpperCase();
        if (key === 'goal' && val && !VALID_GOALS.has(val)) {
          res.status(400).json({ error: `goal должен быть: ${[...VALID_GOALS].join(', ')}` }); return;
        }
        if (key === 'status' && val && !VALID_STATUSES.has(val)) {
          res.status(400).json({ error: `status должен быть: ${[...VALID_STATUSES].join(', ')}` }); return;
        }
        vals.push(val); sets.push(`${key} = $${vals.length}`);
      }
    }
    if (sets.length === 0) { res.status(400).json({ error: 'Нечего обновлять' }); return; }
    sets.push(`updated_at = NOW()`);
    vals.push(id);

    const { rows } = await pool.query(
      `UPDATE mk_campaigns SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'Кампания не найдена' }); return; }
    res.json(rows[0]);
  } catch (err) {
    if (/duplicate key/i.test(err.message)) {
      res.status(409).json({ error: 'Такой промокод уже используется' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
}

// ── DELETE /api/campaigns/:id ─────────────────────────────────────────────
async function remove(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(`DELETE FROM mk_campaigns WHERE id = $1`, [id]);
    if (!rowCount) { res.status(404).json({ error: 'Кампания не найдена' }); return; }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/campaigns/:id/metrics — детальные метрики ────────────────────
async function metrics(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: campRows } = await pool.query(
      `SELECT c.*, ch.name AS channel_name, ch.code AS channel_code
       FROM mk_campaigns c
       JOIN mk_channels ch ON ch.id = c.channel_id
       WHERE c.id = $1`,
      [id]
    );
    if (!campRows[0]) { res.status(404).json({ error: 'Кампания не найдена' }); return; }
    const c = campRows[0];

    // Расходы по дням
    const { rows: daily } = await pool.query(
      `SELECT date, cost, impressions, clicks, conversions, source
       FROM mk_campaign_daily WHERE campaign_id = $1 ORDER BY date`,
      [id]
    );

    // Продажи по промокоду
    let sales = [];
    let salesAgg = { revenue: 0, gross_profit: 0, orders: 0, unique_customers: 0 };
    if (c.promo_code) {
      const { rows: salesRows } = await pool.query(
        `SELECT period, store_id, product_id, amount, gross_profit, customer_phone_normalized, sold_at
         FROM sales
         WHERE promo_code = $1
         ORDER BY sold_at DESC`,
        [c.promo_code]
      );
      sales = salesRows;

      const { rows: aggRows } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS revenue,
                COALESCE(SUM(gross_profit), 0)::numeric AS gross_profit,
                COUNT(*)::int AS orders,
                COUNT(DISTINCT customer_phone_normalized) FILTER (WHERE customer_phone_normalized IS NOT NULL)::int AS unique_customers
         FROM sales WHERE promo_code = $1`,
        [c.promo_code]
      );
      salesAgg = aggRows[0];
    }

    const spent = daily.reduce((s, d) => s + Number(d.cost), 0);
    const revenue = Number(salesAgg.revenue);
    const grossProfit = Number(salesAgg.gross_profit);

    res.json({
      campaign: c,
      spent,
      revenue,
      gross_profit: grossProfit,
      orders: salesAgg.orders,
      unique_customers: salesAgg.unique_customers,
      roi_percent: spent > 0 ? Math.round(((grossProfit - spent) / spent) * 100) : null,
      roas: spent > 0 ? Math.round((revenue / spent) * 100) / 100 : null,
      cost_per_order: salesAgg.orders > 0 ? Math.round(spent / salesAgg.orders) : null,
      avg_check: salesAgg.orders > 0 ? Math.round(revenue / salesAgg.orders) : null,
      daily,
      recent_sales: sales.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { list, create, update, remove, metrics };
