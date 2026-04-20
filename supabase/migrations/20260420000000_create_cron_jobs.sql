-- ============================================================
-- Criação dos pg_cron jobs para sincronização com Sankhya
-- ============================================================
-- Requer: extensões pg_cron e pg_net habilitadas no Supabase
-- Dashboard → Database → Extensions → pg_cron + pg_net
-- ============================================================

DO $$
DECLARE
  v_project_url text := 'https://obbymrwivuhjopwnmoxx.supabase.co';
  v_service_key text := current_setting('app.settings.service_role_key', true);
BEGIN

  -- Remove jobs antigos se existirem (idempotente)
  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname IN (
    'sync-produtos-hourly',
    'sync-estoque-30min',
    'integrar-clientes-30min',
    'sync-precos-daily',
    'sync-especificacoes-daily',
    'sync-categorias-daily',
    'log-sincronizacao-cleanup'
  );

  -- sync-produtos: a cada hora
  PERFORM cron.schedule(
    'sync-produtos-hourly',
    '0 * * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/sync-produtos',
      v_service_key
    )
  );

  -- sync-estoque: a cada 30 minutos
  PERFORM cron.schedule(
    'sync-estoque-30min',
    '*/30 * * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/sync-estoque',
      v_service_key
    )
  );

  -- integrar-clientes: a cada 30 minutos
  PERFORM cron.schedule(
    'integrar-clientes-30min',
    '*/30 * * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/integrar-clientes',
      v_service_key
    )
  );

  -- sync-precos: diário às 01:00 UTC
  PERFORM cron.schedule(
    'sync-precos-daily',
    '0 1 * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/sync-precos',
      v_service_key
    )
  );

  -- sync-especificacoes: diário às 02:00 UTC
  PERFORM cron.schedule(
    'sync-especificacoes-daily',
    '0 2 * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/sync-especificacoes',
      v_service_key
    )
  );

  -- sync-categorias: diário às 03:00 UTC
  PERFORM cron.schedule(
    'sync-categorias-daily',
    '0 3 * * *',
    format(
      $$SELECT net.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := '{}'::jsonb
        )$$,
      v_project_url || '/functions/v1/sync-categorias',
      v_service_key
    )
  );

  -- limpeza do log_sincronizacao: toda segunda às 04:00 UTC (mantém 60 dias)
  PERFORM cron.schedule(
    'log-sincronizacao-cleanup',
    '0 4 * * 1',
    $$DELETE FROM log_sincronizacao WHERE criado_em < now() - interval '60 days'$$
  );

END $$;
