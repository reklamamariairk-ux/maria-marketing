// LLM-маркет-аналитик. Собирает все данные за период, отправляет в Groq,
// возвращает структурированный отчёт (топ-кампании, проблемные, рекомендации).

const { pool } = require('../lib/db');
const { callGroq } = require('../lib/llm');

const SYSTEM_PROMPT = `Ты опытный маркетолог-аналитик кондитерской «Мария» (Иркутск, 16 точек).
На вход получаешь данные о рекламных кампаниях и продажах за период.
Твоя задача — проанализировать эффективность и выдать ВЫВОДЫ И ПРЕДЛОЖЕНИЯ.

Отвечай ВСЕГДА строго в JSON-формате:
{
  "summary": "одно-два предложения с главным выводом за период",
  "top_campaigns": [
    {"name": "Название", "roi_percent": 250, "comment": "почему хорошо"}
  ],
  "weak_campaigns": [
    {"name": "Название", "roi_percent": -40, "issue": "что не так", "action": "что предлагаешь — отключить/изменить креатив/уменьшить бюджет"}
  ],
  "channel_insights": [
    {"channel": "Авито", "performance": "rising/stable/declining", "comment": "анализ"}
  ],
  "anomalies": [
    "конкретная аномалия с цифрами"
  ],
  "recommendations": [
    {"priority": "high/medium/low", "action": "что делать", "rationale": "почему", "expected_impact": "ожидаемый эффект"}
  ],
  "next_month_strategy": "1-2 абзаца про стратегию на следующий месяц"
}

Принципы:
- Считай ROI = (Выручка - Расход) / Расход × 100%. Если расход 0 — пиши «нет данных о расходе».
- Считай ROAS = Выручка / Расход.
- Хорошо: ROI > 100%. Норма: 30-100%. Плохо: < 30%. Убыток: < 0%.
- При большом бюджете (>100к/мес) маленький ROI хуже чем при малом бюджете — учитывай абсолютные суммы.
- Для оффлайн (ТВ, радио, листовки) обычно ROI ниже — это нормально, главное LTV в перспективе.
- Если данных мало — честно скажи «недостаточно данных, нужно собрать больше».
- Не выдумывай цифры. Если в данных нет — не пиши.`;

// POST /api/analyze?period=2026-05
async function analyze(req, res) {
  try {
    const period = req.query.period || new Date().toISOString().slice(0, 7);

    // Собираем данные по кампаниям активным в этом периоде
    const { rows: campaigns } = await pool.query(
      `SELECT c.id, c.name, c.promo_code, c.start_date, c.end_date,
              c.budget_planned, c.goal, c.status, c.partner_name,
              ch.name AS channel_name, ch.category AS channel_category,
              COALESCE((SELECT SUM(cost) FROM mk_campaign_daily
                        WHERE campaign_id = c.id), 0)::numeric AS spent,
              CASE WHEN c.promo_code IS NOT NULL THEN
                COALESCE((SELECT SUM(amount) FROM sales WHERE promo_code = c.promo_code), 0)
              ELSE 0 END::numeric AS revenue,
              CASE WHEN c.promo_code IS NOT NULL THEN
                COALESCE((SELECT COUNT(*) FROM sales WHERE promo_code = c.promo_code), 0)
              ELSE 0 END AS orders,
              CASE WHEN c.promo_code IS NOT NULL THEN
                COALESCE((SELECT COUNT(DISTINCT customer_phone_normalized)
                          FROM sales WHERE promo_code = c.promo_code), 0)
              ELSE 0 END AS unique_customers
       FROM mk_campaigns c
       JOIN mk_channels ch ON ch.id = c.channel_id
       WHERE c.status IN ('active', 'completed')
         AND (c.start_date::text LIKE $1 OR c.end_date::text LIKE $1 OR
              (c.start_date <= ($1 || '-01')::date AND (c.end_date IS NULL OR c.end_date >= ($1 || '-01')::date)))
       ORDER BY revenue DESC`,
      [period + '%']
    );

    // Общая статистика продаж за период
    const { rows: salesStats } = await pool.query(
      `SELECT COUNT(*)::int AS total_orders,
              COALESCE(SUM(amount), 0)::numeric AS total_revenue,
              COUNT(DISTINCT customer_phone_normalized) FILTER (WHERE customer_phone_normalized IS NOT NULL)::int AS unique_customers,
              COUNT(*) FILTER (WHERE promo_code IS NOT NULL)::int AS orders_with_promo
       FROM sales
       WHERE period = $1`,
      [period]
    );

    // Топ продуктов
    const { rows: topProducts } = await pool.query(
      `SELECT product_id, COALESCE(SUM(amount), 0)::numeric AS revenue, COUNT(*)::int AS orders
       FROM sales WHERE period = $1 AND product_id IS NOT NULL
       GROUP BY product_id ORDER BY revenue DESC LIMIT 10`,
      [period]
    );

    if (campaigns.length === 0 && (salesStats[0]?.total_orders ?? 0) === 0) {
      res.json({
        ok: false,
        error: 'Нет данных за этот период. Создай кампании и загрузи продажи.',
        period,
      });
      return;
    }

    // Готовим контекст для LLM
    const userPrompt = `Период: ${period}

ВСЕГО ЗА ПЕРИОД:
- Заказов: ${salesStats[0]?.total_orders ?? 0}
- Выручка: ${Math.round(salesStats[0]?.total_revenue ?? 0)} ₽
- Уникальных клиентов: ${salesStats[0]?.unique_customers ?? 0}
- Заказов с промокодом: ${salesStats[0]?.orders_with_promo ?? 0}

КАМПАНИИ:
${campaigns.map((c, i) => `${i+1}. "${c.name}" (${c.channel_name}${c.partner_name ? ', ' + c.partner_name : ''})
   Промокод: ${c.promo_code || '—'}, Бюджет план: ${c.budget_planned} ₽, Потрачено: ${c.spent} ₽
   Выручка: ${c.revenue} ₽, Заказы: ${c.orders}, Уник.клиентов: ${c.unique_customers}
   ROI = ${c.spent > 0 ? Math.round(((c.revenue - c.spent) / c.spent) * 100) + '%' : 'нет расходов'}
   Статус: ${c.status}, Цель: ${c.goal || '—'}`).join('\n')}

ТОП ПРОДУКТЫ ПО ВЫРУЧКЕ:
${topProducts.length === 0 ? '(нет данных)' : topProducts.map((p, i) =>
  `${i+1}. ${p.product_id}: ${p.revenue} ₽ (${p.orders} заказов)`).join('\n')}

Проанализируй и дай развёрнутый отчёт по структуре JSON из system-промпта.`;

    const result = await callGroq({ system: SYSTEM_PROMPT, user: userPrompt });

    // Сохраняем в историю
    await pool.query(
      `INSERT INTO mk_reports (period_type, period_label, llm_model, prompt_data, report_html, insights)
       VALUES ('month', $1, 'llama-3.3-70b-versatile', $2::jsonb, $3, $4::jsonb)`,
      [
        period,
        JSON.stringify({ campaigns_count: campaigns.length, sales_stats: salesStats[0] }),
        '', // HTML генерится на фронте
        JSON.stringify(result),
      ]
    );

    res.json({
      ok: true,
      period,
      report: result,
      data_used: {
        campaigns_count: campaigns.length,
        total_orders: salesStats[0]?.total_orders ?? 0,
        total_revenue: salesStats[0]?.total_revenue ?? 0,
      },
    });
  } catch (err) {
    console.error('[analyze] failed:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/reports — список ранее сгенерированных отчётов
async function listReports(_req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, period_type, period_label, generated_at, insights, sent_to_telegram
       FROM mk_reports
       ORDER BY generated_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { analyze, listReports };
