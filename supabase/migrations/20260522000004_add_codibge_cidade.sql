ALTER TABLE public.cidade
  ADD COLUMN codibge bigint;

COMMENT ON COLUMN public.cidade.codibge IS 'Código IBGE do município — usado no payload de criação de parceiro (campo codigolbge)';

CREATE UNIQUE INDEX cidade_codibge_idx ON public.cidade (codibge) WHERE codibge IS NOT NULL;
