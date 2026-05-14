// Yandex.Metrika API клиент (raw HTTPS).
// Документация:
//   Management API: https://yandex.ru/dev/metrika/doc/api2/management/counters.html
//   Stat API:       https://yandex.ru/dev/metrika/doc/api2/api_v1/data.html

const https = require('node:https');

const HOST = 'api-metrika.yandex.net';

function request({ token, path }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path,
        method: 'GET',
        headers: {
          Authorization: `OAuth ${token}`,
          Accept: 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Yandex.Metrika HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
            return;
          }
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`Metrika parse error: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('Yandex.Metrika timeout')));
    req.end();
  });
}

// Список счётчиков, к которым у токена есть доступ
async function listCounters({ token }) {
  if (!token) throw new Error('Metrika token не задан');
  const data = await request({ token, path: '/management/v1/counters?per_page=100' });
  return (data.counters || []).map(c => ({
    id: c.id,
    name: c.name,
    site: c.site,
    status: c.status,
    permission: c.permission,
  }));
}

// Список целей счётчика (нужно знать ID цели для замера конверсий)
async function listGoals({ token, counterId }) {
  if (!token) throw new Error('Metrika token не задан');
  if (!counterId) throw new Error('counterId обязателен');
  const data = await request({ token, path: `/management/v1/counter/${counterId}/goals` });
  return (data.goals || []).map(g => ({
    id: g.id, name: g.name, type: g.type, is_retargeting: g.is_retargeting,
  }));
}

// Статистика визитов и конверсий за период.
// Поддерживается фильтр по UTM (для атрибуции к конкретной кампании).
//
// goalIds — массив ID целей для подсчёта достижений (опц.)
// utmCampaign — точное значение utm_campaign (напр. промокод "LETO26")
// utmSource — utm_source (напр. "yandex", "vk", "telegram")
async function fetchDailyStats({ token, counterId, from, to, goalIds, utmCampaign, utmSource }) {
  if (!token) throw new Error('Metrika token не задан');
  if (!counterId) throw new Error('counterId обязателен');
  if (!from || !to) throw new Error('from и to обязательны (YYYY-MM-DD)');

  const metrics = ['ym:s:visits', 'ym:s:users', 'ym:s:bounceRate', 'ym:s:pageviews'];
  if (goalIds && goalIds.length) {
    for (const gid of goalIds) metrics.push(`ym:s:goal${gid}reaches`);
  }

  const filters = [];
  if (utmCampaign) filters.push(`ym:s:UTMCampaign=='${utmCampaign.replace(/'/g, "\\'")}'`);
  if (utmSource) filters.push(`ym:s:UTMSource=='${utmSource.replace(/'/g, "\\'")}'`);

  const params = new URLSearchParams({
    ids: String(counterId),
    date1: from,
    date2: to,
    metrics: metrics.join(','),
    dimensions: 'ym:s:date',
    accuracy: 'full',
    limit: '100000',
    sort: 'ym:s:date',
  });
  if (filters.length) params.set('filters', filters.join(' AND '));

  const data = await request({ token, path: `/stat/v1/data?${params.toString()}` });

  // Парсим matrix-формат Метрики
  return (data.data || []).map(row => {
    const date = row.dimensions?.[0]?.name; // YYYY-MM-DD
    const m = row.metrics || [];
    const visits = m[0] || 0;
    const users = m[1] || 0;
    const bounceRate = m[2] || 0;
    const pageviews = m[3] || 0;
    // Суммируем достижения всех указанных целей
    let conversions = 0;
    for (let i = 4; i < m.length; i++) conversions += (m[i] || 0);
    return {
      date,
      visits: Math.round(visits),
      users: Math.round(users),
      pageviews: Math.round(pageviews),
      bounce_rate: Math.round(bounceRate * 100) / 100,
      conversions: Math.round(conversions),
    };
  }).filter(r => r.date);
}

module.exports = { listCounters, listGoals, fetchDailyStats };
