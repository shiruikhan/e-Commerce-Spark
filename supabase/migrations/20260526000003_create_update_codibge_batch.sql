-- RPC utilizada pela Edge Function util-update-cidade-codibge para atualizar
-- cidade.codibge em lote via um único UPDATE com JOIN em jsonb_array_elements.
-- A verificação NOT EXISTS evita violar o índice único cidade_codibge_idx
-- quando Sankhya possui cidades duplicadas que mapeiam para o mesmo município IBGE.

CREATE OR REPLACE FUNCTION public.update_codibge_batch(updates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_atualizadas integer;
BEGIN
  UPDATE cidade c
  SET codibge = (u->>'codibge')::bigint
  FROM jsonb_array_elements(updates) AS u
  WHERE c.codcid = (u->>'codcid')::bigint
    AND NOT EXISTS (
      SELECT 1 FROM cidade c2
      WHERE c2.codibge = (u->>'codibge')::bigint
        AND c2.codcid  != (u->>'codcid')::bigint
    );

  GET DIAGNOSTICS v_atualizadas = ROW_COUNT;
  RETURN jsonb_build_object('atualizadas', v_atualizadas);
END;
$$;
