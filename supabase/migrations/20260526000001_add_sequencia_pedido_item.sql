-- Adiciona coluna sequencia em pedido_item para rastreabilidade com TGFITE do Sankhya.
-- Valor preenchido no momento da criação do pedido (frontend/checkout) e enviado
-- diretamente ao campo SEQUENCIA da API POST /v1/vendas/pedidos.
ALTER TABLE pedido_item ADD COLUMN sequencia integer;
