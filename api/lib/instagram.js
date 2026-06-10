// Instagram (Meta Graph API) клиент — инсайты бизнес/креатор-аккаунта.
// Док: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/
//
// ⚠️ Депрекейты Meta 2025: для дневных рядов (period=day, since/until) метрики
// `impressions` и `profile_views` УБРАНЫ (impressions недоступна с 21.04.2025).
// Живой дневной time-series — это `reach` (metric_type=time_series). `views`
// поддерживает только total_value (без дневной разбивки), поэтому в дневной
// синк её не берём. Маппинг: reach → колонка impressions (охват = органический
// показ), cost = 0 (органика, как у Метрики).
//
// Требуется: ID Instagram-бизнес-аккаунта (igUserId) + long-lived access token
// (бизнес-аккаунт, связанный с FB-страницей).

const https = require('node:https');

const HOST = 'graph.facebook.com';
const API_VERSION = 'v25.0';

function request({ path }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: HOST, path, method: 'GET', headers: { Accept: 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (e) { reject(new Error(`Instagram parse error: ${e.message}`)); return; }
          if (res.statusCode !== 200 || parsed.error) {
            const msg = parsed.error ? `${parsed.error.message} (code ${parsed.error.code})` : raw.slice(0, 400);
            reject(new Error(`Instagram Graph HTTP ${res.statusCode}: ${msg}`));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('Instagram timeout')));
    req.end();
  });
}

function toUnix(dateStr) {
  // 'YYYY-MM-DD' → unix-секунды (UTC-полночь). Без Date.now/new Date() без аргумента.
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(ms)) throw new Error(`Невалидная дата: "${dateStr}"`);
  return Math.floor(ms / 1000);
}

// Дневной охват (reach) аккаунта за период.
// Возвращает [{ date, impressions(=reach), clicks:null, conversions:null }].
async function fetchDailyStats({ token, igUserId, from, to, metric = 'reach' }) {
  if (!token) throw new Error('Instagram access token не задан');
  if (!igUserId) throw new Error('igUserId (ID бизнес-аккаунта) обязателен');
  if (!from || !to) throw new Error('from и to обязательны (YYYY-MM-DD)');

  const params = new URLSearchParams({
    metric,
    period: 'day',
    metric_type: 'time_series',
    since: String(toUnix(from)),
    until: String(toUnix(to)),
    access_token: token,
  });

  const data = await request({
    path: `/${API_VERSION}/${igUserId}/insights?${params.toString()}`,
  });

  // Ответ: { data: [ { name:'reach', period:'day', values:[ { value, end_time } ] } ] }
  const series = (data.data || []).find(m => m.name === metric) || (data.data || [])[0];
  const values = series?.values || [];

  return values.map(v => ({
    date: (v.end_time || '').slice(0, 10), // ISO end_time → YYYY-MM-DD
    impressions: Math.round(v.value || 0),
    clicks: null,
    conversions: null,
  })).filter(r => r.date);
}

module.exports = { fetchDailyStats };
