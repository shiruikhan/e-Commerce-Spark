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
| `status` | `text` | YES | `'pendente'` | Status do pedido |
| `vlr_total` | `numeric` | YES | `0` | Valor total do pedido |
| `vlr_frete` | `numeric` | YES | `0` | Valor do frete |
| `peso_total` | `numeric` | YES | — | Peso total calculado |
| `dt_pedido` | `timestamptz` | YES | `now()` | Data/hora do pedido |
| `metodo_pagamento` | `text` | YES | — | Método de pagamento |
| `log_erro_integracao` | `text` | YES | — | Último erro de integração com Sankhya |

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

## Logs

### `log_sincronizacao`
Registro de cada execução das Edge Functions de sync.

| Coluna | Tipo | Nullable | Default | Descrição |
|---|---|---|---|---|
| `id` | `bigint` | NO | — | PK |
| `entidade` | `text` | NO | — | `'produto'` / `'categoria'` / `'estoque'` / `'preco'` |
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
