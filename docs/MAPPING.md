# Mapeamento de Dados — Sankhya ↔ Supabase

## Convenções

| Símbolo | Significado |
|---|---|
| `→` | Campo Sankhya mapeado para campo Supabase |
| `(filtro)` | Campo usado como condição de filtro, não armazenado |
| `(gerado)` | Campo calculado ou gerado automaticamente pelo banco |
| `(manual)` | Campo gerenciado manualmente no Supabase, não sobrescrito pelo sync |

---

## 1. Autenticação

### Endpoint
- **URL:** `{SANKHYA_AUTH_URL}` (ex: `https://api.sankhya.com.br/authenticate`)
- **Método:** `POST`
- **Content-Type:** `application/x-www-form-urlencoded`

### Headers obrigatórios
| Header | Secret | Descrição |
|---|---|---|
| `X-Token` | `SANKHYA_X_TOKEN` | Token JWT obtido em *Configurações Gateway* no Sankhya Om |

### Body obrigatório
| Parâmetro | Secret | Descrição |
|---|---|---|
| `client_id` | `SANKHYA_CLIENT_ID` | ID da aplicação no Portal do Desenvolvedor |
| `client_secret` | `SANKHYA_CLIENT_SECRET` | Secret da aplicação |
| `grant_type` | — | Literal `client_credentials` |

### Resposta
```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 300
}
```
> Token expira em **300 segundos**. Renovar a cada execução (sem cache em banco).

---

## 2. Endpoint de Consulta Genérica (loadRecords)

Usado por `sync-categorias`, `sync-estoque`, `sync-precos` e `sync-produtos`.

- **URL:** `{BASE}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json`
- **Método:** `POST`
- **Authorization:** `Bearer {access_token}`

### Estrutura do body
```json
{
  "serviceName": "CRUDServiceProvider.loadRecords",
  "requestBody": {
    "dataSet": {
      "rootEntity": "<entidade>",
      "ignoreCalculatedFields": "true",
      "offsetPage": "0",
      "criteria": {
        "expression": { "$": "CAMPO = ?" },
        "parameter": [{ "$": "valor", "type": "I" }]
      },
      "entity": [{
        "path": "",
        "fieldset": { "list": "CAMPO1,CAMPO2,..." }
      }]
    }
  }
}
```

### Tipos de parâmetro (`type`)
| Tipo | Formato |
|---|---|
| `S` | Texto |
| `I` | Inteiro |
| `F` | Decimal |
| `D` | Data sem hora |
| `H` | Data com hora — formato `DD/MM/AAAA HH:MM:SS` |

### Formato da resposta
```json
{
  "status": "1",
  "responseBody": {
    "entities": {
      "total": "50",
      "hasMoreResult": "true",
      "offsetPage": "0",
      "metadata": {
        "fields": { "field": [{"name": "CODPROD"}, ...] }
      },
      "entity": [
        { "f0": {"$": "123"}, "f1": {"$": "Nome"}, ... }
      ]
    }
  }
}
```

> **Atenção:** Os campos são retornados **posicionalmente** (`f0`, `f1`, `f2`...).
> O mapeamento nome → posição está em `metadata.fields.field`.
> Campos sem valor retornam `{}` (objeto vazio), não `null`.

### Paginação
- `offsetPage` começa em `0` e incrementa a cada página
- `hasMoreResult: "true"` indica que há mais páginas
- Tamanho da página: **50 registros** (padrão Sankhya)

### Formato de datas
- Sankhya retorna datas no formato **brasileiro**: `DD/MM/AAAA HH:MM:SS`
- Fuso horário: **UTC-3** (Horário de Brasília)
- Supabase armazena em **ISO 8601**: `YYYY-MM-DDTHH:MM:SS-03:00`

---

## 3. Entidade: Produto

### Tabela Sankhya: `TGFPRO` | rootEntity: `Produto`
### Tabela Supabase: `public.produto`
### Edge Function: `sync-produtos` | Cron: `0 * * * *` (todo hora)

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODPROD` | `codprod` | `bigint` | Chave primária |
| `DESCRPROD` | `descrprod` | `text` | Nome técnico do produto |
| `AD_COMNOME` | `comnome` | `text` | Nome comercial |
| `AD_DESCCURTA` | `desccurta` | `text` | Descrição curta para e-commerce |
| `AD_DESCRPRODOED` | `descrprodoed` | `text` | Descrição longa para e-commerce |
| `DTALTER` | `dtalter` | `timestamptz` | Data da última alteração — controle incremental |
| `PESOBRUTO` | `peso` | `numeric` | Peso bruto em kg |
| `ALTURA` | `altura` | `numeric` | Altura em cm |
| `LARGURA` | `largura` | `numeric` | Largura em cm |
| `ESPESSURA` | `comprimento` | `numeric` | Comprimento/profundidade em cm |
| `AD_SYNCSITE` | — | — | `(filtro)` — só sincroniza se `= 'S'` |
| `CODGRUPOPROD` | `codgrupoprod` | `bigint` | FK para `categoria` |

### Lógica incremental
1. Busca todos os produtos com `AD_SYNCSITE='S'` (sem filtro de data na query)
2. Snapshot do Supabase: `codprod, dtalter, peso, altura, largura, comprimento`
3. Upsert se qualquer critério for verdadeiro:
   - Produto novo (codprod não existe no Supabase)
   - `DTALTER` do Sankhya mais recente que `dtalter` do Supabase
   - Algum campo mapeado está `null` no Supabase mas tem valor no Sankhya

> **Por que não filtrar por DTALTER no Sankhya?**
> Quando `AD_SYNCSITE` muda de `'N'` para `'S'`, o `DTALTER` do produto pode não ser atualizado. Filtrar no Sankhya faria com que esses produtos fossem ignorados.

---

## 4. Entidade: Categoria

### Tabela Sankhya: `TGFGRU` | rootEntity: `GrupoProduto`
### Tabela Supabase: `public.categoria`
### Edge Function: `sync-categorias` | Cron: `0 3 * * *` (diário às 03h)

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODGRUPOPROD` | `codgrupoprod` | `bigint` | Chave primária |
| `DESCRGRUPOPROD` | `descr_grupo` | `text` | Descrição do grupo |
| `CODGRUPAI` | `codgrupopai` | `bigint` | FK self-referencing. `CODGRUPAI ≤ 0` no Sankhya → `null` (raiz) |

### Lógica incremental
1. Busca todos os grupos sem filtro (não há equivalente ao `AD_SYNCSITE`)
2. Snapshot do Supabase: `codgrupoprod, descr_grupo, codgrupopai`
3. Upsert se: categoria nova, `descr_grupo` alterada, ou `codgrupopai` alterado
4. **Ordenação topológica:** upsert em batches (pais antes de filhos) para respeitar a FK self-referencing
5. Categorias órfãs (pai não encontrado) são salvas com `codgrupopai = null`

> **Atenção:** O campo no Sankhya se chama `CODGRUPAI` (não `CODGRUPOPAI`). Valores `0` ou negativos (ex: `-999999999`) indicam categoria raiz.

---

## 5. Entidade: Estoque

### Tabela Sankhya: `TGFEST` | rootEntity: `Estoque`
### Tabela Supabase: `public.estoque`
### Edge Function: `sync-estoque` | Cron: `*/30 * * * *` (a cada 30 min)

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODPROD` | `codprod` | `bigint` | PK / FK para `produto` |
| `ESTOQUE` | `estoque_real` | `numeric` | Saldo real do estoque |
| — | `proporcao` | `numeric` | `(manual)` Fator de conversão — nunca sobrescrito pelo sync |
| — | `estoque_disponivel` | `numeric` | `(gerado)` = `estoque_real * proporcao` — nunca incluir no upsert |
| — | `dt_atualizacao` | `timestamptz` | `(gerado)` = `now()` |

### Filtros da query
- `CODEMP = 1` (empresa)
- `CODLOCAL = 109` (local de estoque)

### Lógica de zero-stock
O Sankhya **remove** a linha da TGFEST quando o estoque chega a zero. Para detectar isso:
1. Coleta todas as páginas do Sankhya
2. Compara com snapshot do Supabase
3. Produtos no Supabase com `estoque_real > 0` que **sumiram** da TGFEST → zerados (`estoque_real = 0`)

> **Atenção:** `estoque_disponivel` é `GENERATED ALWAYS AS` no PostgreSQL. Nunca incluir no payload do upsert — causará erro.

---

## 6. Entidade: Preço

### Tabelas Sankhya: `TGFTAB` (cabeçalho) + `TGFEXC` (itens) — via REST API
### Tabela Supabase: `public.preco`
### Edge Function: `sync-precos` | Cron: `0 1 * * *` (diário às 01h)

> **⚠️ Correção de documentação (07/04/2026):** A tabela `TGFPRC` (`rootEntity: PrecoProduto`) **não** é a fonte correta de preços nesta instalação. A estrutura correta é `TGFTAB` (cabeçalho da tabela de preços) ligada à `TGFEXC` (itens/exceções) via `NUTAB`. O acesso é feito via **REST API por produto**, que abstrai essa estrutura internamente.

### Endpoint utilizado
```
GET {BASE}/v1/precos/produto/{codigoProduto}/tabela/{codigoTabela}?pagina=1
Authorization: Bearer {access_token}
```

| Parâmetro | Valor | Origem |
|---|---|---|
| `codigoProduto` | `codprod` do produto | Entidade `Produto` (CODPROD) |
| `codigoTabela` | `201` | Entidade `TabelaPreco` (COTAB / TGFTAB) |
| `pagina` | base-1 (começa em 1) | — |

### Estrutura do Response
```json
{
  "codigo": "200",
  "pagina": 1,
  "numeroRegistros": 1,
  "temMaisRegistros": false,
  "produtos": [
    {
      "codigoProduto": 313407,
      "codigoLocalEstoque": 0,
      "controle": " ",
      "unidade": "UN",
      "valor": 1999
    }
  ]
}
```

### Mapeamento de campos

| Campo Response | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `codigoProduto` | `codprod` | `bigint` | FK para `produto` |
| `valor` | `vlr_venda` | `numeric` | Preço de venda |
| — (constante 201) | `codtab` | `bigint` | Código da tabela de preços |
| — | `dtalter` | `timestamptz` | Timestamp da atualização pelo sync |

### Filtros e lógica
- Chamada individual por produto (1 request por produto)
- Apenas produtos presentes na tabela `produto` (com `AD_SYNCSITE='S'`)
- Prioriza registro com `codigoLocalEstoque = 0` (preço base); fallback para o primeiro registro
- Upsert com `onConflict: 'codprod,codtab'`
- Atualiza apenas se `vlr_venda` mudou ou produto é novo

### Estratégia de execução
- Lotes de 10 produtos em paralelo (`Promise.allSettled`)
- 82 produtos ÷ 10 por lote ≈ 9 lotes × ~3s = ~27s total (bem dentro do limite de 150s)
- Guard de deadline em 130s para encerramento gracioso
- Timeout de 15s por chamada HTTP individual

> **Nota:** A REST API retorna até 50 registros por página por produto. Registros adicionais representam variantes de preço (por local de estoque ou controle). Para e-commerce, apenas o registro com `codigoLocalEstoque=0` é utilizado.

---

## 7. Entidade: Cliente

### Tabela Sankhya: `TGFPAR` (parceiros) — via REST API
### Tabela Supabase: `public.cliente` + `public.endereco`
### Edge Function: `integrar-clientes` | Cron: a definir (sugestão: `*/30 * * * *`)

> **Direção:** Supabase → Sankhya (outbound). Diferente das outras entidades que são leitura do ERP, clientes são **enviados** ao Sankhya após uma compra.

### Endpoints utilizados

| Método | Endpoint | Finalidade |
|---|---|---|
| `POST` | `/v1/parceiros/clientes` | Cria novo parceiro na TGFPAR |
| `loadRecords` | rootEntity: `Parceiro` (TGFPAR) | Verifica se CPF já existe antes de criar |

### Critérios de elegibilidade (obrigatório tudo)
- `codparc IS NULL` — ainda não integrado ao Sankhya
- CPF com 11 dígitos (somente Pessoa Física)
- Pelo menos 1 pedido na tabela `pedido`

### Mapeamento Supabase → Sankhya (POST body)

```json
{
  "contatos": [{
    "tipo":           "PF",
    "cnpjCpf":        "cliente.cpf_cnpj (só dígitos)",
    "nome":           "cliente.nome",
    "email":          "cliente.email",
    "telefoneDdd":    "cliente.telefone (2 primeiros dígitos)",
    "telefoneNumero": "cliente.telefone (demais dígitos)",
    "endereco": {
      "cep":         "endereco.cep (só dígitos)",
      "logradouro":  "endereco.logradouro",
      "numero":      "endereco.numero",
      "complemento": "endereco.complemento",
      "bairro":      "endereco.bairro",
      "cidade":      "endereco.cidade",
      "uf":          "endereco.uf"
    }
  }]
}
```

### Response do POST e atualização do Supabase

| Campo Response | Campo Supabase | Observação |
|---|---|---|
| `codigoCliente` | `cliente.codparc` | CODPARC gerado pelo Sankhya — salvo após criação |

### Verificação de duplicata (loadRecords antes do POST)

Antes de criar, a função consulta TGFPAR filtrando por `CGC_CPF` (com e sem máscara). Se já existir:
- Ação: `reconciliado` — apenas salva o CODPARC existente no Supabase, sem criar novo parceiro

### Fluxo completo por cliente

```
1. Busca clientes elegíveis (PF + sem codparc + com pedido)
2. Para cada cliente (lotes de 5 em paralelo):
   a. loadRecords TGFPAR → busca por CPF
   b. Se encontrado → reconcilia codparc no Supabase
   c. Se não encontrado → POST /v1/parceiros/clientes → salva codigoCliente
3. Loga resultado em log_sincronizacao (entidade='cliente')
```

### Referência ao script anterior (TGSPAR.py)
O script Python anterior (`TGSPAR.py`) enviava dados para uma tabela intermediária `AD_TGSPAR` via `DatasetSP.save`. A nova implementação envia **diretamente para TGFPAR** via REST API, sem tabela intermediária, com verificação de duplicata por CPF e retorno do CODPARC gerado.

---

## 8. Entidade: Pedido *(planejado)*

### Tabelas Supabase: `public.pedido` + `public.pedido_item`

| Campo Supabase | Campo Sankhya | Observação |
|---|---|---|
| `pedido.id` | — | ID interno do Supabase |
| `pedido.nunota` | `NUNOTA` | Preenchido após integração com Sankhya |
| `pedido.cliente_id` | — | UUID do cliente no Supabase |
| `pedido_item.codprod` | `CODPROD` | FK para produto |
| `pedido_item.quantidade` | `QTDNEG` | Quantidade negociada |
| `pedido_item.vlr_unitario` | `VLRUNIT` | Valor unitário |

**Endpoint Sankhya:** `loadRecords` na entidade `CabecalhoNota` (TGFCAB)

---

## 9. Secrets necessários

| Secret | Descrição | Onde configurar |
|---|---|---|
| `SANKHYA_AUTH_URL` | URL do endpoint de autenticação | Supabase Edge Function Secrets |
| `SANKHYA_CLIENT_ID` | ID da aplicação | Supabase Edge Function Secrets |
| `SANKHYA_CLIENT_SECRET` | Secret da aplicação | Supabase Edge Function Secrets |
| `SANKHYA_X_TOKEN` | Token JWT do gateway (Configurações Gateway no Sankhya Om) | Supabase Edge Function Secrets |
