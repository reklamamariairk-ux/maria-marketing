// Дашборд кампании: приём лидов по UTM + сводка по каналам (CPL/CAC/конверсия/ROAS).
//
// Источник лидов — mk_leads (копия из Bitrix24 CRM, прилетает из maria-bot
// fire-and-forget при создании лида на лендинге). Расход — mk_campaign_daily.
// Свести по каналу: utm_source → mk_channels.code.

const crypto = require('crypto');
const { pool } = require('../lib/db');

// ── Маппинг utm_source (как его пишут в рекламных кабинетах) → код канала ──
function channelFromUtm(utmSource) {
  const s = String(utmSource || '').trim().toLowerCase();
  if (!s) return null;
  if (/(^|[^a-z])(vk|vkontakte|vk_ads|vkads)([^a-z]|$)/.test(s) || s === 'vk') return 'vk_ads';
  if (/yandex|direct|\bya\b|ya_direct|rsya/.test(s)) return 'yandex_direct';
  if (/telegram|^tg$|tg_ads|tgads|^tg/.test(s)) return 'telegram';
  if (/instagram|insta|^ig$/.test(s)) return 'instagram';
  if (/blog|bloger|influen/.test(s)) return 'blogger';
  if (/avito/.test(s)) return 'avito';
  if (/metrika|metrica/.test(s)) return 'yandex_metrika';
  return null; // неизвестный источник → попадёт в «Прочее/без атрибуции»
}

// ── POST /api/leads/ingest — приём лида (защита токеном) ──────────────────
async function ingest(req, res) {
  try {
    const token = process.env.INGEST_TOKEN || '';
    if (token) {
      const got = req.get('X-Ingest-Token') || '';
      // timing-safe сравнение одинаковой длины
      const a = Buffer.from(got);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'bad token' });
        return;
      }
    }

    const b = req.body || {};
    const utm = (b.utm && typeof b.utm === 'object') ? b.utm : {};
    const utmSource = b.utm_source || utm.utm_source || null;
    const channelCode = channelFromUtm(utmSource);

    // dedup_key: если не передан — строим из phone+source+минута, чтобы повтор
    // одного и того же fire-and-forget не задвоил лид.
    let dedup = b.dedup_key;
    if (!dedup) {
      const basis = [b.phone || '', b.source || '', utmSource || '',
                     new Date().toISOString().slice(0, 16)].join('|');
      dedup = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 32);
    }

    const { rows } = await pool.query(
      `INSERT INTO mk_leads
         (name, phone, source, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          channel_code, description, portions, comment, external_id, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [
        (b.name || '').slice(0, 200) || null,
        (b.phone || '').slice(0, 40) || null,
        (b.source || '').slice(0, 160) || null,
        utmSource ? String(utmSource).slice(0, 120) : null,
        (b.utm_medium || utm.utm_medium || null),
        (b.utm_campaign || utm.utm_campaign || null),
        (b.utm_content || utm.utm_content || null),
        (b.utm_term || utm.utm_term || null),
        channelCode,
        (b.description || '').slice(0, 2000) || null,
        (b.portions || '').slice(0, 60) || null,
        (b.comment || '').slice(0, 2000) || null,
        (b.external_id || '').slice(0, 80) || null,
        dedup,
      ]
    );

    // 200 даже при дедупе — отправителю (бот) не нужно ретраить
    res.json({ ok: true, id: rows[0]?.id ?? null, deduped: rows.length === 0, channel: channelCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── даты периода по умолчанию: текущий месяц ──────────────────────────────
function periodRange(req) {
  const today = new Date();
  const ym = today.toISOString().slice(0, 7);
  const from = (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from))
    ? req.query.from : `${ym}-01`;
  const to = (req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to))
    ? req.query.to : today.toISOString().slice(0, 10);
  return { from, to };
}

// ── GET /api/campaign/overview?from=&to= — сводка по каналам ───────────────
async function overview(req, res) {
  try {
    const { from, to } = periodRange(req);

    // Расход по каналам за период (из дневных расходов кампаний)
    const { rows: spendRows } = await pool.query(
      `SELECT ch.code AS channel_code, ch.name AS channel_name,
              COALESCE(SUM(d.cost), 0)::numeric AS spend,
              COALESCE(SUM(d.clicks), 0)::int   AS clicks,
              COALESCE(SUM(d.impressions), 0)::int AS impressions
         FROM mk_campaign_daily d
         JOIN mk_campaigns c ON c.id = d.campaign_id
         JOIN mk_channels  ch ON ch.id = c.channel_id
        WHERE d.date BETWEEN $1 AND $2
        GROUP BY ch.code, ch.name`,
      [from, to]
    );

    // Лиды по каналам за период
    const { rows: leadRows } = await pool.query(
      `SELECT COALESCE(channel_code, '__none__') AS channel_code,
              COUNT(*)::int AS leads,
              COUNT(*) FILTER (WHERE status = 'won')::int AS won,
              COALESCE(SUM(revenue) FILTER (WHERE status = 'won'), 0)::numeric AS revenue
         FROM mk_leads
        WHERE created_at::date BETWEEN $1 AND $2
        GROUP BY COALESCE(channel_code, '__none__')`,
      [from, to]
    );

    // Справочник имён каналов
    const { rows: chRows } = await pool.query(`SELECT code, name FROM mk_channels`);
    const chName = new Map(chRows.map(r => [r.code, r.name]));
    chName.set('__none__', 'Без атрибуции (прямые/неизвестно)');

    // Сводим по коду канала
    const byCode = new Map();
    const ensure = (code) => {
      if (!byCode.has(code)) {
        byCode.set(code, {
          channel_code: code,
          channel_name: chName.get(code) || code,
          spend: 0, clicks: 0, impressions: 0,
          leads: 0, won: 0, revenue: 0,
        });
      }
      return byCode.get(code);
    };
    for (const r of spendRows) {
      const x = ensure(r.channel_code);
      x.spend = Number(r.spend); x.clicks = Number(r.clicks); x.impressions = Number(r.impressions);
    }
    for (const r of leadRows) {
      const x = ensure(r.channel_code);
      x.leads = Number(r.leads); x.won = Number(r.won); x.revenue = Number(r.revenue);
    }

    const round = (n) => Math.round(n);
    const round2 = (n) => Math.round(n * 100) / 100;
    const rows = [...byCode.values()].map(x => ({
      ...x,
      cpl:  x.leads > 0 ? round(x.spend / x.leads) : null,   // цена лида
      cac:  x.won  > 0 ? round(x.spend / x.won)  : null,     // цена заказа
      conversion: x.leads > 0 ? round2((x.won / x.leads) * 100) : null, // лид→заказ, %
      roas: x.spend > 0 && x.revenue > 0 ? round2(x.revenue / x.spend) : null,
      drr:  x.revenue > 0 ? round2((x.spend / x.revenue) * 100) : null,  // ДРР, %
    })).sort((a, b) => b.spend - a.spend || b.leads - a.leads);

    // Итоги
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const tSpend = sum('spend'), tLeads = sum('leads'), tWon = sum('won'), tRevenue = sum('revenue');
    const totals = {
      spend: tSpend, leads: tLeads, won: tWon, revenue: tRevenue,
      clicks: sum('clicks'), impressions: sum('impressions'),
      cpl:  tLeads > 0 ? round(tSpend / tLeads) : null,
      cac:  tWon  > 0 ? round(tSpend / tWon)  : null,
      conversion: tLeads > 0 ? round2((tWon / tLeads) * 100) : null,
      roas: tSpend > 0 && tRevenue > 0 ? round2(tRevenue / tSpend) : null,
      drr:  tRevenue > 0 ? round2((tSpend / tRevenue) * 100) : null,
    };

    res.json({ from, to, rows, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/campaign/leads?from=&to=&channel=&limit= — список лидов ───────
async function leadsList(req, res) {
  try {
    const { from, to } = periodRange(req);
    const params = [from, to];
    let where = `created_at::date BETWEEN $1 AND $2`;
    if (req.query.channel) {
      params.push(req.query.channel);
      where += ` AND channel_code = $${params.length}`;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, name, phone, source, utm_source, utm_campaign, channel_code,
              description, portions, status, revenue, created_at
         FROM mk_leads
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── PATCH /api/leads/:id — статус/выручка (маркетолог помечает «заказ») ────
async function patchLead(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) { res.status(400).json({ error: 'bad id' }); return; }
    const sets = [], vals = [];
    if (req.body.status !== undefined) {
      const st = String(req.body.status);
      if (!['new', 'qualified', 'won', 'lost'].includes(st)) {
        res.status(400).json({ error: 'bad status' }); return;
      }
      vals.push(st); sets.push(`status = $${vals.length}`);
    }
    if (req.body.revenue !== undefined) {
      vals.push(Number(req.body.revenue) || 0); sets.push(`revenue = $${vals.length}`);
    }
    if (!sets.length) { res.status(400).json({ error: 'nothing to update' }); return; }
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE mk_leads SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, status, revenue`,
      vals
    );
    if (!rows[0]) { res.status(404).json({ error: 'not found' }); return; }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── DELETE /api/leads/:id — удалить (чистка тестовых) ──────────────────────
async function deleteLead(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(`DELETE FROM mk_leads WHERE id = $1`, [id]);
    if (!rowCount) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { ingest, overview, leadsList, patchLead, deleteLead, channelFromUtm };
