# Maria Marketing

AI-помощник маркетолога кондитерской «Мария». Учёт кампаний по 13 каналам, расчёт ROI/LTV через привязку к покупкам в 1С, автоматические отчёты с предложениями на следующий месяц.

## Что умеет (Phase 1 — MVP)

- ✅ Управление кампаниями (13 каналов: Директ, IG, VK, TG, Авито, блогеры, листовки, ТВ, радио и др.)
- ✅ Промокоды → атрибуция к продажам в 1С
- ✅ ROI / ROAS / CPO / средний чек на каждую кампанию
- ✅ Графики потраченного vs выручка
- ⏳ LTV по номеру телефона (Phase 1, ждём расширения импорта 1С)

## Что будет (Phase 2-4)

- 🔌 API-интеграции: Яндекс.Директ, Метрика, VK Реклама, IG/Meta, Telegram
- 🤖 LLM-аналитик: еженедельные отчёты, рекомендации на следующий месяц
- 📲 Telegram-алерты: превышение бюджета, аномалии ROI
- 📦 Унификация с sales-plan-dashboard когда 1С УПП будет на веб-сервисе

## Запуск локально

```bash
cp .env.example .env
# отредактируй .env — пропиши DATABASE_URL и GROQ_API_KEY
npm install
npm run migrate     # применит миграции к указанной БД
npm start           # http://localhost:3001
```

## Деплой на Render

1. `git push origin master` (Render следит за репо)
2. В Render UI прописать env переменные из `.env.example`
3. После деплоя — миграции применятся автоматически при старте

## Архитектура

- **БД общая** с sales-plan-dashboard (Neon PostgreSQL)
- **Таблицы маркетинга** имеют префикс `mk_` — не пересекаются с dashboard'ом
- **Расширение sales** — добавлены поля `promo_code` и `customer_phone_normalized`
  для связки рекламы с продажами

См. `migrations/001_marketing_schema.sql` для деталей схемы.

## Каналы (засеяны миграцией)

| Code | Название | Категория | API |
|---|---|---|---|
| yandex_direct | Яндекс.Директ | paid_online | ✓ |
| yandex_metrika | Яндекс.Метрика | organic | ✓ |
| vk_ads | VK Реклама | paid_online | ✓ |
| instagram | Instagram | paid_online | ✓ |
| telegram | Telegram канал | organic | ✓ |
| avito | Авито | paid_online | ✗ |
| blogger | Блогеры | partnership | ✗ |
| promo | Акции | paid_offline | ✗ |
| flyer | Листовки | paid_offline | ✗ |
| banner | Баннеры | paid_offline | ✗ |
| poster | Афиши | paid_offline | ✗ |
| tv | ТВ-реклама | paid_offline | ✗ |
| radio | Радио | paid_offline | ✗ |
