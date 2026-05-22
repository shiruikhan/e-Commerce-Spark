-- ============================================================
-- Tabela cidade — espelho de TGFCID do Sankhya
-- Necessária para resolver CODCID ao criar bairros ausentes
-- ============================================================
CREATE TABLE public.cidade (
  codcid  bigint PRIMARY KEY,
  nomecid text   NOT NULL,
  uf      varchar(2)
);

ALTER TABLE public.cidade ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública de cidades"
  ON public.cidade FOR SELECT
  USING (true);

-- ============================================================
-- Tabela bairro — espelho de TGFBAI do Sankhya
-- Fonte local de lookup antes de qualquer chamada ao Sankhya
-- ============================================================
CREATE TABLE public.bairro (
  codbai  bigint PRIMARY KEY,
  nomebai text   NOT NULL,
  codcid  bigint REFERENCES public.cidade(codcid)
);

ALTER TABLE public.bairro ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública de bairros"
  ON public.bairro FOR SELECT
  USING (true);

CREATE INDEX bairro_nomebai_idx ON public.bairro (UPPER(TRIM(nomebai)));
CREATE INDEX bairro_codcid_idx  ON public.bairro (codcid);

-- ============================================================
-- Colunas de controle de integração na tabela cliente
-- Evita retentativas infinitas em erros permanentes do Sankhya
-- Valores: NULL = pendente, 'integrado', 'erro_permanente'
-- ============================================================
ALTER TABLE public.cliente
  ADD COLUMN integracao_status text,
  ADD COLUMN integracao_erro   text;

COMMENT ON COLUMN public.cliente.integracao_status IS 'NULL=pendente | integrado | erro_permanente';
