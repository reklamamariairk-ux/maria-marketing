// Импорт продаж из CSV. Маркетолог раз в день/неделю выгружает из 1С CSV
// и заливает через UI. Ожидаемые колонки (можно в любом порядке + любой
// регистр + русские/английские названия):
//
//   date          / дата / sold_at — обязательно
//   amount        / сумма / выручка — обязательно
//   phone         / телефон / клиент — для атрибуции LTV (опц.)
//   promo_code    / промокод / промо — для атрибуции ROI (опц.)
//   store_id      / точка / магазин — опц.
//   product_id    / товар — опц.
//   cost          / себестоимость — опц.
//   quantity      / количество — опц.

const { pool } = require('../lib/db');
const { Pool } = require('pg');
const planPool = process.env.SALES_PLAN_DATABASE_URL ? new Pool({ connectionString: process.env.SALES_PLAN_DATABASE_URL, max: 2 }) : null;
const { parseCsv, normalizePhone, parseAmount, parseDate } = require('../lib/csv');

// Маппинг заголовков колонок (case-insensitive)
const COL_ALIASES = {
  date:        ['date', 'дата', 'sold_at', 'sold at', 'дата продажи'],
  amount:      ['amount', 'сумма', 'выручка', 'sum'],
  phone:       ['phone', 'телефон', 'клиент', 'номер', 'тел'],
  promo_code:  ['promo_code', 'promo', 'промокод', 'промо', 'код', 'купон', 'coupon'],
  store_id:    ['store_id', 'store', 'точка', 'магазин', 'склад'],
  product_id:  ['product_id', 'product', 'товар', 'код товара', 'sku'],
  cost:        ['cost', 'себестоимость', 'cost_price'],
  quantity:    ['quantity', 'qty', 'количество', 'кол-во'],
  target_amount: ['target_amount', 'план', 'план продаж', 'цель'],
  stock_qty:   ['stock_qty', 'остаток', 'остатки', 'остаток шт'],
};

function findColumnIndex(header, aliases) {
  const lowered = header.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = lowered.indexOf(alias.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

// POST /api/sales/import-csv
// Body: { csv: string } или text/csv напрямую
async function importCsv(req, res) {
  try {
    let csv = null;
    if (typeof req.body === 'string') csv = req.body;
    else if (req.body && typeof req.body.csv === 'string') csv = req.body.csv;

    if (!csv || !csv.trim()) {
      res.status(400).json({ error: 'Передай csv текст в body или {csv: "..."}' });
      return;
    }

    const rows = parseCsv(csv);
    if (rows.length === 0) {
      res.status(400).json({ error: 'CSV пуст' });
      return;
    }
    if (rows.length < 2) {
      res.status(400).json({ error: 'Нужна шапка и хотя бы одна строка данных' });
      return;
    }

    const header = rows[0];
    const colMap = {};
    for (const [key, aliases] of Object.entries(COL_ALIASES)) {
      colMap[key] = findColumnIndex(header, aliases);
    }

    if (colMap.date === -1) {
      res.status(400).json({ error: `Не найдена колонка с датой. Ожидается одна из: ${COL_ALIASES.date.join(', ')}` });
      return;
    }
    if (colMap.amount === -1) {
      res.status(400).json({ error: `Не найдена колонка с суммой. Ожидается одна из: ${COL_ALIASES.amount.join(', ')}` });
      return;
    }

    const errors = [];
    const valid = [];

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      const line = r + 1; // 1-based, шапка = 1

      const dateRaw = cells[colMap.date];
      const amountRaw = cells[colMap.amount];

      const soldAt = parseDate(dateRaw);
      if (!soldAt) { errors.push({ line, error: `Невалидная дата: "${dateRaw}"` }); continue; }

      const amount = parseAmount(amountRaw);
      if (amount <= 0) { errors.push({ line, error: `Сумма должна быть > 0: "${amountRaw}"` }); continue; }

      const phone = colMap.phone >= 0 ? normalizePhone(cells[colMap.phone]) : null;
      const promo = colMap.promo_code >= 0 && cells[colMap.promo_code]
        ? cells[colMap.promo_code].trim().toUpperCase() : null;
      const storeId = colMap.store_id >= 0 ? (cells[colMap.store_id]?.trim() || null) : null;
      const productId = colMap.product_id >= 0 ? (cells[colMap.product_id]?.trim() || null) : null;
      const cost = colMap.cost >= 0 ? parseAmount(cells[colMap.cost]) : 0;
      const quantity = colMap.quantity >= 0 ? parseAmount(cells[colMap.quantity]) : 1;
      const targetAmount = colMap.target_amount >= 0 ? parseAmount(cells[colMap.target_amount]) : null;
      const stockQty = colMap.stock_qty >= 0 ? parseAmount(cells[colMap.stock_qty]) : null;

      // period = YYYY-MM из даты
      const period = soldAt.slice(0, 7);

      valid.push({
        period, store_id: storeId, product_id: productId,
        amount, cost,
        gross_profit: amount - cost,
        quantity,
        target_amount: targetAmount,
        stock_qty: stockQty,
        promo_code: promo,
        customer_phone_normalized: phone,
        sold_at: soldAt,
      });
    }

    // Bulk INSERT в одной транзакции
    let inserted = 0;
    if (valid.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of valid) {
          await client.query(
            `INSERT INTO sales (period, store_id, product_id, amount, cost, gross_profit, quantity, target_amount, stock_qty, promo_code, customer_phone_normalized, sold_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [row.period, row.store_id, row.product_id, row.amount, row.cost,
             row.gross_profit, row.quantity, row.target_amount, row.stock_qty, row.promo_code, row.customer_phone_normalized, row.sold_at]
          );
          inserted++;

          // Обновление атрибуции клиента по первому касанию.
          // Сначала ищем кампанию по промокоду — простой SELECT, потом вставляем.
          if (row.customer_phone_normalized) {
            let campaignId = null;
            if (row.promo_code) {
              const { rows: cr } = await client.query(
                `SELECT id FROM mk_campaigns WHERE promo_code = $1::text LIMIT 1`,
                [row.promo_code]
              );
              campaignId = cr[0]?.id ?? null;
            }
            await client.query(
              `INSERT INTO mk_customer_attribution
                 (phone_normalized, first_promo_code, first_campaign_id,
                  first_purchase_date, first_purchase_sum, total_purchases, total_sum, last_purchase_date)
               VALUES ($1::text, $2::text, $3::int, $4::date, $5::numeric, 1, $5::numeric, $4::date)
               ON CONFLICT (phone_normalized) DO UPDATE SET
                 total_purchases = mk_customer_attribution.total_purchases + 1,
                 total_sum = mk_customer_attribution.total_sum + EXCLUDED.first_purchase_sum,
                 last_purchase_date = EXCLUDED.first_purchase_date,
                 updated_at = NOW()`,
              [row.customer_phone_normalized, row.promo_code, campaignId, row.sold_at.slice(0,10), row.amount]
            );
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        inserted = 0;
        errors.push({ line: 0, error: `Ошибка БД: ${err.message}` });
      } finally {
        client.release();
      }
    }

    res.json({
      ok: true,
      total_rows: rows.length - 1,
      inserted,
      errors: errors.slice(0, 100),
      error_count: errors.length,
      columns_mapped: Object.fromEntries(
        Object.entries(colMap).filter(([_, idx]) => idx >= 0)
          .map(([key, idx]) => [key, header[idx]])
      ),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/sales/recent — последние 50 продаж (для проверки импорта)
async function recent(_req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, period, store_id, product_id, amount, cost, gross_profit,
              quantity, promo_code, customer_phone_normalized, sold_at
       FROM sales
       ORDER BY sold_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/sales/stats — общая статистика
async function stats(_req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_orders,
         COALESCE(SUM(amount), 0)::numeric AS total_revenue,
         COALESCE(SUM(gross_profit), 0)::numeric AS total_gross_profit,
         COUNT(*) FILTER (WHERE promo_code IS NOT NULL)::int AS orders_with_promo,
         COUNT(DISTINCT customer_phone_normalized) FILTER (WHERE customer_phone_normalized IS NOT NULL)::int AS unique_customers,
         MIN(sold_at) AS first_sale,
         MAX(sold_at) AS last_sale
       FROM sales`
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/sales/purchase-feed?period=YYYY-MM&limit=...
// Server-to-server feed for Kotik Kombat. The token is intentionally separate
// from the public analytics endpoints; phone values are returned only to the
// internal maria-bot container on the Docker network.
async function purchaseFeed(req, res) {
  const expected = process.env.INGEST_TOKEN || '';
  const got = req.get('X-Ingest-Token') || '';
  if (!expected || got !== expected) { res.status(403).json({ error: 'forbidden' }); return; }
  const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/)?.[0];
  if (!period) { res.status(400).json({ error: 'period=YYYY-MM required' }); return; }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100000, 1), 200000);
  try {
    const { rows } = await pool.query(
      `SELECT id, sold_at, store_id, product_id, quantity, amount,
              customer_phone_normalized, cost, gross_profit, target_amount, stock_qty
         FROM sales WHERE period=$1 ORDER BY sold_at ASC LIMIT $2`, [period, limit]);
    res.json({ period, rowsCount: rows.length, rows: rows.map(r => ({
      date: r.sold_at, storeCode: r.store_id, chequeNo: String(r.id), operation: 'sale',
      phone: r.customer_phone_normalized, productCode: r.product_id,
      qty: Number(r.quantity), sum: Number(r.amount), cost: Number(r.cost), grossProfit: Number(r.gross_profit), targetAmount: r.target_amount == null ? null : Number(r.target_amount), stockQty: r.stock_qty == null ? null : Number(r.stock_qty)
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Кандидаты для автоматических коммерческих заданий.
async function purchaseCandidates(req, res) {
  const expected = process.env.INGEST_TOKEN || '';
  if (!expected || req.get('X-Ingest-Token') !== expected) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const { rows } = await pool.query(`
      SELECT product_id AS "productCode", SUM(quantity)::numeric AS sold_qty,
             SUM(amount)::numeric AS sales_amount, SUM(gross_profit)::numeric AS gross_profit,
             MAX(target_amount)::numeric AS target_amount, MIN(stock_qty)::numeric AS stock_qty
        FROM sales WHERE sold_at >= NOW() - INTERVAL '28 days' AND product_id IS NOT NULL
       GROUP BY product_id HAVING SUM(quantity) > 0
       ORDER BY ((CASE WHEN MAX(target_amount) > 0 THEN GREATEST(0, 1 - SUM(amount) / MAX(target_amount)) ELSE 0.25 END) * 0.30
              + (CASE WHEN SUM(amount) > 0 THEN GREATEST(0, LEAST(1, SUM(gross_profit) / SUM(amount))) ELSE 0 END) * 0.25
              + (CASE WHEN MIN(stock_qty) IS NULL THEN 0.5 WHEN MIN(stock_qty) > 0 THEN 1 ELSE 0 END) * 0.20
              + LEAST(1, SUM(quantity) / 100.0) * 0.15 + 0.10) DESC LIMIT 20`);
    let plans = [];
    if (planPool) {
      const period = String(req.query.period || new Date().toISOString().slice(0, 7)).match(/^\d{4}-\d{2}$/)?.[0];
      if (period) {
        const p = await planPool.query(`SELECT p.product_id AS "productCode", COALESCE(pr.name,p.product_id) AS "productName", SUM(p.amount)::numeric AS "targetAmount" FROM plans p LEFT JOIN products pr ON pr.id=p.product_id WHERE p.period=$1 GROUP BY p.product_id,pr.name`, [period]);
        plans = p.rows;
        if (!plans.length) {
          const fallback = await planPool.query(`SELECT p.product_id AS "productCode", COALESCE(pr.name,p.product_id) AS "productName", SUM(p.amount)::numeric AS "targetAmount" FROM plans p LEFT JOIN products pr ON pr.id=p.product_id WHERE p.period=(SELECT MAX(period) FROM plans) GROUP BY p.product_id,pr.name`);
          plans = fallback.rows;
        }
        // В старых пакетах дашборда план был только строкой _total.
        // В этом случае строим безопасный ориентир из последнего периода продаж.
        if (!plans.filter(x => !String(x.productCode).startsWith('_')).length) {
          const historical = await planPool.query(`SELECT s.product_id AS "productCode", COALESCE(pr.name,s.product_id) AS "productName", (SUM(s.amount) * 1.10)::numeric AS "targetAmount" FROM sales s LEFT JOIN products pr ON pr.id=s.product_id WHERE s.product_id IS NOT NULL AND s.period=(SELECT MAX(period) FROM sales) GROUP BY s.product_id,pr.name ORDER BY SUM(s.amount) DESC LIMIT 100`);
          plans = historical.rows;
        }
      }
    }
    const merged = new Map(rows.map(r => [String(r.productCode), { ...r, targetAmount: r.target_amount == null ? null : Number(r.target_amount) }]));
    for (const p of plans.filter(x => !String(x.productCode).startsWith('_'))) {
      const item = merged.get(String(p.productCode));
      if (item) item.targetAmount = Number(p.targetAmount) || item.targetAmount;
      else merged.set(String(p.productCode), { productCode: p.productCode, productName: p.productName, soldQty: 0, salesAmount: 0, grossProfit: 0, targetAmount: Number(p.targetAmount) || 0, stockQty: null });
    }
    res.json({ candidates: Array.from(merged.values()).map(r => ({ ...r, soldQty: Number(r.soldQty ?? r.sold_qty ?? 0), salesAmount: Number(r.salesAmount ?? r.sales_amount ?? 0), grossProfit: Number(r.grossProfit ?? r.gross_profit ?? 0), targetAmount: r.targetAmount == null ? null : Number(r.targetAmount), stockQty: r.stockQty == null ? null : Number(r.stockQty) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

module.exports = { importCsv, recent, stats, purchaseFeed, purchaseCandidates };
