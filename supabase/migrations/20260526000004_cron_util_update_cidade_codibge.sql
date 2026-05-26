-- Cron para util-update-cidade-codibge: executa diariamente às 00:45 UTC,
-- 15 minutos após sync-bairros-daily (00:30), garantindo que as cidades
-- importadas do Sankhya já estejam na tabela antes do enriquecimento com IBGE.

DO $$
DECLARE
  v_project_url text := 'https://obbymrwivuhjopwnmoxx.supabase.co';
BEGIN

  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname = 'util-update-cidade-codibge-daily';

  PERFORM cron.schedule(
    'util-update-cidade-codibge-daily',
    '45 0 * * *',
    format(
      $sql$SELECT net.http_post(
          url     := %L,
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body    := '{}'::jsonb
        )$sql$,
      v_project_url || '/functions/v1/util-update-cidade-codibge'
    )
  );

END $$;
