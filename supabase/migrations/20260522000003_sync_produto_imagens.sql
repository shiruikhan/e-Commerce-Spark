-- Função que sincroniza produto_imagem a partir de ext_product_images.
-- Estratégia: DELETE+INSERT por produto coberto em ext_product_images,
--             priorizando resolução high > manual > low por (codprod, posição).
-- Chamada ao final do sync-produtos para vincular imagens recém-chegadas do Sankhya.

CREATE OR REPLACE FUNCTION sync_produto_imagens()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Remove entradas antigas para produtos cobertos por ext_product_images
  DELETE FROM produto_imagem
  WHERE codprod::text IN (
    SELECT DISTINCT product_code
    FROM ext_product_images
    WHERE deleted_at IS NULL
  );

  -- Insere uma imagem por (codprod, posição), priorizando high > manual > low
  INSERT INTO produto_imagem (codprod, url, ordem)
  SELECT
    product_code::bigint AS codprod,
    public_url           AS url,
    position             AS ordem
  FROM (
    SELECT DISTINCT ON (product_code::bigint, position)
      product_code,
      public_url,
      position
    FROM ext_product_images
    WHERE deleted_at IS NULL
      AND product_code::bigint IN (SELECT codprod FROM produto)
    ORDER BY
      product_code::bigint,
      position,
      CASE resolution_type
        WHEN 'high'   THEN 1
        WHEN 'manual' THEN 2
        WHEN 'low'    THEN 3
        ELSE               4
      END
  ) sub;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Popula produto_imagem com as imagens já presentes no storage
SELECT sync_produto_imagens();
