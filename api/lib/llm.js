// LLM-аналитик через Groq API (Llama 3.3 70B).
// Тот же подход что в sales-plan-dashboard — без зависимостей, raw HTTPS.

const https = require('node:https');

const MODEL = 'llama-3.3-70b-versatile';
const TIMEOUT_MS = 45000;

function callGroq({ system, user }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY не задан');

  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Groq HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            const content = parsed.choices?.[0]?.message?.content;
            if (!content) { reject(new Error('Пустой ответ от Groq')); return; }
            resolve(JSON.parse(content));
          } catch (e) {
            reject(new Error(`Groq parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { callGroq };
