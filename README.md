# e-Commerce Spark — Middleware de Integração

Middleware de integração entre o e-commerce (React) e o ERP **Sankhya**, usando **Supabase** como núcleo de backend e processamento.

---

## Visão Geral

O sistema mantém o catálogo do e-commerce sincronizado com o Sankhya e orquestra o fluxo de pedidos entre as duas plataformas.

```
┌─────────────┐        ┌──────────────────────┐        ┌─────────────┐
│  Sankhya    │◄──────►│  Supabase (Backend)  │◄──────►│  React      │
│  (ERP)      │  sync  │  PostgreSQL           │  API   │  (Frontend) │
│             │        │  Edge Functions       │        │             │
└─────────────┘        │  Supabase Auth        │        └─────────────┘
                       │  pg_cron              │
                       └──────────────────────┘
```

### Fluxo de Entrada (Sankhya → Supabase) — via pg_cron + Edge Functions
Produtos, categorias, estoque e preços são sincronizados periodicamente do Sankhya para o Supabase. **As Edge Functions são estritamente leitura no Sankhya — nenhum dado é escrito de volta ao ERP.**

### Fluxo de Saída (E-commerce → Supabase → Sankhya)
Clientes e pedidos criados no e-commerce são integrados ao Sankhya via Edge Functions. `integrar-clientes` reconcilia/cria parceiros (TGFPAR) e `integrar-pedidos` envia pedidos (TGFCAB+TGFITE) retornando o `nunota` para faturamento.

---

## Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Frontend | React |
| Backend / Banco | Supabase (PostgreSQL 17) |
| Autenticação | Supabase Auth + RLS |
| Serverless | Supabase Edge Functions (TypeScript / Deno) |
| Agendamento | pg_cron + pg_net |
| ERP | Sankhya (API OAuth 2.0 + JAPE loadRecords) |

---

## Estrutura do Banco de Dados

```
Catálogo       produto, categoria, especificacao, produto_imagem
Comercial      estoque, preco
Clientes       cliente (→ auth.users), endereco
Vendas         pedido, pedido_item
Logs           log_sincronizacao, log_integracao_pedido
```

Para o schema completo, consulte [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md).
Para o mapeamento de campos Sankhya ↔ Supabase, consulte [`docs/MAPPING.md`](docs/MAPPING.md).

---

## Edge Functions

| Função | verify_jwt | Trigger | Descrição |
|---|---|---|---|
| `sync-produtos` | false | pg_cron | Sincroniza produtos com `AD_SYNCSITE='S'` do Sankhya |
| `sync-categorias` | false | pg_cron | Sincroniza grupos de produto (TGFGRU) com ordenação topológica |
| `sync-estoque` | false | pg_cron | Sincroniza estoque real (TGFEST, CODEMP=1, CODLOCAL=109) |
| `sync-precos` | false | pg_cron | Sincroniza preços da tabela 201 via REST por produto |
| `sync-especificacoes` | false | pg_cron | Sincroniza especificações customizadas (AD_PROESP) |
| `integrar-clientes` | false | pg_cron | Reconcilia/cria clientes PF no Sankhya (TGFPAR) |
| `integrar-pedidos` | false | Manual | Envia pedidos pagos ao Sankhya (TGFCAB+TGFITE) |
| `test-sankhya-auth` | true | Manual | Valida secrets e conectividade OAuth com a API Sankhya; retorna preview mascarado dos valores |

Todas as funções de sync registram execução em `log_sincronizacao`. O código-fonte está em `supabase/functions/`.

---

## Agendamento (pg_cron)

| Job | Schedule | Edge Function |
|---|---|---|
| `sync-produtos-hourly` | `0 * * * *` | `sync-produtos` — a cada 1 hora |
| `sync-estoque-30min` | `*/30 * * * *` | `sync-estoque` — a cada 30 minutos |
| `sync-precos-daily` | `0 1 * * *` | `sync-precos` — diariamente às 01:00 |
| `sync-categorias-daily` | `0 3 * * *` | `sync-categorias` — diariamente às 03:00 |

---

## Secrets necessários

Configure os seguintes secrets nas **Edge Function Secrets** do Supabase (nunca exponha no código ou frontend):

| Secret | Descrição |
|---|---|
| `SANKHYA_AUTH_URL` | URL do endpoint de autenticação OAuth do Sankhya |
| `SANKHYA_CLIENT_ID` | ID da aplicação no Portal do Desenvolvedor Sankhya |
| `SANKHYA_CLIENT_SECRET` | Secret da aplicação |
| `SANKHYA_X_TOKEN` | Token JWT obtido em *Configurações Gateway* no Sankhya Om |

---

## Execução manual das Edge Functions

```bash
# Testar autenticação com o Sankhya
curl -X GET https://dafsaudqocbznvvvtojy.supabase.co/functions/v1/test-sankhya-auth \
  -H "Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>"

# Disparar sync manualmente (todas sem JWT)
curl -X POST https://dafsaudqocbznvvvtojy.supabase.co/functions/v1/sync-produtos
curl -X POST https://dafsaudqocbznvvvtojy.supabase.co/functions/v1/sync-categorias
curl -X POST https://dafsaudqocbznvvvtojy.supabase.co/functions/v1/sync-estoque
curl -X POST https://dafsaudqocbznvvvtojy.supabase.co/functions/v1/sync-precos
```

Resposta padrão de sucesso:
```json
{
  "success": true,
  "registros_processados": 75,
  "registros_ignorados": 7
}
```

---

## Segurança

- **RLS** habilitado em todas as tabelas — clientes só acessam seus próprios dados
- **Service Role Key** usada exclusivamente nas Edge Functions (nunca no frontend)
- **Credentials** do Sankhya armazenadas nos Supabase Secrets (não no banco)
- Frontend usa apenas a **anon key** pública
- Edge Functions de sync usam `verify_jwt: false` pois são invocadas pelo `pg_net` via cron interno

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) | Arquitetura, objetivos e padrões do projeto |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) | Schema completo de todas as tabelas |
| [`docs/MAPPING.md`](docs/MAPPING.md) | Mapeamento completo Sankhya ↔ Supabase por entidade |
| [`docs/SANKHYA_INTEGRATION_SPECS.md`](docs/SANKHYA_INTEGRATION_SPECS.md) | Referências da API Sankhya e especificações de integração |
