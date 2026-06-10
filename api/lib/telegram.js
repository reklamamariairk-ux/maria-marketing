// Telegram Bot API клиент (raw HTTPS, без зависимостей).
// Док: https://core.telegram.org/bots/api
//
// Ограничение платформы: Bot API НЕ отдаёт просмотры постов / расход рекламы —
// это есть только в MTProto (getStats для каналов). Через бота доступны
// надёжно лишь снимок подписчиков (getChatMemberCount) и инфо канала (getChat).
// Поэтому Telegram-канал трекаем как live-снимок «органики» (рост подписчиков),
// а не как строку расходов в mk_campaign_daily.
//
// ВАЖНО: бот должен быть админом канала, иначе getChat/getChatMemberCount
// вернут 403/400. chat — это @username канала или числовой chat_id (-100…).

const https = require('node:https');

const HOST = 'api.telegram.org';

function call({ token, method, params }) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params || {}).toString();
    const req = https.request(
      {
        hostname: HOST,
        path: `/bot${token}/${method}?${qs}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (e) { reject(new Error(`Telegram parse error: ${e.message}`)); return; }
          if (!parsed.ok) {
            reject(new Error(`Telegram ${method} error ${parsed.error_code}: ${parsed.description}`));
            return;
          }
          resolve(parsed.result);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Telegram timeout')));
    req.end();
  });
}

// Снимок состояния канала: название, @username, описание, число подписчиков.
async function fetchChannelStats({ token, chat }) {
  if (!token) throw new Error('Telegram bot token не задан');
  if (!chat) throw new Error('chat обязателен (@username или chat_id)');

  const [info, members] = await Promise.all([
    call({ token, method: 'getChat', params: { chat_id: chat } }),
    call({ token, method: 'getChatMemberCount', params: { chat_id: chat } }),
  ]);

  return {
    chat_id: info.id,
    type: info.type,
    title: info.title || null,
    username: info.username || null,
    description: info.description || null,
    members: typeof members === 'number' ? members : null,
  };
}

module.exports = { fetchChannelStats };
