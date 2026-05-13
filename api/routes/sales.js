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

      // period = YYYY-MM из даты
      const period = soldAt.slice(0, 7);

      valid.push({
        period, store_id: storeId, product_id: productId,
        amount, cost,
        gross_profit: amount - cost,
        quantity,
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
            `INSERT INTO sales (period, store_id, product_id, amount, cost, gross_profit, quantity, promo_code, customer_phone_normalized, sold_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [row.period, row.store_id, row.product_id, row.amount, row.cost,
             row.gross_profit, row.quantity, row.promo_code, row.customer_phone_normalized, row.sold_at]
          );
          inserted++;

          // Обновление атрибуции клиента по первому касанию
          if (row.customer_phone_normalized) {
            await client.query(
              `INSERT INTO mk_customer_attribution
                 (phone_normalized, first_promo_code, first_campaign_id,
                  first_purchase_date, first_purchase_sum, total_purchases, total_sum, last_purchase_date)
               VALUES (
                 $1, $2,
                 (SELECT id FROM mk_campaigns WHERE promo_code = $2 LIMIT 1),
                 $3::date, $4, 1, $4, $3::date
               )
               ON CONFLICT (phone_normalized) DO UPDATE SET
                 total_purchases = mk_customer_attribution.total_purchases + 1,
                 total_sum = mk_customer_attribution.total_sum + EXCLUDED.first_purchase_sum,
                 last_purchase_date = EXCLUDED.first_purchase_date,
                 updated_at = NOW()`,
              [row.customer_phone_normalized, row.promo_code, row.sold_at.slice(0,10), row.amount]
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

module.exports = { importCsv, recent, stats };
