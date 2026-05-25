-- Adiciona codcid em endereco com FK para cidade e índice para lookup eficiente.
-- Substitui a busca por texto (cidade nome) no integrar-clientes por lookup direto por PK.

ALTER TABLE public.endereco
  ADD COLUMN codcid bigint REFERENCES public.cidade(codcid) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX idx_endereco_codcid ON public.endereco(codcid);

-- Backfill: resolve codcid para os endereços existentes via match de nome de cidade (case-insensitive)
UPDATE public.endereco e
SET codcid = c.codcid
FROM public.cidade c
WHERE lower(trim(e.cidade)) = lower(trim(c.nomecid))
  AND e.codcid IS NULL;
