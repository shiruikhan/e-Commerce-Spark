# Sprint — Implantação de `integrar-pedidos`

**Status:** Código implantado — aguardando testes em homologação e aplicação das migrations  
**Função alvo:** `supabase/functions/integrar-pedidos/index.ts`  
**Endpoint Sankhya:** `POST /v1/vendas/pedidos`

> **Atualização 26/05/2026:** Toda a Fase 2 (desenvolvimento) está concluída. O código em `index.ts` reflete o payload confirmado. Pendente: aplicar as migrations `20260526000001` e `20260526000002`, executar os testes da Fase 3 e ativar o cron (Fase 4).

---

## 1. Objetivo

Corrigir e validar a Edge Function `integrar-pedidos` para que o envio de pedidos ao Sankhya funcione em produção. A função foi corrigida com todos os campos obrigatórios do payload e está pronta para teste em homologação.

---

## 2. Campos Confirmados — Estado Atual vs. Correto

Comparação entre o payload atual enviado e o contrato confirmado com o Sankhya:

### 2.1 Campos ausentes em `itens` — **bloqueantes** (todos confirmados)

| Campo | Tipo | Situação atual | Valor correto | Origem |
|---|---|---|---|---|
| `sequencia` | `integer` | **Ausente** | Sequencial 1-based por pedido | Coluna `sequencia` em `pedido_item` (ver 2.2) |
| `codigoLocalEstoque` | `integer` | **Ausente** | `109` fixo | Constante — mesmo CODLOCAL do `sync-estoque` |
| `controle` | `string` | **Ausente** | `" "` (espaço) fixo | Campo interno Sankhya ligado a operação de conferência; todos os produtos do catálogo = espaço |

**Payload atual de cada item:**
```json
{
  "codigoProduto": 313407,
  "quantidade": 2,
  "valorUnitario": 199.90
}
```

**Payload correto (confirmado):**
```json
{
  "sequencia": 1,
  "codigoProduto": 313407,
  "quantidade": 2,
  "valorUnitario": 199.90,
  "codigoLocalEstoque": 109,
  "controle": " "
}
```

---

### 2.2 `sequencia` — armazenamento no banco

`sequencia` deve ser persistido na tabela `pedido_item` (não gerado apenas em memória no payload). Justificativas:

- **Lastro de log:** `log_integracao_pedido` registra o payload enviado; a sequência armazenada permite reconstruir exatamente o que foi enviado ao Sankhya por pedido.
- **Retorno de status:** em caso de erro ou reprocessamento, a sequência salva permite identificar qual item falhou sem recalcular.
- **Auditoria:** a TGFITE do Sankhya armazena a `SEQUENCIA`; ter o mesmo valor localmente facilita cruzamento de dados.

**Migration necessária:**
```sql
ALTER TABLE pedido_item ADD COLUMN sequencia integer;
```

A coluna será preenchida no momento da criação do pedido (frontend/checkout), garantindo que o valor persistido seja exatamente o enviado ao Sankhya.

> **Alternativa descartada:** gerar `idx + 1` apenas no map do payload — não deixa rastro e dificulta diagnóstico em erros por item.

---

### 2.3 Campo `controle` — decisão final

- **Valor:** `" "` (um espaço em branco) para todos os produtos.
- **Razão:** o campo `controle` no Sankhya está atrelado a uma operação interna de conferência de estoque. Nenhum produto do catálogo e-commerce usa controle adicional (cor, voltagem, tamanho etc.).
- **Implementação:** constante `CONTROLE_ITEM = ' '` no código — não buscar da tabela `produto`.

---

### 2.4 Campo `codigoCliente` — confirmado

Campo já presente no código. Deve conter o `codparc` do parceiro previamente sincronizado via `integrar-clientes`. Nenhuma alteração necessária na lógica — apenas garantir que a query principal já exclua pedidos sem `codparc` (ver seção 7.3).

---

### 2.5 Campo `notaModelo` — **valor corrigido**

| Campo | Valor anterior (incorreto) | Valor correto (confirmado) |
|---|---|---|
| `notaModelo` | `1006` | `793370` |

O campo `notaModelo` é o código do **Modelo de Nota** configurado no Sankhya Om (não é código de TOP/Tipo de Operação). O modelo pré-define automaticamente empresa (`CODEMP`), TOP, CFOP e natureza da operação. Por isso:

- `codigoEmpresa: 2` no payload raiz é **redundante e deve ser removido** — a empresa já é definida pelo modelo.
- O valor `1006` era uma suposição incorreta; o valor confirmado é `793370`.

---

### 2.6 Campos a ajustar no payload raiz

| Campo | Situação atual | Decisão |
|---|---|---|
| `codigoEmpresa` | Enviado como `2` | **Remover** — empresa já definida pelo `notaModelo` |
| `financeiros` | Enviado (estrutura incorreta) | **Corrigir** — estrutura confirmada na seção 5; `codTipVenda` substituído por `tipoPagamento` (CODTIPTIT) |

---

## 3. Payload Completo Confirmado (Pós-Sprint)

```json
{
  "notaModelo": 793370,
  "data": "25/05/2026",
  "hora": "14:30:00",
  "codigoVendedor": 6,
  "codigoCliente": 8115,
  "valorTotal": 399.80,
  "valorFrete": 35.00,
  "itens": [
    {
      "sequencia": 1,
      "codigoProduto": 313407,
      "quantidade": 2,
      "valorUnitario": 182.40,
      "codigoLocalEstoque": 109,
      "controle": " "
    },
    {
      "sequencia": 2,
      "codigoProduto": 315200,
      "quantidade": 1,
      "valorUnitario": 35.00,
      "codigoLocalEstoque": 109,
      "controle": " "
    }
  ],
  "financeiros": [
    {
      "sequencia": 1,
      "tipoPagamento": 53,
      "dataVencimento": "25/05/2026",
      "valorParcela": 399.80,
      "idTransacao": "Pedido #1042 no e-commerce"
    }
  ]
}
```

> `codigoEmpresa` omitido — empresa definida pelo `notaModelo`. `financeiros` sempre com 1 parcela, `tipoPagamento: 53` fixo para todos os métodos de pagamento.

---

## 4. Constantes Fixas do Projeto (confirmadas)

| Constante | Valor | Descrição |
|---|---|---|
| `NOTA_MODELO` | `793370` | Código do Modelo de Nota no Sankhya Om — pré-define CODEMP, TOP, CFOP |
| `CODIGO_VENDEDOR` | `6` | Vendedor padrão para todos os pedidos do site |
| `CODIGO_LOCAL_ESTOQUE` | `109` | CODLOCAL do estoque físico — mesmo do `sync-estoque` |
| `CONTROLE_ITEM` | `' '` | Campo interno Sankhya; espaço fixo para todos os produtos |

---

## 5. Campo `financeiros` — **Obrigatório** (documentação oficial incorporada)

`financeiros` é um **array de objetos required**. Deve conter todos os dados financeiros da transação. Para cartão parcelado, enviar cada parcela como um objeto separado (sequência crescente). Para pagamento único (PIX, boleto, cartão à vista), enviar um único objeto com `sequencia: 1`.

### 5.1 Estrutura de cada objeto

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `sequencia` | integer | **sim** | Número da parcela financeira, começando em 1 |
| `tipoPagamento` | integer | **sim** | `CODTIPTIT` da entidade `TipoTitulo` no Sankhya — ver 5.2 |
| `dataVencimento` | string | **sim** | Data de vencimento no formato `DD/MM/AAAA` — ver 5.3 |
| `valorParcela` | number | **sim** | Valor total da parcela |
| `dataBaixa` | string | não | Data de baixa (`DD/MM/AAAA`). Omitir se não baixado |
| `idTransacao` | string | não | ID/protocolo da transação (ex: protocolo PIX) |
| `cheque` | object | não | Enviar **apenas** quando `tipoPagamento` = tipo Cheque (`02`) |
| `cartao` | object | não | Dados do cartão — ver documentação Sankhya se necessário |

**Exemplo de objeto único (pagamento à vista):**
```json
{
  "sequencia": 1,
  "tipoPagamento": 19,
  "dataVencimento": "25/05/2026",
  "valorParcela": 399.80,
  "idTransacao": "protocolo-pix-aqui"
}
```

### 5.2 Valores fixos confirmados

| Campo | Valor | Razão |
|---|---|---|
| `sequencia` | `1` sempre | Parcelamentos de cartão são intermediados por terceiro; o recebimento da SPARK é sempre único |
| `tipoPagamento` | `53` sempre | `CODTIPTIT` confirmado — único tipo de título para todos os métodos de pagamento do e-commerce |
| `dataVencimento` | `dt_pedido` (formatado `DD/MM/AAAA`) | Mesma data do pedido em todos os casos (PIX, cartão, boleto) |
| `dataBaixa` | omitido | Sankhya realiza baixa conforme configuração do tipo de título |
| `idTransacao` | `"Pedido #<id> no e-commerce"` | Identificação fixa do pedido — não depende de protocolo externo |

> O mapeamento anterior por método de pagamento (`codTipVenda: 140/86/87`) era incorreto. `financeiros` não varia por método — todos os campos são fixos ou derivados do pedido.

### 5.3 Payload `financeiros` — único para todos os métodos

```json
"financeiros": [
  {
    "sequencia": 1,
    "tipoPagamento": 53,
    "dataVencimento": "25/05/2026",
    "valorParcela": 399.80,
    "idTransacao": "Pedido #1042 no e-commerce"
  }
]
```

---

## 6. Estrutura da Tabela `pedido_item` — Alteração necessária

A coluna `sequencia` deve ser adicionada à tabela `pedido_item`.

**Estado atual da query de itens:**
```typescript
const { data: itens } = await supabase
  .from('pedido_item')
  .select('codprod, quantidade, vlr_unitario')
  .eq('pedido_id', pedido.id);
```

**Após migration:**
```typescript
const { data: itens } = await supabase
  .from('pedido_item')
  .select('codprod, quantidade, vlr_unitario, sequencia')
  .eq('pedido_id', pedido.id)
  .order('sequencia');
```

`controle` não precisa vir do banco — é constante `CONTROLE_ITEM = ' '` no código.

---

## 7. Dependência de Cron — `integrar-clientes` antes de `integrar-pedidos`

### 7.1 Regra de sequência

`integrar-pedidos` **só pode disparar após** `integrar-clientes` ter concluído seu ciclo. A razão é que `integrar-pedidos` depende de `cliente.codparc` que é preenchido por `integrar-clientes`. Se ambas as crons rodarem ao mesmo tempo ou `integrar-pedidos` rodar antes, pedidos de clientes recém-cadastrados serão ignorados desnecessariamente no ciclo corrente.

### 7.2 Schedule planejado

| Job | Schedule atual | Schedule planejado | Razão |
|---|---|---|---|
| `integrar-clientes-30min` | `*/30 * * * *` | `*/30 * * * *` (mantido) | Dispara em :00 e :30 |
| `integrar-pedidos-30min` | sem cron | `5,35 * * * *` | Dispara 5 min depois: :05 e :35 |

Com essa defasagem de 5 minutos, `integrar-clientes` termina (tipicamente em < 2 min) antes de `integrar-pedidos` iniciar, garantindo que os `codparc` atribuídos naquele ciclo já estejam disponíveis.

### 7.3 Validação de `codparc` na query — mudança obrigatória no código

A implementação atual busca **todos** os pedidos com `status='pago'` e `nunota IS NULL`, e só descobre que o cliente não tem `codparc` depois de uma query extra por pedido. A correção é filtrar na query principal via `!inner` join:

**Query atual:**
```typescript
const { data: pedidosRaw } = await supabase
  .from('pedido')
  .select('id, cliente_id, vlr_total, vlr_frete, dt_pedido, metodo_pagamento')
  .eq('status', 'pago')
  .is('nunota', null);
```

**Query corrigida:**
```typescript
// !inner exclui pedidos cujo cliente não tem codparc — codparc vem direto do JOIN
const { data: pedidosRaw } = await supabase
  .from('pedido')
  .select('id, cliente_id, vlr_total, vlr_frete, dt_pedido, metodo_pagamento, cliente!inner(codparc)')
  .eq('status', 'pago')
  .is('nunota', null)
  .not('cliente.codparc', 'is', null);
```

Com essa query, pedidos de clientes sem `codparc` nunca entram no loop. O `codparc` resolvido pelo JOIN é lido diretamente do objeto — elimina 1 query Supabase por pedido em `processarPedido`.

> **Impacto:** `processarPedido` deve receber `codparc` como parâmetro (já resolvido) ao invés de buscá-lo internamente.

---

## 8. Checklist de Implantação

### Fase 1 — Preparação (antes de codar)

- [x] Confirmar o código do Modelo de Nota → **`793370`** (confirmado)
- [x] Confirmar `CODLOCAL` do estoque de saída → **`109`** (confirmado)
- [x] Confirmar valor de `controle` para produtos sem controle → **`" "` fixo** (confirmado)
- [x] Confirmar que `codigoEmpresa` deve ser removido → **sim, redundante com `notaModelo`** (confirmado)
- [x] Receber e analisar documentação do campo `financeiros` → **obrigatório**, estrutura incorporada na seção 5
- [x] Confirmar `CODTIPTIT` → **`53`** fixo para todos os métodos (confirmado)

### Fase 2 — Desenvolvimento (após Fase 1 completa)

- [x] Migration: adicionar coluna `sequencia integer` em `pedido_item` — arquivo `20260526000001_add_sequencia_pedido_item.sql` criado (⚠️ ainda não aplicado ao banco)
- [x] Corrigir query principal: `!inner` join com `cliente`, filtrar `codparc IS NOT NULL`
- [x] Refatorar `processarPedido` para receber `codparc` como parâmetro
- [x] Atualizar constante `NOTA_MODELO` de `1006` para `793370`
- [x] Adicionar constante `CODIGO_LOCAL_ESTOQUE = 109`
- [x] Adicionar constante `CONTROLE_ITEM = ' '`
- [x] Remover constante `CODIGO_EMPRESA` e campo `codigoEmpresa` do payload
- [x] Atualizar mapa de `itens`: adicionar `sequencia`, `codigoLocalEstoque`, `controle`
- [x] Atualizar query de `pedido_item`: incluir `sequencia`, ordenar por `sequencia`
- [x] Implementar `financeiros`: `sequencia: 1`, `tipoPagamento: 53`, `dataVencimento: formatarData(dt_pedido)`, `valorParcela: vlr_total`, `idTransacao: "Pedido #<id> no e-commerce"`
- [x] Atualizar `buildPayloadLog` para refletir o payload corrigido
- [x] Corrigir comentário de `NOTA_MODELO` (agora descrito como "Código do Modelo de Nota no Sankhya Om")

### Fase 3 — Teste em ambiente de homologação

- [ ] Criar 1 pedido de teste com 1 item, método PIX, cliente com `codparc` já definido
- [ ] Verificar response: presença de `codigoNota` / `nunota` / `codigoPedido`
- [ ] Verificar no Sankhya Om que o pedido foi criado na TGFCAB + TGFITE com dados corretos
- [ ] Testar pedido com 2+ itens — verificar `sequencia` incremental e registrada no banco
- [ ] Testar pedido com `valorFrete > 0`
- [ ] Testar que pedidos de clientes **sem** `codparc` não entram no loop (verificar log)
- [ ] Testar rota de cancelamento: `POST /integrar-pedidos/cancelar` com `pedido_id`
- [ ] Verificar registro em `log_integracao_pedido` (payload + resposta)

### Fase 4 — Ativação do cron

- [x] Criar migration para o cron `integrar-pedidos-30min` com schedule `5,35 * * * *` — arquivo `20260526000002_cron_integrar_pedidos.sql` criado (⚠️ ainda não aplicado ao banco)
- [x] Atualizar `PROJECT_OVERVIEW.md`: `integrar-pedidos` de "Manual" para "pg_cron (`5,35 * * * *`)"
- [x] Atualizar tabela de agendamento no `MAPPING.md` seção 9

---

## 9. Alterações de Código — Diff Esperado

### Constantes

```typescript
// Antes:
const NOTA_MODELO     = 1006;  // TOP do e-commerce no Sankhya  ← errado
const CODIGO_VENDEDOR = 6;
const CODIGO_EMPRESA  = 2;     // ← remover

// Depois:
const NOTA_MODELO           = 793370; // Código do Modelo de Nota no Sankhya Om
const CODIGO_VENDEDOR       = 6;
const CODIGO_LOCAL_ESTOQUE  = 109;    // CODLOCAL do estoque de saída
const CONTROLE_ITEM         = ' ';    // Campo interno Sankhya; fixo para todos os produtos
const TIPO_PAGAMENTO        = 53;     // CODTIPTIT fixo — recebimento único via intermediário
```

### `criarPedidoSankhya` — payload raiz e mapa de itens

```typescript
// Remover do payload raiz:
codigoEmpresa: CODIGO_EMPRESA,  // redundante — empresa definida pelo notaModelo

// Atualizar mapa de itens:
itens: itens.map(item => ({
  sequencia:          item.sequencia,
  codigoProduto:      item.codprod,
  quantidade:         Number(item.quantidade),
  valorUnitario:      Number(item.vlr_unitario),
  codigoLocalEstoque: CODIGO_LOCAL_ESTOQUE,
  controle:           CONTROLE_ITEM,
})),

// Substituir financeiros (estrutura anterior usava codTipVenda — incorreto):
financeiros: [{
  sequencia:       1,
  tipoPagamento:   TIPO_PAGAMENTO,
  dataVencimento:  formatarData(pedido.dt_pedido),
  valorParcela:    Number(pedido.vlr_total),
  idTransacao:     `Pedido #${pedido.id} no e-commerce`,
}],
```

### Query principal — filtro de `codparc`

```typescript
const { data: pedidosRaw } = await supabase
  .from('pedido')
  .select('id, cliente_id, vlr_total, vlr_frete, dt_pedido, metodo_pagamento, cliente!inner(codparc)')
  .eq('status', 'pago')
  .is('nunota', null)
  .not('cliente.codparc', 'is', null);

// codparc lido direto: pedido.cliente.codparc
// processarPedido recebe codparc como parâmetro — não rebusca internamente
```

### Query de itens — incluir `sequencia`

```typescript
const { data: itens } = await supabase
  .from('pedido_item')
  .select('codprod, quantidade, vlr_unitario, sequencia')
  .eq('pedido_id', pedido.id)
  .order('sequencia');
```

---

## 10. Referências

- Implementação atual: [`supabase/functions/integrar-pedidos/index.ts`](../supabase/functions/integrar-pedidos/index.ts)
- Mapeamento de campos: [`docs/MAPPING.md`](MAPPING.md) — seção 8
- Schema do banco: [`docs/DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md) — tabelas `pedido`, `pedido_item`
- Constantes de estoque: `CODEMP=1`, `CODLOCAL=109` (confirmados em [`sync-estoque`](../supabase/functions/sync-estoque/index.ts))
- Documentação oficial Sankhya: `POST /v1/vendas/pedidos` — screenshots capturadas em 25/05/2026
