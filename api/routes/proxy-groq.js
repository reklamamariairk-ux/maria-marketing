// Прокси к api.groq.com — для клиентов с заблокированным IP (например sales-
// dashboard на РФ VDS). Использует тот же GROQ_API_KEY что и /api/analyze.
//
// Защита: PROXY_AUTH_KEY (env). Если не задан — endpoint выключен (503),
// чтобы не работать как открытый proxy для абуза.
//
// Использование (Groq-совместимо):
//   POST https://maria-marketing.onrender.com/api/proxy/groq/v1/chat/completions
//   Authorization: Bearer <PROXY_AUTH_KEY>
//   Content-Type: application/json
//   {model, messages, ...}

const https = require('node:https');

async function readBody(req) {
  // Express уже распарсил json в req.body — но нам нужен сырой буфер для проксирования
  if (req.body && Object.keys(req.body).length) {
    return Buffer.from(JSON.stringify(req.body));
  }
  return Buffer.alloc(0);
}

function proxyChatCompletions(req, res) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const PROXY_AUTH_KEY = process.env.PROXY_AUTH_KEY;

  if (!PROXY_AUTH_KEY) {
    return res.status(503).json({ error: 'PROXY_AUTH_KEY не настроен на сервере' });
  }
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'GROQ_API_KEY не настроен' });
  }
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (auth !== PROXY_AUTH_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  readBody(req).then((body) => {
    const upstream = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Accept': 'application/json'
      }
    }, (upRes) => {
      res.status(upRes.statusCode || 502);
      // Копируем content-type, остальное Express установит сам
      const ct = upRes.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      upRes.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.status(502).json({ error: 'upstream', message: e.message });
    });
    upstream.setTimeout(45000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.write(body);
    upstream.end();
  }).catch((e) => {
    res.status(500).json({ error: e.message });
  });
}

module.exports = { proxyChatCompletions };
