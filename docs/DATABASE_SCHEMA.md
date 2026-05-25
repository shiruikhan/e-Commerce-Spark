# Schema do Banco de Dados — Supabase (PostgreSQL)

Todas as tabelas estão no schema `public`. RLS habilitado em todas.

---

## Catálogo

### `produto`
Tabela principal de produtos. Espelha os campos relevantes do TGFPRO do Sankhya.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codprod` | `bigint` | NO | — | PK — código do produto no Sankhya |
| `descrprod` | `text` | NO | — | Nome técnico do produto |
| `comnome` | `text` | YES | — | Nome comercial (`AD_COMNOME`) |
| `desccurta` | `text` | YES | — | Descrição curta para e-commerce (`AD_DESCCURTA`) |
| `descrprodoed` | `text` | YES | — | Descrição longa para e-commerce (`AD_DESCRPRODOED`) |
| `syncsite` | `text` | YES | `'N'` | Espelho local de `AD_SYNCSITE` do Sankhya |
| `codgrupoprod` | `bigint` | YES | — | FK → `categoria.codgrupoprod` |
| `peso` | `numeric` | YES | — | Peso bruto em kg (`PESOBRUTO`) |
| `altura` | `numeric` | YES | — | Altura em cm |
| `largura` | `numeric` | YES | — | Largura em cm |
| `comprimento` | `numeric` | YES | — | Comprimento/profundidade em cm (`ESPESSURA`) |
| `dtalter` | `timestamptz` | YES | — | Data da última alteração no Sankhya — controle incremental |
| `codprodemb` | `bigint` | YES | — | FK → `embalagem.codprod` — embalagem padrão do produto |
| `qtdemb` | `integer` | YES | — | Quantidade de unidades por embalagem |

> **Sync:** apenas produtos com `AD_SYNCSITE='S'` no Sankhya. Controle incremental por `DTALTER`.

---

### `categoria`
Grupos de produto do Sankhya (TGFGRU). Hierarquia self-referencing.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codgrupoprod` | `bigint` | NO | — | PK — código do grupo no Sankhya |
| `descr_grupo` | `text` | NO | — | Descrição do grupo (`DESCRGRUPOPROD`) |
| `codgrupopai` | `bigint` | YES | — | FK self-referencing → `categoria.codgrupoprod`. `null` = raiz |

> **Sync:** `CODGRUPAI = 0` ou negativo no Sankhya → `null` aqui. Upsert em batches topológicos para respeitar a FK.

---

### `especificacao`
Atributos técnicos dos produtos (preenchimento manual ou futuro sync).

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id_espec` | `bigint` | NO | — | PK |
| `codprod` | `bigint` | YES | — | FK → `produto.codprod` |
| `label` | `text` | NO | — | Nome do atributo (ex: "Voltagem") |
| `valor` | `text` | NO | — | Valor do atributo (ex: "110V/220V") |

---

### `produto_imagem`
URLs de imagens dos produtos (preenchimento manual).

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `codprod` | `bigint` | YES | — | FK → `produto.codprod` |
| `url` | `text` | NO | — | URL pública da imagem |
| `ordem` | `integer` | YES | `0` | Ordem de exibição |

---

## Comercial

### `estoque`
Posição de estoque real por produto. Fonte: TGFEST (CODEMP=1, CODLOCAL=109).

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codprod` | `bigint` | NO | — | PK / FK → `produto.codprod` |
| `estoque_real` | `numeric` | YES | `0` | Saldo real do Sankhya (`ESTOQUE`) |
| `proporcao` | `numeric` | YES | `1.00` | Fator de conversão de unidade — **gerenciado manualmente no Supabase** |
| `estoque_disponivel` | `numeric` | YES | — | **GENERATED ALWAYS AS** `estoque_real * proporcao` — não incluir em upsert |
| `dt_atualizacao` | `timestamptz` | YES | `now()` | Timestamp da última atualização |

> **Atenção:** `estoque_disponivel` é gerado pelo banco. Nunca incluir no payload de upsert.
> Quando um produto some da TGFEST no Sankhya (estoque zerado), `estoque_real` é zerado no Supabase para desabilitar o produto no e-commerce.

---

### `preco`
Preços de venda por tabela. Fonte: TGFPRC, tabela 201.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK (serial) |
| `codprod` | `bigint` | YES | — | FK → `produto.codprod` |
| `vlr_venda` | `numeric` | NO | — | Preço de venda (`VLRVENDA`) |
| `codtab` | `bigint` | NO | — | Código da tabela de preço (201 = e-commerce) |
| `dtalter` | `timestamptz` | YES | `now()` | Timestamp da última atualização pelo sync |

> **Constraint:** `UNIQUE(codprod, codtab)` — necessário para o upsert com `onConflict: 'codprod,codtab'`.

---

## Clientes

### `cliente`
Cadastro de clientes, vinculado ao `auth.users` do Supabase.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `uuid` | NO | — | PK / FK → `auth.users.id` |
| `codparc` | `bigint` | YES | — | Código do parceiro no Sankhya (preenchido após integração) |
| `nome` | `text` | YES | — | Nome completo |
| `cpf_cnpj` | `text` | YES | — | CPF ou CNPJ |
| `email` | `text` | YES | — | E-mail |
| `telefone` | `text` | YES | — | Telefone |
| `is_admin` | `boolean` | NO | `false` | Flag de administrador |
| `integracao_status` | `text` | YES | — | `NULL` = pendente / `integrado` / `erro_permanente` |
| `integracao_erro` | `text` | YES | — | Mensagem do último erro de integração com Sankhya |

---

### `endereco`
Endereços de entrega dos clientes.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `cliente_id` | `uuid` | YES | — | FK → `cliente.id` |
| `tipo` | `text` | YES | `'Entrega'` | Tipo do endereço |
| `cep` | `text` | YES | — | CEP |
| `logradouro` | `text` | YES | — | Rua/Avenida |
| `numero` | `text` | YES | — | Número |
| `complemento` | `text` | YES | — | Complemento |
| `bairro` | `text` | YES | — | Bairro |
| `cidade` | `text` | YES | — | Cidade |
| `uf` | `varchar` | YES | — | Estado (2 letras) |
| `is_padrao` | `boolean` | NO | `false` | Endereço padrão do cliente |

---

## Vendas

### `pedido`
Cabeçalho do pedido. Persiste no Supabase antes de ir ao Sankhya.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `nunota` | `bigint` | YES | — | Número de nota no Sankhya (preenchido após integração) |
| `cliente_id` | `uuid` | YES | — | FK → `cliente.id` |
| `status` | `text` | YES | `'pendente'` | Status do pedido — ver valores possíveis abaixo |
| `vlr_total` | `numeric` | YES | `0` | Valor total do pedido (inclui frete) |
| `vlr_frete` | `numeric` | YES | `0` | Valor do frete |
| `peso_total` | `numeric` | YES | — | Peso total calculado |
| `dt_pedido` | `timestamptz` | YES | `now()` | Data/hora do pedido |
| `metodo_pagamento` | `text` | YES | — | `'pix'` / `'boleto'` / `'cartao'` / `'mercadopago'` |
| `log_erro_integracao` | `text` | YES | — | Último erro de integração com Sankhya (limpo após sucesso) |
| `mp_preference_id` | `text` | YES | — | ID da preferência no MercadoPago |
| `mp_payment_id` | `text` | YES | — | ID do pagamento confirmado no MercadoPago |
| `endereco_id` | `integer` | YES | — | FK → `endereco.id` — endereço de entrega selecionado |

**Valores possíveis de `pedido.status`:**

| Valor | Descrição |
|---|---|
| `pendente` | Pedido criado, aguardando pagamento |
| `pago` | Pagamento confirmado — elegível para `integrar-pedidos` |
| `integrado` | Enviado ao Sankhya com sucesso (`nunota` preenchido) |
| `cancelado` | Cancelado via rota `/integrar-pedidos/cancelar` |

---

### `pedido_item`
Itens do pedido.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `pedido_id` | `bigint` | YES | — | FK → `pedido.id` |
| `codprod` | `bigint` | YES | — | FK → `produto.codprod` |
| `quantidade` | `numeric` | NO | — | Quantidade negociada |
| `vlr_unitario` | `numeric` | NO | — | Valor unitário no momento do pedido |

---

## Carrinho

### `carrinho`
Itens adicionados ao carrinho antes da finalização do pedido.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `cliente_id` | `uuid` | YES | — | FK → `cliente.id` |
| `codprod` | `bigint` | YES | — | FK → `produto.codprod` |
| `quantidade` | `integer` | NO | `1` | Quantidade (CHECK > 0) |
| `criado_em` | `timestamptz` | YES | `now()` | Timestamp de criação |
| `atualizado_em` | `timestamptz` | YES | `now()` | Timestamp da última atualização |
| `peso_total` | `numeric` | YES | `0` | Peso total do item (kg): peso_unitário × quantidade |

---

## Embalagem

### `embalagem`
Produtos que funcionam como embalagens (caixas) no frete. Espelha TGFPRO para os produtos de embalagem.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codprod` | `bigint` | NO | — | PK — código do produto-embalagem no Sankhya |
| `descrprod` | `text` | NO | — | Descrição da embalagem |
| `peso` | `numeric` | YES | — | Peso da embalagem vazia em kg |
| `altura` | `numeric` | YES | — | Altura em cm |
| `largura` | `numeric` | YES | — | Largura em cm |
| `comprimento` | `numeric` | YES | — | Comprimento em cm |

---

### `pedido_embalagem`
Embalagens selecionadas por pedido (resultado do cálculo de frete/cubagem).

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `pedido_id` | `bigint` | NO | — | FK → `pedido.id` |
| `embalagem_codprod` | `bigint` | YES | — | FK → `embalagem.codprod` |
| `quantidade_caixas` | `integer` | NO | `1` | Número de caixas deste tipo |
| `peso_total` | `numeric` | NO | `0` | Peso total das caixas em kg |
| `cenario` | `text` | NO | — | `'unitario'` / `'padrao'` / `'catalogo'` |
| `criado_em` | `timestamptz` | NO | `now()` | Timestamp de criação |

---

## Auxiliares (sync-bairros)

### `cidade`
Cidades sincronizadas do Sankhya (TGFCID). Usada para resolver o `codigolbge` no payload de criação de parceiro.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codcid` | `bigint` | NO | — | PK — código interno Sankhya |
| `nomecid` | `text` | NO | — | Nome da cidade |
| `uf` | `varchar` | YES | — | CODUF numérico do Sankhya (ex: `'2'` = MG) — não é a sigla textual |
| `codibge` | `bigint` | YES | — | Código IBGE do município — campo obrigatório no payload `codigolbge` de `integrar-clientes` |

> **Nota:** `uf` armazena o código numérico do Sankhya, não a sigla UF. `codibge` é preenchido pela função `util-update-cidade-codibge`.

---

### `bairro`
Bairros sincronizados do Sankhya (TGFBAI).

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codbai` | `bigint` | NO | — | PK — código interno Sankhya |
| `nomebai` | `text` | NO | — | Nome do bairro |
| `codcid` | `bigint` | YES | — | FK → `cidade.codcid` — **sempre null** (CODCID não retorna via loadRecords nesta instância) |

> **Limitação:** `CODCID` não está disponível na entidade `Bairro` via loadRecords. Retorna erro `"Descritor do campo 'CODCID' inválido"`. A coluna `codcid` é sempre `null`.

---

## Parceiros (snapshot)

### `parceiro`
Snapshot local dos parceiros ativos do Sankhya (TGFPAR). Usado por `sync-parceiros` para consulta local de CPF sem depender da API do ERP em tempo real.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `codparc` | `integer` | NO | — | PK — código do parceiro no Sankhya |
| `cgc_cpf` | `text` | YES | — | CPF ou CNPJ do parceiro |

> **⚠️ Segurança:** RLS está **desabilitado** nesta tabela. Qualquer detentor da anon key pode ler ou modificar todos os registros. Habilitar RLS antes de expor ao frontend. SQL: `ALTER TABLE public.parceiro ENABLE ROW LEVEL SECURITY;`

---

## Externas

### `ext_product_images`
Gerenciamento de imagens de produtos vindas de fontes externas.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `product_code` | `text` | NO | — | Código externo do produto |
| `file_path` | `text` | NO | — | Caminho do arquivo no storage |
| `resolution_type` | `text` | YES | — | `'high'` / `'low'` / `'manual'` |
| `position` | `integer` | YES | `0` | Ordem de exibição |
| `public_url` | `text` | YES | — | URL pública da imagem |
| `created_at` | `timestamptz` | YES | `now()` | Timestamp de criação |
| `deleted_at` | `timestamptz` | YES | — | Soft delete |

---

### `ext_api_keys`
Chaves de API para autenticação de serviços externos.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | NO | — | FK → `auth.users.id` |
| `api_key` | `text` | NO | — | Chave de API (única) |
| `created_at` | `timestamptz` | YES | `now()` | Timestamp de criação |
| `last_used_at` | `timestamptz` | YES | — | Último uso da chave |

---

## Logs

### `log_sincronizacao`
Registro de cada execução das Edge Functions de sync.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `entidade` | `text` | NO | — | `'produto'` / `'categoria'` / `'estoque'` / `'preco'` / `'especificacao'` / `'cliente'` / `'pedido'` |
| `status` | `text` | NO | — | `'processando'` / `'sucesso'` / `'erro'` |
| `registros_processados` | `integer` | YES | `0` | Quantidade de registros com upsert |
| `mensagem_erro` | `text` | YES | — | Mensagem de erro (quando `status = 'erro'`) |
| `iniciado_em` | `timestamptz` | YES | `now()` | Timestamp de início |
| `finalizado_em` | `timestamptz` | YES | — | Timestamp de conclusão |

> **Padrão obrigatório:** toda Edge Function de sync deve inserir com `status='processando'` ao iniciar e atualizar para `'sucesso'` ou `'erro'` ao finalizar.

---

### `log_integracao_pedido`
Registro de cada tentativa de envio de pedido ao Sankhya.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `pedido_id` | `bigint` | YES | — | FK → `pedido.id` |
| `tentativa` | `integer` | YES | `1` | Número da tentativa |
| `status` | `text` | NO | — | Status da tentativa |
| `payload_enviado` | `jsonb` | YES | — | Corpo enviado ao Sankhya |
| `resposta_recebida` | `jsonb` | YES | — | Resposta recebida do Sankhya |
| `criado_em` | `timestamptz` | YES | `now()` | Timestamp da tentativa |
