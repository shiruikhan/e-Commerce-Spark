
## 1. Objetivo do Projeto

Middleware de integração entre um **E-commerce (React)** e o **ERP Sankhya**, utilizando o **Supabase** como núcleo de processamento e armazenamento. Automatiza a sincronização de catálogo (produtos, categorias, estoque, preços, especificações) e orquestra o envio de clientes e pedidos ao ERP.

## 2. Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Frontend | React (consultivo — foco em segurança de credenciais) |
| Backend / Banco | Supabase (PostgreSQL 17) — Plano Free |
| Autenticação | Supabase Auth + RLS |
| Serverless | Supabase Edge Functions (TypeScript / Deno) |
| Agendamento | `pg_cron` + `pg_net` |
| ERP | Sankhya (API OAuth 2.0 Client Credentials + JAPE loadRecords) |

## 3. Arquitetura e Fluxo de Dados

### A. Fluxo de Entrada (Sankhya → Supabase)

Sincronização periódica via `pg_cron`. As Edge Functions buscam dados de catálogo no Sankhya e atualizam as tabelas correspondentes no Supabase. **Operação estritamente de leitura no Sankhya — nenhum dado é escrito de volta ao ERP neste fluxo.**

### B. Fluxo de Saída (E-commerce → Supabase → Sankhya)

Pedidos realizados no React são persistidos no Supabase. Edge Functions processam o envio ao ERP:

- **`integrar-clientes`** — reconcilia/cria clientes PF na TGFPAR antes do pedido ser enviado
- **`integrar-pedidos`** — envia pedidos pagos ao Sankhya (TGFCAB + TGFITE), retorna `nunota` para faturamento

## 4. Estrutura de Dados (Schema)

O banco de dados está organizado nas seguintes entidades:

| Grupo | Tabelas |
|---|---|
| Catálogo | `produto`, `categoria`, `especificacao`, `produto_imagem` |
| Comercial | `estoque` (com `proporcao` manual), `preco` (tabela 201) |
| Embalagem | `embalagem`, `pedido_embalagem` |
| Carrinho | `carrinho` |
| Clientes | `cliente` (→ `auth.users`), `endereco` |
| Vendas | `pedido`, `pedido_item` |
| Auxiliares | `cidade` (TGFCID), `bairro` (TGFBAI) |
| Parceiros | `parceiro` (snapshot TGFPAR — RLS **desabilitado** ⚠️) |
| Externas | `ext_product_images`, `ext_api_keys` |
| Logs | `log_sincronizacao`, `log_integracao_pedido` |

Para o schema completo, consulte [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).
Para o mapeamento Sankhya ↔ Supabase, consulte [`MAPPING.md`](MAPPING.md).

## 5. Edge Functions

| Função | Trigger | Descrição |
|---|---|---|
| `sync-produtos` | pg_cron (horário) | Produtos com `AD_SYNCSITE='S'`, incremental por `DTALTER` |
| `sync-categorias` | pg_cron (diário 03h) | Grupos TGFGRU com ordenação topológica |
| `sync-estoque` | pg_cron (30min) | Estoque real (TGFEST, CODEMP=1, CODLOCAL=109) |
| `sync-precos` | pg_cron (diário 01h) | Preços tabela 201 via REST por produto |
| `sync-especificacoes` | pg_cron (diário 02h) | Especificações customizadas (AD_PROESP) |
| `sync-bairros` | pg_cron (diário 00:30h) | Cidades (TGFCID) e bairros (TGFBAI) |
| `sync-parceiros` | pg_cron (schedule a definir) | Snapshot TGFPAR → `public.parceiro` para lookup local de CPF |
| `integrar-clientes` | pg_cron (30min) | Reconcilia/cria clientes PF no Sankhya (TGFPAR) |
| `integrar-pedidos` | pg_cron (`5,35 * * * *`) | Envia pedidos pagos ao Sankhya — roda 5 min após `integrar-clientes` para garantir `codparc` resolvido |
| `util-update-cidade-codibge` | Manual (utilitário pontual) | Enriquece `cidade.codibge` via API IBGE — executar somente quando necessário |
| `test-sankhya-auth` | Manual | Valida secrets e conectividade OAuth com o Sankhya |

## 6. Diretrizes de Segurança

- **RLS** habilitado em todas as tabelas — clientes só acessam seus próprios dados
- **`service_role_key`** usada exclusivamente nas Edge Functions (nunca no frontend ou banco)
- **Credentials** do Sankhya armazenadas exclusivamente nos Supabase Edge Function Secrets
- Frontend usa apenas a **anon key** pública
- Edge Functions de sync usam `verify_jwt: false` pois são invocadas pelo `pg_net` via cron interno
- **⚠️ Pendência:** `public.parceiro` está com RLS desabilitado. Habilitar antes de expor ao frontend:
  ```sql
  ALTER TABLE public.parceiro ENABLE ROW LEVEL SECURITY;
  ```

## 7. Padrões de Desenvolvimento

- **Linguagem:** TypeScript para todas as Edge Functions
- **Resiliência:** blocos `try/catch` em todo código de integração
- **Logs obrigatórios:**
  - Toda Edge Function de sync deve inserir `status='processando'` em `log_sincronizacao` ao iniciar e atualizar para `'sucesso'` ou `'erro'` ao finalizar
  - Toda tentativa de envio de pedido deve gerar entrada em `log_integracao_pedido` com `payload_enviado` e `resposta_recebida`
- **Otimização:** código eficiente em memória — upserts incrementais, guards de deadline (130s), batches pequenos (3–10 itens)
- **Auth Sankhya:** somente OAuth 2.0 Client Credentials (`X-Token` + `client_id` + `client_secret`). AppKey/bearerToken legados são **proibidos**
- **Códigos externos:** IBGE, CODCID, CODPARC etc. devem vir sempre da fonte oficial — nunca assumir ou deduzir valores

## 8. Mapeamento de Dados

Os detalhes técnicos de "De/Para" entre os campos do Supabase e as tags/campos do Sankhya são mantidos em [`MAPPING.md`](MAPPING.md).
