# Especificações da API Sankhya

## 1. Referências Oficiais (Developer Portal)

- **Autenticação (OAuth):** https://developer.sankhya.com.br/reference/post_authenticate
- **Clientes:** https://developer.sankhya.com.br/reference/getcliente
- **Estoque:** https://developer.sankhya.com.br/reference/getestoqueporproduto
- **Preços:** https://developer.sankhya.com.br/reference/getprecoprodutotabela
- **Produtos:** https://developer.sankhya.com.br/reference/get_v1-produtos
- **Consultas Genéricas (loadRecords):** https://developer.sankhya.com.br/reference/get_loadrecords
- **Incluir Pedido de Venda:** https://developer.sankhya.com.br/reference/addpedido
- **Atualizar Pedido de Venda:** https://developer.sankhya.com.br/reference/putpedido
- **Cancelar Pedido de Venda:** https://developer.sankhya.com.br/reference/postcancelapedido
- **Consultar Pedidos de Venda:** https://developer.sankhya.com.br/reference/getpedidos

---

## 2. Autenticação — OAuth 2.0 Client Credentials

### Secrets configurados no Supabase
| Secret | Descrição |
|---|---|
| `SANKHYA_AUTH_URL` | URL completa do endpoint de autenticação — deve ser `https://api.sankhya.com.br/authenticate` |
| `SANKHYA_CLIENT_ID` | ID da aplicação no Portal do Desenvolvedor |
| `SANKHYA_CLIENT_SECRET` | Secret da aplicação |
| `SANKHYA_X_TOKEN` | Token JWT do gateway — obtido em *Configurações Gateway* no Sankhya Om |

### Requisição de autenticação
```
POST https://api.sankhya.com.br/authenticate
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
| Auth | POST | `https://api.sankhya.com.br/authenticate` | Todas as funções |
| Produto | loadRecords | rootEntity: `Produto` (TGFPRO) | `sync-produtos` |
| Categoria | loadRecords | rootEntity: `GrupoProduto` (TGFGRU) | `sync-categorias` |
| Estoque | loadRecords | rootEntity: `Estoque` (TGFEST) | `sync-estoque` |
| Especificação | loadRecords | rootEntity: `AD_PROESP` (tabela customizada) | `sync-especificacoes` |
| Preço | REST GET | `/v1/precos/produto/{codprod}/tabela/{codtab}` (TGFTAB+TGFEXC) | `sync-precos` |
| Cidade | loadRecords | rootEntity: `Cidade` (TGFCID) — campos: `CODCID,NOMECID,UF` | `sync-bairros` |
| Bairro | loadRecords | rootEntity: `Bairro` (TGFBAI) — campos: `CODBAI,NOMEBAI` (**sem CODCID**) | `sync-bairros` |
| Cliente | REST POST + loadRecords | `POST /v1/parceiros/clientes` + `Parceiro` (TGFPAR) | `integrar-clientes` |
| Pedido | REST POST + REST POST | `POST /v1/vendas/pedidos` + `POST /v1/vendas/pedidos/{nunota}/cancela` | `integrar-pedidos` |

> **Nota:** A REST API `/v1/estoque` apresentou instabilidade. O padrão para estoque, produtos e categorias é o `loadRecords` via JAPE.
> **Preços usam REST API individual por produto** (`/v1/precos/produto/{codprod}/tabela/{codtab}`), pois a fonte correta é `TGFTAB`+`TGFEXC` (não `TGFPRC`). A REST abstrai essa estrutura e se mostrou estável nos testes (07/04/2026).
> **Bairro (TGFBAI):** o campo `CODCID` não está disponível via `loadRecords` nesta instância — solicitar retorna erro `"Descritor do campo 'CODCID' inválido"`. A coluna `codcid` na tabela local é sempre `null`.
> **Cidade (TGFCID):** a coluna `uf` armazena o **CODUF numérico** do Sankhya (ex: `'2'` para MG), não a sigla textual.

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
- HTTP 400 na auth indica **URL incorreta** (`SANKHYA_AUTH_URL` deve terminar em `/authenticate`, não `/login`). Verificar a URL antes de suspeitar das credenciais.

---

## 5. Regras de Integração

### Leitura apenas (Sankhya → Supabase)
As funções de sync são **estritamente leitura** no Sankhya. Nenhum dado é escrito de volta ao ERP pelas funções de sincronização de catálogo.

Escrita no Sankhya está prevista apenas para:
- Criação/atualização de **cliente** (fluxo de cadastro) — `integrar-clientes`
- Envio e cancelamento de **pedido** (fluxo de venda) — `integrar-pedidos`

### Token por execução
Não armazenar o `access_token` em banco — obter sempre um novo no início de cada execução.

### Logs obrigatórios
Toda Edge Function de sync deve:
1. Inserir em `log_sincronizacao` com `status='processando'` antes de qualquer chamada ao Sankhya
2. Atualizar para `status='sucesso'` ou `status='erro'` ao finalizar
3. Registrar `registros_processados` e `finalizado_em`

### Campos de empresa (CODEMP)
- `CODEMP = 2` é a empresa e-commerce e deve constar **apenas no cabeçalho do pedido** (TGFCAB), campo `codigoEmpresa` no payload REST
- **Não enviar** `CODEMP` no cadastro de parceiro (TGFPAR) — não é campo do parceiro
- `integrar-pedidos` envia `codigoEmpresa: 2` via constante `CODIGO_EMPRESA`

---

## 6. Integração de Clientes — `integrar-clientes`

### Fluxo
1. Busca clientes PF (`cpf_cnpj` com 11 dígitos) sem `codparc` e `integracao_status` null/pendente
2. Para cada cliente: verifica se já existe no Sankhya via `loadRecords` em `Parceiro` com `THIS.CGC_CPF = ?` (tenta CPF formatado e dígitos puros em sequência)
3. Se existir → reconcilia (grava `codparc` localmente)
4. Se não existir e tiver pedido → cria via `POST /v1/parceiros/clientes`
5. Se não existir e não tiver pedido → ignora (não cria parceiro sem transação)

### Comportamento da tag `consumidor`
O corpo do `POST /v1/parceiros/clientes` aceita uma tag `consumidor` opcional com três modos:

| Modo | Comportamento |
|---|---|
| Sem a tag `consumidor` | O serviço usa o CODPARC contido na nota modelo para vincular ao documento |
| Com apenas `cnpjCpf` | Tenta encontrar o cliente por CPF/CNPJ; se não encontrar, salva o documento no cabeçalho (TGFCAB) |
| Com todos os campos | Exige que todos os campos obrigatórios estejam preenchidos para incluir ou atualizar o parceiro |

> Os atributos mapeiam a entidade "Parceiro" (TGFPAR). É possível usar nomes alternativos como `CGCCPF` em vez de `cnpjCpf`, e incluir campos do dicionário de dados não listados aqui.

### Payload de criação (`POST /v1/parceiros/clientes`) — estrutura correta da API
```json
{
  "tipo":           "PF",
  "cnpjCpf":        "148.713.246-80",
  "ieRg":           "",
  "nome":           "NOME EM MAIÚSCULAS",
  "email":          "email@exemplo.com",
  "telefoneDdd":    "34",
  "telefoneNumero": "999035806",
  "contatos":       [],
  "endereco": {
    "logradouro":  "Rua Dr Djalma Afonso do Prado",
    "numero":      "249",
    "complemento": "Bar do Mané",
    "bairro":      "ALTO DA ESTAÇÃO",
    "cidade":      "Sacramento",
    "codigolbge":  "3156908",
    "uf":          "MG",
    "cep":         "38190000"
  }
}
```

**Campos obrigatórios (required):** `tipo`, `cnpjCpf`, `nome`, e dentro de `endereco`: `logradouro`, `numero`, `bairro`, `cidade`, `codigolbge`, `uf`, `cep`.

**Campos opcionais:** `ieRg`, `razao` (nome social PJ), `email`, `telefoneDdd`, `telefoneNumero`, `limiteCredito`, `grupoAutorizacao`, `contatos`, `endereco.latitude`, `endereco.longitude`, `endereco.complemento`.

> **Nota sobre telefone:** o número deve ser separado em `telefoneDdd` (ex: `"34"`) e `telefoneNumero` (ex: `"999035806"`), **não** em formato único `"(34)999035806"`.

### Problema conhecido — `PreparedStatement Bairro: param[0] = null`
O endpoint `POST /v1/parceiros/clientes` nesta instância retorna 400 com erro:
```
Erro interno: PreparedStatement com parâmetro nulo na entidade 'Bairro': param[0] = null
```

**Hipótese principal (próximo sprint):** O payload enviado anteriormente não incluía o campo `codigolbge` (código IBGE do município), que é **obrigatório** segundo a documentação oficial. O Sankhya usa esse código para resolver internamente TGFCID e TGFBAI — sem ele, a query de bairro recebe `param[0] = null`. Nossa implementação atual envia `bairro` e `cidade` como texto livre mas **omite `codigolbge`**.

**O que falta para resolver:**
1. Armazenar o código IBGE na tabela `cidade` local (campo `codibge`) — a sync de cidades (`sync-bairros`) precisará incluir esse campo ao ler `TGFCID`
2. Juntar `codibge` da cidade ao montar o payload de criação de parceiro em `integrar-clientes`
3. Separar o campo `telefone` em `telefoneDdd` + `telefoneNumero`
4. Corrigir `cpfCnpj` → `cnpjCpf`, `tipoPessoa: "F"` → `tipo: "PF"`, e mover campos de endereço para objeto `endereco` aninhado

**Hipótese secundária (Sankhya Admin):**
- Verificar triggers e regras de negócio em `TGFPAR` que consultam `TGFBAI`
- Garantir que o usuário associado ao `client_id` OAuth tenha `CODBAI` válido no perfil
- `CRUDServiceProvider.saveRecord` na entidade `Parceiro` retorna `status: "0"` com `statusMessage: "Sem mensagem de erro"` — mesma causa raiz

### Reconciliação automática
Clientes criados manualmente no Sankhya são reconciliados automaticamente na próxima execução do cron (a cada 30 min), desde que o CPF bata. O `codparc` é gravado na tabela `cliente` e o status atualizado para `integrado`.

---

## 7. Integração de Pedidos — `integrar-pedidos`

### Pré-requisito
O cliente do pedido deve ter `codparc` preenchido em `cliente`. Pedidos sem `codparc` são ignorados com ação `sem_codparc`.

### Payload de criação (`POST /v1/vendas/pedidos`)
```json
{
  "notaModelo":     1006,
  "codigoEmpresa":  2,
  "data":           "DD/MM/AAAA",
  "hora":           "HH:MM:SS",
  "codigoVendedor": 6,
  "codigoCliente":  <codparc>,
  "valorTotal":     1186.00,
  "valorFrete":     0,
  "itens": [
    { "codigoProduto": 31700399, "quantidade": 2, "valorUnitario": 500.00 }
  ],
  "financeiros": [
    { "codTipVenda": 140, "valor": 1186.00 }
  ]
}
```

### Constantes fixas
| Constante | Valor | Descrição |
|---|---|---|
| `notaModelo` | `1006` | TOP do e-commerce no Sankhya |
| `codigoEmpresa` | `2` | CODEMP da empresa e-commerce (TGFCAB) |
| `codigoVendedor` | `6` | Vendedor padrão e-commerce |

### Mapeamento `codTipVenda`
| Método de Pagamento | `codTipVenda` |
|---|---|
| `pix` | `140` |
| `cartao` / `cartão` | `86` |
| `boleto` | `87` |
| `mercadopago` | ❌ não mapeado — pedido ignorado com `sem_pagamento` |

### Retorno esperado
```json
{ "codigoNota": 12345 }
```
O campo pode vir como `codigoNota`, `nunota` ou `codigoPedido` dependendo da versão. O `nunota` é gravado na tabela `pedido` e registrado em `log_integracao_pedido`.
