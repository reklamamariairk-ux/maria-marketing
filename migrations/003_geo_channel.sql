-- Канал «Яндекс Карты / 2ГИС» — гео-сервисы (трафик в магазины) для
-- сентябрьской кампании. Остальные каналы уже засеяны миграцией 001.
INSERT INTO mk_channels (code, name, category, api_integration) VALUES
  ('geo_services', 'Яндекс Карты / 2ГИС', 'paid_online', false)
ON CONFLICT (code) DO NOTHING;
