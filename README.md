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

### Fluxo de Entrada (Sankhya → Supabase)
Sincronização periódica via **pg_cron** + **Edge Functions**: produtos, estoque, preços e categorias são mantidos atualizados no Supabase.

### Fluxo de Saída (E-commerce → Supabase → Sankhya)
Pedidos criados no React são persistidos no Supabase e enviados ao Sankhya via Edge Function, que retorna o `nunota` para faturamento.

---

## Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Frontend | React |
| Backend / Banco | Supabase (PostgreSQL 17) — Plano Free |
| Autenticação | Supabase Auth + RLS |
| Serverless | Supabase Edge Functions (TypeScript / Deno) |
| Agendamento | pg_cron |
| ERP | Sankhya (API REST OAuth 2.0) |

---

## Estrutura do Banco de Dados

```
Catálogo       produto, categoria, especificacao, produto_imagem
Comercial      estoque, preco
Clientes       cliente (→ auth.users), endereco
Vendas         pedido, pedido_item
Logs           log_sincronizacao, log_integracao_pedido
```

Para o schema completo, consulte [`docs/estrutura do banco.sql`](docs/estrutura%20do%20banco.sql).
Para o mapeamento de campos Sankhya ↔ Supabase, consulte [`docs/MAPPING.md`](docs/MAPPING.md).

---

## Edge Functions

| Função | Trigger | Descrição |
|---|---|---|
| `sync-produtos` | pg_cron (1h) | Sincroniza produtos com `AD_SYNCSITE='S'` do Sankhya |
| `test-sankhya-auth` | Manual | Valida conectividade e secrets com a API Sankhya |
| `test-sankhya-query` | Manual | Diagnóstico de queries no Sankhya |

---

## Agendamento (pg_cron)

| Job | Schedule | Descrição |
|---|---|---|
| `sync-produtos-hourly` | `0 * * * *` | Sincronização de produtos a cada 1 hora |

---

## Configuração

### Pré-requisitos
- Projeto Supabase ativo
- Conta no Portal do Desenvolvedor Sankhya com aplicação cadastrada
- Acesso ao Sankhya Om para obter o token de gateway

### Secrets necessários

Configure os seguintes secrets nas **Edge Function Secrets** do Supabase (nunca exponha esses valores no código ou no frontend):

| Secret | Descrição |
|---|---|
| `SANKHYA_AUTH_URL` | URL do endpoint de autenticação OAuth do Sankhya |
| `SANKHYA_CLIENT_ID` | ID da aplicação no Portal do Desenvolvedor Sankhya |
| `SANKHYA_CLIENT_SECRET` | Secret da aplicação |
| `SANKHYA_X_TOKEN` | Token JWT obtido em *Configurações Gateway* no Sankhya Om |

### Validando a integração

Após configurar os secrets, execute a função de teste:

```bash
curl -X GET https://<PROJECT_REF>.supabase.co/functions/v1/test-sankhya-auth \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>"
```

Resposta esperada:
```json
{
  "success": true,
  "message": "Autenticação Sankhya bem-sucedida.",
  "report": {
    "token_received": true,
    "token_type": "Bearer",
    "expires_in": 300
  }
}
```

---

## Sincronização de Produtos

### Execução manual
```bash
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/sync-produtos
```

### Resposta
```json
{
  "success": true,
  "registros_processados": 75,
  "registros_ignorados": 7
}
```

### Lógica incremental
- Busca todos os produtos com `AD_SYNCSITE='S'` no Sankhya
- Compara `DTALTER` do Sankhya com o `dtalter` armazenado no Supabase
- Faz upsert apenas dos produtos novos ou modificados
- Registra cada execução em `log_sincronizacao`

---

## Segurança

- **RLS** habilitado em todas as tabelas — clientes só acessam seus próprios dados
- **Service Role Key** usada exclusivamente nas Edge Functions (nunca no frontend)
- **Credentials** do Sankhya armazenadas nos Supabase Secrets (não no banco)
- Frontend usa apenas a **anon key** pública

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) | Arquitetura e objetivos do projeto |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) | Relacionamentos e regras do banco |
| [`docs/MAPPING.md`](docs/MAPPING.md) | Mapeamento completo Sankhya ↔ Supabase |
| [`docs/SANKHYA_INTEGRATION_SPECS.md`](docs/SANKHYA_INTEGRATION_SPECS.md) | Especificações da API Sankhya |
| [`docs/estrutura do banco.sql`](docs/estrutura%20do%20banco.sql) | Schema SQL completo |
