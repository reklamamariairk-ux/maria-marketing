-- Расширяем mk_campaign_daily.source под провенанс конкретной интеграции.
--
-- Корень проблемы: исходный CHECK (source IN ('manual','api','csv')) ронял ЛЮБОЙ
-- реальный синк — код интеграций пишет осмысленные метки источника
-- ('yandex-direct-api', 'yandex-metrika-api', 'vk-ads-api', 'instagram-graph-api',
-- 'csv-import', имя CSV-источника вроде 'avito'). Все они нарушали ограничение,
-- поэтому первый же вызов sync/import упал бы с check_violation.
--
-- Решение: снять узкий CHECK и удлинить колонку (VARCHAR(20) → VARCHAR(40)).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mk_campaign_daily'::regclass
      AND conname = 'mk_campaign_daily_source_check'
  ) THEN
    ALTER TABLE mk_campaign_daily DROP CONSTRAINT mk_campaign_daily_source_check;
  END IF;
END $$;

ALTER TABLE mk_campaign_daily ALTER COLUMN source TYPE VARCHAR(40);
