-- Maria Marketing — расширение существующей БД sales-plan-dashboard.
-- Идея: добавляем таблицы для кампаний и атрибуции, расширяем sales
-- promo_code и customer_phone.
--
-- ВАЖНО: эти таблицы живут в той же Neon БД что и dashboard. Они не
-- конфликтуют с существующими (sales, stores, products, marketing_metrics).
-- Существующая marketing_metrics остаётся как агрегатное хранилище.

-- ── Расширение sales для атрибуции ────────────────────────────────────────

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS customer_phone_normalized VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_sales_promo_code
  ON sales(promo_code) WHERE promo_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_customer_phone
  ON sales(customer_phone_normalized) WHERE customer_phone_normalized IS NOT NULL;

-- ── Справочник каналов маркетинга ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mk_channels (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(32) UNIQUE NOT NULL, -- 'avito', 'yandex_direct', 'instagram', 'blogger', etc.
  name         VARCHAR(100) NOT NULL,
  category     VARCHAR(20) NOT NULL CHECK (category IN ('paid_online', 'paid_offline', 'organic', 'partnership')),
  api_integration BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Засеваем дефолтные каналы из бизнеса
INSERT INTO mk_channels (code, name, category, api_integration) VALUES
  ('yandex_direct',   'Яндекс.Директ',   'paid_online',  true),
  ('yandex_metrika',  'Яндекс.Метрика',  'organic',      true),
  ('vk_ads',          'VK Реклама',      'paid_online',  true),
  ('instagram',       'Instagram',       'paid_online',  true),
  ('telegram',        'Telegram канал',  'organic',      true),
  ('avito',           'Авито',           'paid_online',  false),
  ('blogger',         'Блогеры',         'partnership',  false),
  ('promo',           'Акции',           'paid_offline', false),
  ('flyer',           'Листовки',        'paid_offline', false),
  ('banner',          'Баннеры',         'paid_offline', false),
  ('poster',          'Афиши',           'paid_offline', false),
  ('tv',              'ТВ-реклама',      'paid_offline', false),
  ('radio',           'Радио',           'paid_offline', false)
ON CONFLICT (code) DO NOTHING;

-- ── Кампании ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mk_campaigns (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  channel_id     INTEGER NOT NULL REFERENCES mk_channels(id),
  promo_code     VARCHAR(50) UNIQUE,  -- может быть NULL (например, охватная кампания)
  start_date     DATE NOT NULL,
  end_date       DATE,                 -- NULL = бессрочная
  budget_planned NUMERIC(14,2) NOT NULL DEFAULT 0,  -- бюджет в рублях, плановый
  goal           VARCHAR(20) CHECK (goal IN ('sales', 'leads', 'reach', 'traffic')),
  creative_url   TEXT,                 -- ссылка на креатив (макет / промо)
  status         VARCHAR(20) NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned', 'active', 'paused', 'completed', 'archived')),
  notes          TEXT,                 -- свободные комментарии маркетолога
  partner_name   VARCHAR(100),         -- для блогеров — имя блогера, для радио — название станции
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_channel ON mk_campaigns(channel_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_period
  ON mk_campaigns(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON mk_campaigns(status);

-- ── Ежедневные расходы по кампаниям ───────────────────────────────────────
-- Для API-каналов (Директ, VK, IG) — auto-import.
-- Для оффлайн — ручной ввод.

CREATE TABLE IF NOT EXISTS mk_campaign_daily (
  id             SERIAL PRIMARY KEY,
  campaign_id    INTEGER NOT NULL REFERENCES mk_campaigns(id) ON DELETE CASCADE,
  date           DATE NOT NULL,
  cost           NUMERIC(14,2) NOT NULL DEFAULT 0,
  impressions    INTEGER,
  clicks         INTEGER,
  conversions    INTEGER,
  source         VARCHAR(20) NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'api', 'csv')),
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, date)
);

CREATE INDEX IF NOT EXISTS idx_campaign_daily_date ON mk_campaign_daily(date);

-- ── Атрибуция клиентов по первому касанию ────────────────────────────────
-- Один клиент = один номер телефона. Первый купленный с промокодом —
-- это «канал привлечения». Дальше все его покупки приписываем этому каналу
-- (last-touch attribution в комментариях — пока first-touch).

CREATE TABLE IF NOT EXISTS mk_customer_attribution (
  phone_normalized          VARCHAR(20) PRIMARY KEY,
  first_promo_code          VARCHAR(50),
  first_campaign_id         INTEGER REFERENCES mk_campaigns(id),
  first_purchase_date       DATE NOT NULL,
  first_purchase_sum        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_purchases           INTEGER NOT NULL DEFAULT 1,
  total_sum                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_purchase_date        DATE,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attribution_campaign
  ON mk_customer_attribution(first_campaign_id);

-- ── Промокоды (для централизованного управления) ─────────────────────────
-- Маркетолог придумывает промокод → привязывает к кампании.
-- Когда 1С импортирует продажу с этим промокодом — связь автоматическая.

CREATE TABLE IF NOT EXISTS mk_promo_codes (
  code             VARCHAR(50) PRIMARY KEY,
  campaign_id      INTEGER NOT NULL REFERENCES mk_campaigns(id) ON DELETE CASCADE,
  discount_type    VARCHAR(20) CHECK (discount_type IN ('percent', 'fixed', 'none')),
  discount_value   NUMERIC(14,2),     -- % или фикс. сумма
  max_uses         INTEGER,           -- ограничение количества использований
  expires_at       DATE,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── LLM-отчёты (история генерации) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mk_reports (
  id           SERIAL PRIMARY KEY,
  period_type  VARCHAR(20) NOT NULL CHECK (period_type IN ('week', 'month', 'quarter', 'ad-hoc')),
  period_label VARCHAR(50) NOT NULL,  -- '2026-05', '2026-W19', etc.
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  llm_model    VARCHAR(50),
  prompt_data  JSONB,                 -- что отправили в LLM
  report_html  TEXT NOT NULL,         -- сгенерированный HTML
  insights     JSONB,                 -- структурированные выводы (топ-кампании, аномалии, рекомендации)
  sent_to_telegram BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_reports_period ON mk_reports(period_label);
