import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constantes fixas — confirmadas com o Sankhya em 25/05/2026
// ---------------------------------------------------------------------------
const NOTA_MODELO          = 793370; // Código do Modelo de Nota no Sankhya Om — pré-define CODEMP, TOP, CFOP
const CODIGO_VENDEDOR      = 6;      // Vendedor padrão e-commerce
const CODIGO_LOCAL_ESTOQUE = 109;    // CODLOCAL do estoque de saída (TGFEST)
const CONTROLE_ITEM        = ' ';    // Campo interno Sankhya; espaço fixo para todos os produtos
const TIPO_PAGAMENTO       = 53;     // CODTIPTIT fixo — recebimento único via intermediário

const HTTP_TIMEOUT_MS = 25_000;
const DEADLINE_MS     = 130_000;
const BATCH_SIZE      = 3;

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------
interface ClienteJoin {
  codparc: number;
}

interface PedidoRow {
  id:               number;
  cliente_id:       string;
  vlr_total:        number;
  vlr_frete:        number | null;
  dt_pedido:        string;
  metodo_pagamento: string | null;
  cliente:          ClienteJoin;
}

interface PedidoItemRow {
  codprod:      number;
  quantidade:   number;
  vlr_unitario: number;
  sequencia:    number | null;
}

interface ResultadoPedido {
  pedido_id: number;
  acao:      'integrado' | 'sem_codparc' | 'erro';
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
  const d    = new Date(iso);
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
  const payload: Record<string, unknown> = {
    notaModelo:     NOTA_MODELO,
    data:           formatarData(pedido.dt_pedido),
    hora:           formatarHora(pedido.dt_pedido),
    codigoVendedor: CODIGO_VENDEDOR,
    codigoCliente:  codparc,
    valorTotal:     Number(pedido.vlr_total),
    ...(pedido.vlr_frete && Number(pedido.vlr_frete) > 0
      ? { valorFrete: Number(pedido.vlr_frete) }
      : {}),
    itens: itens.map((item, idx) => ({
      sequencia:          item.sequencia ?? (idx + 1),
      codigoProduto:      item.codprod,
      quantidade:         Number(item.quantidade),
      valorUnitario:      Number(item.vlr_unitario),
      codigoLocalEstoque: CODIGO_LOCAL_ESTOQUE,
      controle:           CONTROLE_ITEM,
    })),
    financeiros: [{
      sequencia:      1,
      tipoPagamento:  TIPO_PAGAMENTO,
      dataVencimento: formatarData(pedido.dt_pedido),
      valorParcela:   Number(pedido.vlr_total),
      idTransacao:    `Pedido #${pedido.id} no e-commerce`,
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

    // Extrai o código do pedido — a API pode retornar em campos e tipos variados
    const rawNunota =
      (data?.codigoNota                                   as string | number | undefined) ??
      (data?.nunota                                       as string | number | undefined) ??
      (data?.codigoPedido                                 as string | number | undefined) ??
      ((data?.retorno as Record<string, unknown>)?.codigoPedido as string | number | undefined) ??
      (data?.codigo                                       as string | number | undefined);

    const nunota = rawNunota !== undefined ? Number(rawNunota) : undefined;

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
// Processa um pedido: busca itens → cria no Sankhya → atualiza Supabase
// codparc já resolvido pelo !inner join na query principal
// ---------------------------------------------------------------------------
async function processarPedido(
  token: string,
  apiBase: string,
  supabase: ReturnType<typeof createClient>,
  pedido: PedidoRow,
  codparc: number,
): Promise<ResultadoPedido> {
  // 1. Busca itens do pedido (com sequencia, ordenados)
  const { data: itens, error: itensErr } = await supabase
    .from('pedido_item')
    .select('codprod, quantidade, vlr_unitario, sequencia')
    .eq('pedido_id', pedido.id)
    .order('sequencia');

  if (itensErr) throw new Error(`Falha ao buscar itens do pedido ${pedido.id}: ${itensErr.message}`);
  if (!itens?.length) throw new Error(`Pedido ${pedido.id} sem itens`);

  // 2. Envia ao Sankhya
  let nunota: number;
  let resposta: unknown;

  try {
    const result = await criarPedidoSankhya(token, apiBase, pedido, itens, codparc);
    nunota   = result.nunota;
    resposta = result.resposta;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await supabase.from('log_integracao_pedido').insert({
      pedido_id:         pedido.id,
      status:            'erro',
      payload_enviado:   buildPayloadLog(pedido, itens, codparc),
      resposta_recebida: { erro: msg },
    });
    await supabase.from('pedido').update({ log_erro_integracao: msg }).eq('id', pedido.id);
    return { pedido_id: pedido.id, acao: 'erro', erro: msg };
  }

  // 3. Sucesso — persiste nunota e limpa erro anterior
  const { error: updErr } = await supabase
    .from('pedido')
    .update({ nunota, status: 'integrado', log_erro_integracao: null })
    .eq('id', pedido.id);

  if (updErr) throw new Error(`Falha ao atualizar pedido ${pedido.id}: ${updErr.message}`);

  // 4. Log de sucesso
  await supabase.from('log_integracao_pedido').insert({
    pedido_id:         pedido.id,
    status:            'sucesso',
    payload_enviado:   buildPayloadLog(pedido, itens, codparc),
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
    itens: itens.map((item, idx) => ({
      sequencia:          item.sequencia ?? (idx + 1),
      codigoProduto:      item.codprod,
      quantidade:         Number(item.quantidade),
      valorUnitario:      Number(item.vlr_unitario),
      codigoLocalEstoque: CODIGO_LOCAL_ESTOQUE,
      controle:           CONTROLE_ITEM,
    })),
    financeiros: [{
      sequencia:      1,
      tipoPagamento:  TIPO_PAGAMENTO,
      dataVencimento: formatarData(pedido.dt_pedido),
      valorParcela:   Number(pedido.vlr_total),
      idTransacao:    `Pedido #${pedido.id} no e-commerce`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const url      = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, '');

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
  // Processa em lote todos os pedidos com status='pago' e nunota IS NULL,
  // cujo cliente já tenha codparc (join !inner exclui os demais)
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
    // !inner exclui pedidos cujo cliente não tem codparc — codparc vem direto do JOIN
    const { data: pedidosRaw, error: pedErr } = await supabase
      .from('pedido')
      .select('id, cliente_id, vlr_total, vlr_frete, dt_pedido, metodo_pagamento, cliente!inner(codparc)')
      .eq('status', 'pago')
      .is('nunota', null)
      .not('cliente.codparc', 'is', null);

    if (pedErr) throw new Error(`Falha ao buscar pedidos: ${pedErr.message}`);

    const pedidos = (pedidosRaw ?? []) as PedidoRow[];
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

      for (const p of lote) {
        if (Date.now() - startTime > DEADLINE_MS) { deadlineAtingido = true; break; }
        const resultado = await processarPedido(token, apiBase, supabase, p, p.cliente.codparc);
        resultados.push(resultado);
      }

      if (deadlineAtingido) break;
    }

    const integrados = resultados.filter(r => r.acao === 'integrado').length;
    const erros      = resultados.filter(r => r.acao === 'erro');
    const totalOk    = integrados;

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
