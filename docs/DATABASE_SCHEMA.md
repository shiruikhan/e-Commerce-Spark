# Guia de Relacionamentos do Banco de Dados

## Regras de Integridade
- **Clientes:** `public.cliente.id` referencia `auth.users.id`. O campo `codparc` é o vínculo único com o Sankhya.
- **Produtos:** A chave primária é o `codprod`. 
- **Estoque:** O campo `estoque_disponivel` é calculado: `(estoque_real * proporcao)`.
- **Pedidos:** - `pedido.nunota`: ID do pedido dentro do Sankhya (preenchido após a integração).
    - `pedido_item.pedido_id` -> `pedido.id`.

## Fluxo de Logs (Obrigatório)
Toda integração deve seguir este fluxo:
1. Inserir em `log_sincronizacao` com status 'processando'.
2. Executar a lógica de integração.
3. Atualizar `log_sincronizacao` com `finalizado_em` e `status` ('sucesso' ou 'erro').
4. Se for um pedido, registrar cada tentativa em `log_integracao_pedido`.