// VK Ads API клиент (новый кабинет ads.vk.com, raw HTTPS, без зависимостей).
// Док: https://ads.vk.com/doc/api/statistics — статистика по кампаниям.
//
// Возвращает данные за период в нашем формате:
//   { date, cost, impressions, clicks, conversions }
// (spent → cost, shows → impressions, clicks → clicks, goals → conversions).

const https = require('node:https');

const HOST = 'ads.vk.com';

function request({ token, path }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`VK Ads HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
            return;
          }
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`VK Ads parse error: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('VK Ads timeout')));
    req.end();
  });
}

// Дневная статистика по кампаниям за период.
// campaignIds — опц. фильтр по конкретным кампаниям VK Ads (массив id).
async function fetchDailyStats({ token, from, to, campaignIds }) {
  if (!token) throw new Error('VK Ads token не задан');
  if (!from || !to) throw new Error('from и to обязательны (YYYY-MM-DD)');

  const params = new URLSearchParams({
    date_from: from,
    date_to: to,
    metrics: 'all',
  });
  if (campaignIds && campaignIds.length) params.set('id', campaignIds.join(','));

  const data = await request({
    token,
    path: `/api/v2/statistics/campaigns/day.json?${params.toString()}`,
  });

  // Ответ: { items: [ { id, rows: [ { date, base: { spent, shows, clicks, goals } } ] } ] }
  // Суммируем по дате через все кампании (items) в один дневной ряд.
  const byDate = new Map();
  for (const item of data.items || []) {
    for (const row of item.rows || []) {
      const date = row.date;
      if (!date) continue;
      const base = row.base || {};
      const acc = byDate.get(date) || { date, cost: 0, impressions: 0, clicks: 0, conversions: 0 };
      acc.cost        += parseFloat(base.spent)  || 0;
      acc.impressions += parseInt(base.shows, 10) || 0;
      acc.clicks      += parseInt(base.clicks, 10) || 0;
      acc.conversions += parseInt(base.goals, 10) || 0;
      byDate.set(date, acc);
    }
  }

  return [...byDate.values()]
    .map(r => ({
      date: r.date,
      cost: Math.round(r.cost * 100) / 100,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { fetchDailyStats };
