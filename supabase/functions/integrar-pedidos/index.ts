import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Configurações fixas — regras obrigatórias do projeto
// ---------------------------------------------------------------------------
const NOTA_MODELO     = 1006;  // TOP do e-commerce no Sankhya
const CODIGO_VENDEDOR = 6;     // Vendedor padrão e-commerce
const CODIGO_EMPRESA  = 2;     // CODEMP

/** Mapeamento metodo_pagamento (Supabase) → codTipVenda (Sankhya) */
const COD_TIP_VENDA: Record<string, number> = {
  boleto:  87,
  cartao:  86,
  cartão:  86,
  pix:     140,
};

const HTTP_TIMEOUT_MS = 25_000;
const DEADLINE_MS     = 130_000;
const BATCH_SIZE      = 3; // conservador: cada pedido gera múltiplas chamadas

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------
interface PedidoRow {
  id:               number;
  cliente_id:       string;
  vlr_total:        number;
  vlr_frete:        number | null;
  dt_pedido:        string;
  metodo_pagamento: string | null;
}

interface PedidoItemRow {
  codprod:      number;
  quantidade:   number;
  vlr_unitario: number;
}

interface ResultadoPedido {
  pedido_id: number;
  acao:      'integrado' | 'sem_codparc' | 'sem_pagamento' | 'erro';
  nunota?:   number;
  erro?:     string;
}

// ---------------------------------------------------------------------------
// Auth Sankhya — OAuth 2.0 Client Credentials
// ---------------------------------------------------------------------------
async function getSankhyaToken(): Promise<string> {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(Deno.env.get('SANKHYA_AUTH_URL')!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Token': Deno.env.get('SANKHYA_X_TOKEN')!,
      },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     Deno.env.get('SANKHYA_CLIENT_ID')!,
        client_secret: Deno.env.get('SANKHYA_CLIENT_SECRET')!,
      }).toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Auth falhou: ${res.status} ${await res.text()}`);
    const { access_token } = await res.json();
    if (!access_token) throw new Error('access_token não recebido');
    return access_token;
  } finally {
    clearTimeout(tid);
  }
}

function getApiBase(authUrl: string): string {
  const u = new URL(authUrl);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// Helpers de data/hora — Sankhya espera DD/MM/AAAA e HH:MM:SS
// ---------------------------------------------------------------------------
function formatarData(iso: string): string {
  const d = new Date(iso);
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatarHora(iso: string): string {
  const d  = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mi}:${ss}`;
}

// ---------------------------------------------------------------------------
// Cria pedido de venda no Sankhya
// POST /v1/vendas/pedidos
// Retorna nunota (NUNOTA / codigoNota) gerado pelo ERP.
// ---------------------------------------------------------------------------
async function criarPedidoSankhya(
  token: string,
  apiBase: string,
  pedido: PedidoRow,
  itens: PedidoItemRow[],
  codparc: number,
): Promise<{ nunota: number; resposta: unknown }> {
  const metodoPag  = (pedido.metodo_pagamento ?? '').toLowerCase().trim();
  const codTipVenda = COD_TIP_VENDA[metodoPag];

  if (!codTipVenda) {
    throw new Error(`Método de pagamento não mapeado: '${pedido.metodo_pagamento}'`);
  }

  const payload: Record<string, unknown> = {
    notaModelo:     NOTA_MODELO,
    data:           formatarData(pedido.dt_pedido),
    hora:           formatarHora(pedido.dt_pedido),
    codigoVendedor: CODIGO_VENDEDOR,
    codigoCliente:  codparc,
    valorTotal:     Number(pedido.vlr_total),
    // Frete só enviado se existir e > 0
    ...(pedido.vlr_frete && Number(pedido.vlr_frete) > 0
      ? { valorFrete: Number(pedido.vlr_frete) }
      : {}),
    itens: itens.map(item => ({
      codigoProduto: item.codprod,
      quantidade:    Number(item.quantidade),
      valorUnitario: Number(item.vlr_unitario),
    })),
    financeiros: [{
      codTipVenda,
      valor: Number(pedido.vlr_total),
    }],
  };

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/vendas/pedidos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const msg = (data?.mensagem ?? data?.message ?? JSON.stringify(data)) as string;
      throw new Error(`POST /v1/vendas/pedidos falhou: ${res.status} — ${msg}`);
    }

    // O response pode usar codigoNota, nunota ou codigoPedido dependendo da versão
    const nunota =
      (data?.codigoNota     as number | undefined) ??
      (data?.nunota         as number | undefined) ??
      (data?.codigoPedido   as number | undefined);

    if (!nunota) {
      throw new Error(`nunota não encontrado no response: ${JSON.stringify(data)}`);
    }

    return { nunota, resposta: data };
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Cancela pedido no Sankhya
// POST /v1/vendas/pedidos/{nunota}/cancela
// ---------------------------------------------------------------------------
async function cancelarPedidoSankhya(
  token: string,
  apiBase: string,
  nunota: number,
  motivo: string,
): Promise<void> {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/vendas/pedidos/${nunota}/cancela`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({ motivo }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /v1/vendas/pedidos/${nunota}/cancela falhou: ${res.status} — ${text}`);
    }
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Processa um pedido: busca cliente/itens → cria no Sankhya → atualiza Supabase
// ---------------------------------------------------------------------------
async function processarPedido(
  token: string,
  apiBase: string,
  supabase: ReturnType<typeof createClient>,
  pedido: PedidoRow,
): Promise<ResultadoPedido> {
  // 1. Verifica método de pagamento antes de qualquer chamada externa
  const metodoPag = (pedido.metodo_pagamento ?? '').toLowerCase().trim();
  if (!COD_TIP_VENDA[metodoPag]) {
    const msg = `Método de pagamento não mapeado: '${pedido.metodo_pagamento}'`;
    await supabase.from('pedido').update({ log_erro_integracao: msg }).eq('id', pedido.id);
    return { pedido_id: pedido.id, acao: 'sem_pagamento', erro: msg };
  }

  // 2. Busca codparc do cliente
  const { data: clienteData, error: cliErr } = await supabase
    .from('cliente')
    .select('codparc')
    .eq('id', pedido.cliente_id)
    .single();

  if (cliErr || !clienteData) {
    const msg = `Cliente não encontrado: ${cliErr?.message ?? 'sem dados'}`;
    await supabase.from('pedido').update({ log_erro_integracao: msg }).eq('id', pedido.id);
    return { pedido_id: pedido.id, acao: 'erro', erro: msg };
  }

  if (!clienteData.codparc) {
    const msg = 'Cliente sem codparc — aguardando integração de clientes';
    await supabase.from('pedido').update({ log_erro_integracao: msg }).eq('id', pedido.id);
    return { pedido_id: pedido.id, acao: 'sem_codparc' };
  }

  // 3. Busca itens do pedido
  const { data: itens, error: itensErr } = await supabase
    .from('pedido_item')
    .select('codprod, quantidade, vlr_unitario')
    .eq('pedido_id', pedido.id);

  if (itensErr) throw new Error(`Falha ao buscar itens do pedido ${pedido.id}: ${itensErr.message}`);
  if (!itens?.length) throw new Error(`Pedido ${pedido.id} sem itens`);

  // 4. Envia ao Sankhya
  let nunota: number;
  let resposta: unknown;

  try {
    const result = await criarPedidoSankhya(token, apiBase, pedido, itens, clienteData.codparc);
    nunota   = result.nunota;
    resposta = result.resposta;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Loga a tentativa falha
    await supabase.from('log_integracao_pedido').insert({
      pedido_id:         pedido.id,
      status:            'erro',
      payload_enviado:   buildPayloadLog(pedido, itens, clienteData.codparc),
      resposta_recebida: { erro: msg },
    });
    await supabase.from('pedido').update({ log_erro_integracao: msg }).eq('id', pedido.id);
    return { pedido_id: pedido.id, acao: 'erro', erro: msg };
  }

  // 5. Sucesso — persiste nunota e limpa erro anterior
  const { error: updErr } = await supabase
    .from('pedido')
    .update({ nunota, status: 'integrado', log_erro_integracao: null })
    .eq('id', pedido.id);

  if (updErr) throw new Error(`Falha ao atualizar pedido ${pedido.id}: ${updErr.message}`);

  // 6. Log de sucesso
  await supabase.from('log_integracao_pedido').insert({
    pedido_id:         pedido.id,
    status:            'sucesso',
    payload_enviado:   buildPayloadLog(pedido, itens, clienteData.codparc),
    resposta_recebida: resposta,
  });

  return { pedido_id: pedido.id, acao: 'integrado', nunota };
}

/** Monta o payload como objeto (para log — não faz fetch) */
function buildPayloadLog(
  pedido: PedidoRow,
  itens: PedidoItemRow[],
  codparc: number,
): Record<string, unknown> {
  const metodoPag   = (pedido.metodo_pagamento ?? '').toLowerCase().trim();
  const codTipVenda = COD_TIP_VENDA[metodoPag];
  return {
    notaModelo:     NOTA_MODELO,
    data:           formatarData(pedido.dt_pedido),
    hora:           formatarHora(pedido.dt_pedido),
    codigoVendedor: CODIGO_VENDEDOR,
    codigoCliente:  codparc,
    valorTotal:     Number(pedido.vlr_total),
    ...(pedido.vlr_frete && Number(pedido.vlr_frete) > 0
      ? { valorFrete: Number(pedido.vlr_frete) }
      : {}),
    itens: itens.map(item => ({
      codigoProduto: item.codprod,
      quantidade:    Number(item.quantidade),
      valorUnitario: Number(item.vlr_unitario),
    })),
    financeiros: [{ codTipVenda, valor: Number(pedido.vlr_total) }],
  };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const url      = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, ''); // remove trailing slash

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // -------------------------------------------------------------------------
  // Rota: POST .../integrar-pedidos/cancelar
  // Body: { pedido_id: number, motivo?: string }
  // -------------------------------------------------------------------------
  if (pathname.endsWith('/cancelar') && req.method === 'POST') {
    let body: { pedido_id?: number; motivo?: string };
    try { body = await req.json(); } catch { return json({ error: 'Body JSON inválido' }, 400); }

    const { pedido_id, motivo } = body ?? {};
    if (!pedido_id) return json({ error: 'pedido_id obrigatório' }, 400);

    // Busca nunota do pedido
    const { data: pedidoData, error: pedidoErr } = await supabase
      .from('pedido')
      .select('nunota, status')
      .eq('id', pedido_id)
      .single();

    if (pedidoErr || !pedidoData) return json({ error: 'Pedido não encontrado' }, 404);
    if (!pedidoData.nunota)       return json({ error: 'Pedido sem nunota — não integrado no Sankhya' }, 400);

    try {
      const token   = await getSankhyaToken();
      const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);
      await cancelarPedidoSankhya(token, apiBase, pedidoData.nunota, motivo ?? 'Cancelamento solicitado');

      await supabase
        .from('pedido')
        .update({ status: 'cancelado' })
        .eq('id', pedido_id);

      await supabase.from('log_integracao_pedido').insert({
        pedido_id,
        status:            'cancelado',
        payload_enviado:   { nunota: pedidoData.nunota, motivo },
        resposta_recebida: { ok: true },
      });

      return json({ success: true, pedido_id, nunota: pedidoData.nunota });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ success: false, error: msg }, 500);
    }
  }

  // -------------------------------------------------------------------------
  // Rota principal: POST .../integrar-pedidos
  // Processa em lote todos os pedidos com status='pago' e nunota IS NULL
  // -------------------------------------------------------------------------
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405);

  const startTime = Date.now();

  const { data: logRow, error: logErr } = await supabase
    .from('log_sincronizacao')
    .insert({ entidade: 'pedido', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    // Busca pedidos elegíveis: status='pago' e ainda não integrados (nunota IS NULL)
    const { data: pedidosRaw, error: pedErr } = await supabase
      .from('pedido')
      .select('id, cliente_id, vlr_total, vlr_frete, dt_pedido, metodo_pagamento')
      .eq('status', 'pago')
      .is('nunota', null);

    if (pedErr) throw new Error(`Falha ao buscar pedidos: ${pedErr.message}`);

    const pedidos = pedidosRaw ?? [];
    const total   = pedidos.length;

    if (total === 0) {
      await supabase
        .from('log_sincronizacao')
        .update({ status: 'sucesso', registros_processados: 0, finalizado_em: new Date().toISOString() })
        .eq('id', logId);
      return json({ success: true, status: 'sucesso', mensagem: 'Nenhum pedido pendente de integração.', total_pedidos: 0 });
    }

    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    const resultados: ResultadoPedido[] = [];
    let deadlineAtingido = false;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (Date.now() - startTime > DEADLINE_MS) {
        deadlineAtingido = true;
        break;
      }

      const lote = pedidos.slice(i, i + BATCH_SIZE);

      // Processa em série dentro do lote (pedidos podem depender de codparc
      // que esteja sendo reconciliado na mesma execução)
      for (const p of lote) {
        if (Date.now() - startTime > DEADLINE_MS) { deadlineAtingido = true; break; }
        const resultado = await processarPedido(token, apiBase, supabase, p as PedidoRow);
        resultados.push(resultado);
      }

      if (deadlineAtingido) break;
    }

    const integrados    = resultados.filter(r => r.acao === 'integrado').length;
    const semCodparc    = resultados.filter(r => r.acao === 'sem_codparc').length;
    const semPagamento  = resultados.filter(r => r.acao === 'sem_pagamento').length;
    const erros         = resultados.filter(r => r.acao === 'erro');
    const totalOk       = integrados;

    const statusFinal = erros.length > 0 && totalOk === 0
      ? 'erro'
      : deadlineAtingido ? 'parcial' : 'sucesso';

    await supabase
      .from('log_sincronizacao')
      .update({
        status: statusFinal,
        registros_processados: totalOk,
        mensagem_erro: erros.length > 0
          ? erros.map(e => `[pedido ${e.pedido_id}] ${e.erro}`).join(' | ')
          : null,
        finalizado_em: new Date().toISOString(),
      })
      .eq('id', logId);

    return json({
      success:         true,
      status:          statusFinal,
      total_elegiveis: total,
      integrados,
      sem_codparc:     semCodparc,
      sem_pagamento:   semPagamento,
      erros:           erros.length,
      detalhes_erros:  erros.map(e => ({ pedido_id: e.pedido_id, erro: e.erro })),
      tempo_ms:        Date.now() - startTime,
      ...(deadlineAtingido && { aviso: `Deadline atingido. ${total - resultados.length} pedidos não processados.` }),
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('log_sincronizacao')
      .update({ status: 'erro', mensagem_erro: msg, finalizado_em: new Date().toISOString() })
      .eq('id', logId);
    return json({ success: false, error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Utilitário de resposta
// ---------------------------------------------------------------------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
