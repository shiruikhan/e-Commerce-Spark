# Mapeamento de Dados — Sankhya ↔ Supabase

## Convenções

| Símbolo | Significado |
|---|---|
| `→` | Campo Sankhya mapeado para campo Supabase |
| `(filtro)` | Campo usado como condição de filtro, não armazenado |
| `(gerado)` | Campo calculado ou gerado automaticamente |

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
| `client_secret` | `SANKHYA_CLIENT_SECRET` | Secret da aplicação no Portal do Desenvolvedor |
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
        "parameter": [{ "$": "valor", "type": "S" }]
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

### Tabela Supabase: `public.produto`

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODPROD` | `codprod` | `bigint` | Chave primária |
| `DESCRPROD` | `descrprod` | `text` | Nome técnico do produto |
| `AD_COMNOME` | `comnome` | `text` | Nome comercial (campo adicional) |
| `AD_DESCCURTA` | `desccurta` | `text` | Descrição curta para e-commerce (campo adicional) |
| `AD_DESCRPRODOED` | `descrprodoed` | `text` | Descrição longa para e-commerce (campo adicional) |
| `DTALTER` | `dtalter` | `timestamptz` | Data da última alteração — controle incremental |
| `PESOBRUTO` | `peso` | `numeric` | Peso bruto em kg |
| `ALTURA` | `altura` | `numeric` | Altura em cm |
| `LARGURA` | `largura` | `numeric` | Largura em cm |
| `ESPESSURA` | `comprimento` | `numeric` | Espessura/profundidade em cm |
| `AD_SYNCSITE` | — | — | `(filtro)` — só sincroniza se `= 'S'` |
| `CODGRUPOPROD` | `codgrupoprod` | `bigint` | FK para `categoria` — sincronizado separadamente |

### Lógica de sincronização incremental
1. Busca **todos** os produtos com `AD_SYNCSITE='S'` no Sankhya (sem filtro de data na query)
2. Carrega snapshot do Supabase: `codprod, dtalter, peso, altura, largura, comprimento`
3. Para cada produto retornado pelo Sankhya, faz upsert se **qualquer** critério for verdadeiro:
   - **Critério 1 — Produto novo:** `codprod` não existe no Supabase
   - **Critério 2 — Modificado no ERP:** `DTALTER` do Sankhya é mais recente que o `dtalter` do Supabase
   - **Critério 3 — Campo novo no sync:** algum campo mapeado está `null` no Supabase mas tem valor no Sankhya (garante que adições futuras de campos ao sincronizador preencham registros existentes sem re-sync manual)
4. Registra resultado em `log_sincronizacao`

> **Por que não filtrar por DTALTER no Sankhya?**
> Quando `AD_SYNCSITE` muda de `'N'` para `'S'`, o `DTALTER` do produto pode não ser atualizado.
> Filtrar no Sankhya faria com que esses produtos fossem ignorados na sincronização.

### Agendamento
- **Cron:** `0 * * * *` — toda hora no minuto 0
- **Edge Function:** `sync-produtos`

---

## 4. Entidade: Estoque *(planejado)*

### Tabela Supabase: `public.estoque`

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODPROD` | `codprod` | `bigint` | FK para `produto` |
| `ESTOQUE` (a confirmar) | `estoque_real` | `numeric` | Saldo real do estoque |
| — | `proporcao` | `numeric` | Fator de conversão de unidade (configurado no Supabase) |
| — | `estoque_disponivel` | `numeric` | `(gerado)` = `estoque_real * proporcao` |
| — | `dt_atualizacao` | `timestamptz` | `(gerado)` = `now()` |

**Endpoint Sankhya:** `GET /v1/estoque`

---

## 5. Entidade: Preço *(planejado)*

### Tabela Supabase: `public.preco`

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODPROD` | `codprod` | `bigint` | FK para `produto` |
| `VLRVENDA` (a confirmar) | `vlr_venda` | `numeric` | Preço de venda |
| `CODTAB` | `codtab` | `bigint` | Código da tabela de preço |
| — | `dtalter` | `timestamptz` | `(gerado)` = `now()` |

**Endpoint Sankhya:** `GET /v1/precos`

---

## 6. Entidade: Categoria

### Entidade Sankhya: `GrupoProduto` (tabela `TGFGRU`)

### Tabela Supabase: `public.categoria`

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODGRUPOPROD` | `codgrupoprod` | `bigint` | Chave primária |
| `DESCRGRUPOPROD` | `descr_grupo` | `text` | Descrição do grupo |
| `CODGRUPAI` | `codgrupopai` | `bigint` | FK self-referencing para grupo pai. `CODGRUPAI = 0` no Sankhya → `null` no Supabase (categoria raiz) |

### Lógica de sincronização incremental
1. Busca **todos** os grupos de produto no Sankhya (sem filtro — não há flag equivalente ao `AD_SYNCSITE`)
2. Carrega snapshot do Supabase: `codgrupoprod, descr_grupo, codgrupopai`
3. Para cada categoria retornada, faz upsert se **qualquer** critério for verdadeiro:
   - **Critério 1 — Categoria nova:** `codgrupoprod` não existe no Supabase
   - **Critério 2 — Descrição alterada:** `descr_grupo` difere entre Sankhya e Supabase
   - **Critério 3 — Hierarquia alterada:** `codgrupopai` difere (reestruturação de grupos)
4. Registra resultado em `log_sincronizacao`

### Agendamento
- **Cron:** `0 3 * * *` — diariamente às 03:00 (categorias mudam com menos frequência que produtos)
- **Edge Function:** `sync-categorias`

---

## 7. Entidade: Cliente *(planejado)*

### Tabela Supabase: `public.cliente`

| Campo Sankhya | Campo Supabase | Tipo | Observação |
|---|---|---|---|
| `CODPARC` | `codparc` | `bigint` | Chave única no Sankhya |
| `NOMEPARC` (a confirmar) | `nome` | `text` | Nome do parceiro |
| `CGC_CPF` (a confirmar) | `cpf_cnpj` | `text` | CPF ou CNPJ |
| `EMAIL` (a confirmar) | `email` | `text` | E-mail |
| `TELEFONE` (a confirmar) | `telefone` | `text` | Telefone |
| — | `id` | `uuid` | FK para `auth.users` — gerado no Supabase |

**Endpoints Sankhya:** `POST /v1/clientes` (criar) · `PUT /v1/clientes` (atualizar)

---

## 8. Entidade: Pedido *(planejado)*

### Tabela Supabase: `public.pedido` + `public.pedido_item`

| Campo Supabase | Campo Sankhya | Observação |
|---|---|---|
| `pedido.id` | — | ID interno do Supabase |
| `pedido.nunota` | `NUNOTA` | Preenchido após integração com Sankhya |
| `pedido.cliente_id` | — | UUID do cliente no Supabase |
| `pedido_item.codprod` | `CODPROD` | FK para produto |
| `pedido_item.quantidade` | `QTDNEG` (a confirmar) | Quantidade negociada |
| `pedido_item.vlr_unitario` | `VLRUNIT` (a confirmar) | Valor unitário |

**Endpoint Sankhya:** `loadRecords` na entidade `CabecalhoNota` (TGFCAB)

---

## 9. Secrets necessários

| Secret | Descrição | Onde configurar |
|---|---|---|
| `SANKHYA_AUTH_URL` | URL do endpoint de autenticação | Supabase Edge Function Secrets |
| `SANKHYA_CLIENT_ID` | ID da aplicação | Supabase Edge Function Secrets |
| `SANKHYA_CLIENT_SECRET` | Secret da aplicação | Supabase Edge Function Secrets |
| `SANKHYA_X_TOKEN` | Token JWT do gateway (Configurações Gateway no Sankhya Om) | Supabase Edge Function Secrets |
