
## 1. Objetivo do Projeto

Este projeto consiste no desenvolvimento de um middleware de integração robusto entre um **E-commerce (React)** e o **ERP Sankhya**, utilizando o **Supabase** como núcleo de processamento e armazenamento. O foco é a automação da sincronização de produtos, estoque e preços, além da orquestração do fluxo de pedidos e clientes.

## 2. Stack Tecnológica

-   **Frontend:** React (Atuação consultiva; foco em segurança de credenciais).
    
-   **Backend & Database:** Supabase (PostgreSQL) operando em **Plano Free**.
    
-   **Autenticação:** Supabase Auth para gestão de clientes e segurança de acesso.
    
-   **Serverless:** Supabase Edge Functions escritas em **TypeScript**.
    
-   **Agendamento:** Supabase Cron para execuções periódicas de sincronização.
    
-   **ERP:** Sankhya (Integração via API REST/JAPE).
    

## 3. Arquitetura e Fluxo de Dados

O sistema opera em dois fluxos principais de sincronização:

### A. Fluxo de Entrada (Sankhya → Supabase)

-   **Método:** Sincronização periódica via **Supabase Cron**.
    
-   **Processo:** As Edge Functions buscam dados de catálogo (produtos, categorias, preços e estoque) no Sankhya e atualizam as tabelas correspondentes no Supabase.
    
-   **Objetivo:** Manter o E-commerce atualizado com a realidade do estoque e precificação do ERP.
    

### B. Fluxo de Saída (E-commerce → Supabase → Sankhya)

-   **Processo:** Pedidos realizados no React são persistidos no Supabase.
    
-   **Integração:** Uma Edge Function é disparada para processar o pagamento e enviar os dados do pedido e do cliente para o Sankhya.
    
-   **Resultado:** Geração do número de nota (`nunota`) no Sankhya para faturamento.
    

## 4. Estrutura de Dados (Esquema SQL)

O banco de dados está organizado nas seguintes entidades principais:

-   **Catálogo:** `produto`, `categoria`, `especificacao`, `produto_imagem`.
    
-   **Comercial:** `estoque` (com controle de `proporcao`) e `preco` (suporte a `codtab`).
    
-   **Clientes:** `cliente` (vinculado ao `auth.users`) e `endereco`.
    
-   **Vendas:** `pedido` e `pedido_item`.
    
-   **Logs:** `log_sincronizacao` e `log_integracao_pedido`.
    

## 5. Diretrizes de Segurança

-   **Exposição de Chaves:** É terminantemente proibido expor chaves de API, segredos do banco ou a `service_role_key` no lado do cliente (React).
    
-   **Gerenciamento de Segredos:** Todas as credenciais sensíveis devem ser armazenadas no **Supabase Vault** ou em variáveis de ambiente das Edge Functions.
    
-   **Permissões:** O banco de dados utiliza **Row Level Security (RLS)** para garantir o isolamento dos dados dos clientes.
    

## 6. Padrões de Desenvolvimento (Instruções para o Claude)

Toda implementação gerada deve seguir rigorosamente estes padrões:

-   **Linguagem:** TypeScript para todas as Edge Functions.
    
-   **Resiliência:** Todo código de integração deve utilizar blocos `try/catch` para capturar exceções.
    
-   **Logs Obrigatórios:**
    
    -   Falhas ou sucessos em processos de lote devem ser registrados em `log_sincronizacao`.
        
    -   Toda tentativa de envio de pedido deve gerar uma entrada em `log_integracao_pedido`, incluindo o `payload_enviado` e a `resposta_recebida`.
        
-   **Otimização:** Devido às limitações do **Plano Free**, o código deve ser eficiente em termos de memória e tempo de execução para evitar gargalos de CPU.
    

## 7. Mapeamento de Dados

-   Os detalhes técnicos de "De/Para" entre os campos do Supabase e as tags/campos do Sankhya serão mantidos no arquivo externo `MAPPING.md`.
