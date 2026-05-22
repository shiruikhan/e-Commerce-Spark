-- Cron para sync-bairros: executa diariamente às 00:30 UTC
-- Roda antes dos outros syncs diários (preco=01:00, espec=02:00, cat=03:00)
SELECT cron.schedule(
  'sync-bairros-daily',
  '30 0 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://obbymrwivuhjopwnmoxx.supabase.co/functions/v1/sync-bairros',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
