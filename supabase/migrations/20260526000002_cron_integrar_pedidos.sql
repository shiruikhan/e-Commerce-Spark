-- ============================================================
-- Cron job para integrar-pedidos
-- Dispara em :05 e :35 — 5 minutos após integrar-clientes (:00 e :30)
-- garantindo que codparc atribuídos no ciclo corrente já estejam disponíveis
-- ============================================================

DO $$
DECLARE
  v_project_url text := 'https://obbymrwivuhjopwnmoxx.supabase.co';
  v_service_key text := current_setting('app.settings.service_role_key', true);
BEGIN

  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname = 'integrar-pedidos-30min';

  PERFORM cron.schedule(
    'integrar-pedidos-30min',
    '5,35 * * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/integrar-pedidos',
      v_service_key
    )
  );

END $$;
