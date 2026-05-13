// Yandex.Direct API клиент (raw HTTPS, без зависимостей).
// Док: https://yandex.ru/dev/direct/doc/reports/reports.html
//
// Использует Reports Service (POST /v5/reports). Возвращает данные за период
// в нашем формате: { date, cost, impressions, clicks, conversions }.

const https = require('node:https');

const REPORT_HOST = 'api.direct.yandex.com';
const REPORT_PATH = '/json/v5/reports';

// Получение TSV-отчёта за период.
// campaignIds — опц. фильтр по конкретным кампаниям Я.Директ.
async function fetchDailyStats({ token, from, to, campaignIds }) {
  if (!token) throw new Error('Yandex.Direct token не задан');
  if (!from || !to) throw new Error('from и to обязательны');

  const body = {
    params: {
      SelectionCriteria: campaignIds && campaignIds.length
        ? { CampaignIds: campaignIds, DateFrom: from, DateTo: to }
        : { DateFrom: from, DateTo: to },
      FieldNames: ['Date', 'Cost', 'Impressions', 'Clicks', 'Conversions'],
      ReportName: `daily-${from}-${to}-${Date.now()}`,
      ReportType: 'CUSTOM_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
      IncludeDiscount: 'YES',
    },
  };

  const tsv = await postReport({ token, body });
  return parseReportTsv(tsv);
}

// Reports API асинхронный: первый запрос возвращает 201/202 (отчёт строится),
// потом надо повторять с тем же телом, пока не вернётся 200 с данными.
function postReport({ token, body, attempt = 0 }) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = https.request(
      {
        hostname: REPORT_HOST,
        path: REPORT_PATH,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Language': 'ru',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(json),
          processingMode: 'auto',
          returnMoneyInMicros: 'false',
          skipReportHeader: 'true',
          skipColumnHeader: 'false',
          skipReportSummary: 'true',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          // 200 OK — отчёт готов
          // 201/202 — строится, повторить через retryIn секунд
          if (res.statusCode === 200) { resolve(raw); return; }
          if ((res.statusCode === 201 || res.statusCode === 202) && attempt < 8) {
            const retryIn = parseInt(res.headers['retryin'] || res.headers['retry-after'] || '5', 10);
            setTimeout(() => {
              postReport({ token, body, attempt: attempt + 1 }).then(resolve).catch(reject);
            }, Math.min(retryIn * 1000, 30000));
            return;
          }
          reject(new Error(`Yandex.Direct HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Yandex.Direct timeout')));
    req.write(json);
    req.end();
  });
}

function parseReportTsv(tsv) {
  const lines = tsv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split('\t').map(s => s.trim());
  const idx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const iDate = idx('Date');
  const iCost = idx('Cost');
  const iImp = idx('Impressions');
  const iClicks = idx('Clicks');
  const iConv = idx('Conversions');

  return lines.slice(1).map(line => {
    const c = line.split('\t');
    return {
      date: c[iDate],
      cost: parseFloat((c[iCost] || '0').replace(',', '.')) || 0,
      impressions: parseInt(c[iImp] || '0', 10) || 0,
      clicks: parseInt(c[iClicks] || '0', 10) || 0,
      conversions: parseInt(c[iConv] || '0', 10) || 0,
    };
  }).filter(r => r.date);
}

module.exports = { fetchDailyStats };
