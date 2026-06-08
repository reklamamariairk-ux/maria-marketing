-- Лиды рекламной кампании (приходят с лендингов/бота по UTM).
-- Дашборд кампании считает по ним CPL/CAC/конверсию/ROAS в разрезе каналов.
-- Источник истины — Bitrix24 CRM; сюда падает копия через /api/leads/ingest
-- (fire-and-forget из maria-bot при создании лида), чтобы дашборд был
-- самодостаточным и не зависел от доступности Bitrix-API.

CREATE TABLE IF NOT EXISTS mk_leads (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(200),
  phone         VARCHAR(40),
  source        VARCHAR(160),          -- человекочитаемый источник ("Лендинг бенто (сайт)")
  utm_source    VARCHAR(120),
  utm_medium    VARCHAR(120),
  utm_campaign  VARCHAR(160),
  utm_content   VARCHAR(160),
  utm_term      VARCHAR(160),
  channel_code  VARCHAR(32),           -- маппинг utm_source → mk_channels.code (vk_ads, yandex_direct, ...)
  description   TEXT,                  -- что заказывают (тип/вкус)
  portions      VARCHAR(60),
  comment       TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'qualified', 'won', 'lost')),
  revenue       NUMERIC(14,2) NOT NULL DEFAULT 0,   -- факт выручки при status='won'
  external_id   VARCHAR(80),           -- id лида в Bitrix24, если есть
  dedup_key     VARCHAR(160) UNIQUE,   -- идемпотентность приёма (повторный ingest не задвоит)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mk_leads_created     ON mk_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mk_leads_channel     ON mk_leads(channel_code);
CREATE INDEX IF NOT EXISTS idx_mk_leads_status      ON mk_leads(status);
CREATE INDEX IF NOT EXISTS idx_mk_leads_utm_source  ON mk_leads(utm_source);
