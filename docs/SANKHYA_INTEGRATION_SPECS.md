
## 1. Referências Oficiais (Developer Portal)

Documentação base para consulta de tipos de dados e parâmetros:

-   **Autenticação (OAuth):** [Post Authenticate](https://developer.sankhya.com.br/reference/post_authenticate)
    
-   **Clientes:** [Get](https://developer.sankhya.com.br/reference/getcliente) | [Post](https://developer.sankhya.com.br/reference/postcliente) | [Put](https://developer.sankhya.com.br/reference/putcliente)
    
-   **Estoque:** [Por Produto](https://developer.sankhya.com.br/reference/getestoqueporproduto) | [Lista Geral](https://developer.sankhya.com.br/reference/getestoqueprodutos)
    
-   **Preços:** [Preço por Tabela](https://developer.sankhya.com.br/reference/getprecoprodutotabela)
    
-   **Produtos:** [Catálogo V1](https://developer.sankhya.com.br/reference/get_v1-produtos)
    
-   **Consultas Genéricas:** [Load Records](https://developer.sankhya.com.br/reference/get_loadrecords)
    

## 2. Fluxo de Autenticação (OAuth)

Diferente do login por sessão anterior, utilizaremos o fluxo de **Client Credentials**.

### Credenciais Necessárias (Disponíveis no Supabase Secrets)

-   `SANKHYA_CLIENT_ID`
    
-   `SANKHYA_CLIENT_SECRET`
    
-   `SANKHYA_APP_KEY`
    
-   `SANKHYA_AUTH_URL`
    

### Implementação do Handshake

1.  A Edge Function deve disparar um `POST` para `SANKHYA_AUTH_URL`.
    
2.  O corpo da requisição deve conter o `client_id` e `client_secret`.
    
3.  O Header deve incluir o `appkey`.
    
4.  O `access_token` recebido deve ser armazenado temporariamente ou renovado a cada execução (respeitando o tempo de vida do token).
    

## 3. Mapeamento de Endpoints por Entidade

Entidade	Método	Endpoint	Objetivo
Auth	POST	/authenticate	Obter token de acesso OAuth
Cliente	POST/PUT	/v1/clientes	Sincronizar cadastros do E-commerce
Estoque	GET	/v1/estoque	Atualizar saldo no Supabase
Preço	GET	/v1/precos	Consultar vlr_venda por codtab
Produto	GET	/v1/produtos	Popular catálogo inicial
Genérico	GET	/v1/loadRecords	Consultas SQL customizadas (Ex: TGFCAB)

## 4. Diretrizes Técnicas para o Claude

### Gestão de Tokens

> **Importante:** Como estamos no plano free do Supabase, evite salvar o token no banco de dados para não gerar escritas desnecessárias. Prefira obter um novo token ou utilizar o cache em memória da Edge Function se as chamadas forem sequenciais.
