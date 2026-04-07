# Especificações da API Sankhya

## 1. Referências Oficiais (Developer Portal)

- **Autenticação (OAuth):** https://developer.sankhya.com.br/reference/post_authenticate
- **Clientes:** https://developer.sankhya.com.br/reference/getcliente
- **Estoque:** https://developer.sankhya.com.br/reference/getestoqueporproduto
- **Preços:** https://developer.sankhya.com.br/reference/getprecoprodutotabela
- **Produtos:** https://developer.sankhya.com.br/reference/get_v1-produtos
- **Consultas Genéricas (loadRecords):** https://developer.sankhya.com.br/reference/get_loadrecords

---

## 2. Autenticação — OAuth 2.0 Client Credentials

### Secrets configurados no Supabase
| Secret | Descrição |
|---|---|
| `SANKHYA_AUTH_URL` | URL completa do endpoint de autenticação |
| `SANKHYA_CLIENT_ID` | ID da aplicação no Portal do Desenvolvedor |
| `SANKHYA_CLIENT_SECRET` | Secret da aplicação |
| `SANKHYA_X_TOKEN` | Token JWT do gateway — obtido em *Configurações Gateway* no Sankhya Om |

### Requisição de autenticação
```
POST {SANKHYA_AUTH_URL}
Content-Type: application/x-www-form-urlencoded
X-Token: {SANKHYA_X_TOKEN}

grant_type=client_credentials&client_id={SANKHYA_CLIENT_ID}&client_secret={SANKHYA_CLIENT_SECRET}
```

### Resposta
```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 300
}
```

> Token expira em **300 segundos**. Obter um novo a cada execução — não armazenar em banco.

---

## 3. Endpoints por Entidade

| Entidade | Método | Endpoint / Mecanismo | Usado por |
|---|---|---|---|
| Auth | POST | `{SANKHYA_AUTH_URL}` | Todas as funções |
| Produto | loadRecords | rootEntity: `Produto` (TGFPRO) | `sync-produtos` |
| Categoria | loadRecords | rootEntity: `GrupoProduto` (TGFGRU) | `sync-categorias` |
| Estoque | loadRecords | rootEntity: `Estoque` (TGFEST) | `sync-estoque` |
| Preço | REST GET | `/v1/precos/produto/{codprod}/tabela/{codtab}` (TGFTAB+TGFEXC) | `sync-precos` |
| Cliente | REST POST + loadRecords | `POST /v1/parceiros/clientes` + `Parceiro` (TGFPAR) | `integrar-clientes` |
| Pedido | loadRecords | rootEntity: `CabecalhoNota` (TGFCAB) | planejado |

> **Nota:** A REST API `/v1/estoque` apresentou instabilidade. O padrão para estoque, produtos e categorias é o `loadRecords` via JAPE.
> **Preços usam REST API individual por produto** (`/v1/precos/produto/{codprod}/tabela/{codtab}`), pois a fonte correta é `TGFTAB`+`TGFEXC` (não `TGFPRC`). A REST abstrai essa estrutura e se mostrou estável nos testes (07/04/2026).

---

## 4. loadRecords — Padrões e Armadilhas

### Base URL
```
{BASE}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json
```

Onde `{BASE}` = protocolo + host extraído do `SANKHYA_AUTH_URL`.

### Paginação
- `offsetPage` começa em **0** (base-0)
- Página com 50 registros por padrão
- `hasMoreResult: "true"` no response indica mais páginas

### Parsing posicional
Os campos retornam em posições numéricas (`f0`, `f1`...) mapeadas por `metadata.fields.field`. Exemplo:
```
metadata: { fields: { field: [{name:"CODPROD"}, {name:"DESCR"}] } }
entity:   { f0: {"$": "123"}, f1: {"$": "Produto X"} }
```
Campos sem valor retornam `{}` (objeto vazio), não `null`.

### Datas
- Retornadas no formato brasileiro: `DD/MM/AAAA HH:MM:SS`
- Fuso: UTC-3 (Brasília)
- Converter para ISO 8601 ao salvar no Supabase

### Erros
- `data.status !== '1'` indica erro — verificar `data.statusMessage`
- HTTP 400 na auth pode ser transitório — a função registra o erro em `log_sincronizacao`

---

## 5. Regras de Integração

### Leitura apenas (Sankhya → Supabase)
As funções de sync são **estritamente leitura** no Sankhya. Nenhum dado é escrito de volta ao ERP pelas funções de sincronização de catálogo.

Escrita no Sankhya está prevista apenas para:
- Criação/atualização de **cliente** (fluxo de cadastro)
- Envio de **pedido** (fluxo de venda)

### Token por execução
Não armazenar o `access_token` em banco — obter sempre um novo no início de cada execução.

### Logs obrigatórios
Toda Edge Function de sync deve:
1. Inserir em `log_sincronizacao` com `status='processando'` antes de qualquer chamada ao Sankhya
2. Atualizar para `status='sucesso'` ou `status='erro'` ao finalizar
3. Registrar `registros_processados` e `finalizado_em`
