import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Código da tabela de preços do e-commerce (COTAB na entidade TabelaPreco / TGFTAB)
const CODTAB = 201;

// Quantos produtos processar em paralelo por rodada
// 82 produtos / 10 por lote = ~9 lotes, ~2-3s cada = ~20-30s total (bem dentro do limite)
const BATCH_SIZE = 10;

// Guard: encerra graciosamente antes dos 150s do runtime
const DEADLINE_MS = 130_000;

// Timeout por chamada HTTP individual ao Sankhya
const HTTP_TIMEOUT_MS = 15_000;

interface PrecoRow {
  codprod: number;
  vlr_venda: number;
  codtab: number;
}

// ---------------------------------------------------------------------------
// Auth Sankhya — OAuth 2.0 Client Credentials
// ---------------------------------------------------------------------------
async function getSankhyaToken(): Promise<string> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
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
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Auth Sankhya falhou: ${res.status} ${await res.text()}`);
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
// Busca o preço de um produto na tabela de preços
// Endpoint: GET /v1/precos/produto/{codprod}/tabela/{codtab}?pagina=1
//
// Response:
// {
//   "codigo": "200",
//   "pagina": 1,
//   "temMaisRegistros": false,
//   "produtos": [
//     { "codigoProduto": 313407, "codigoLocalEstoque": 0, "controle": " ", "unidade": "UN", "valor": 1999 }
//   ]
// }
//
// Notas:
// - Paginação base-1 (pagina=1 é a primeira)
// - Um produto pode ter múltiplos registros (por localEstoque ou controle/variante)
//   → Prioriza codigoLocalEstoque=0 (preço base); fallback para o primeiro registro
// - "valor" é o preço de venda (número)
// - Retorna null se o produto não tiver preço cadastrado nessa tabela
// ---------------------------------------------------------------------------
async function fetchPreco(
  token: string,
  apiBase: string,
  codprod: number,
): Promise<PrecoRow | null> {
  let pagina = 1;

  while (true) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let data: Record<string, unknown>;
    try {
      const res = await fetch(
        `${apiBase}/v1/precos/produto/${codprod}/tabela/${CODTAB}?pagina=${pagina}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' },
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        // Produto sem preço nessa tabela — não é erro crítico
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      data = await res.json() as Record<string, unknown>;
    } finally {
      clearTimeout(tid);
    }

    const produtos = data?.produtos as Array<Record<string, unknown>> | undefined;
    if (!produtos?.length) return null;

    // Prioriza preço base (codigoLocalEstoque = 0); fallback para o primeiro registro
    const registro =
      produtos.find(p => p.codigoLocalEstoque === 0) ?? produtos[0];

    const valor = registro?.valor;
    if (valor === undefined || valor === null) return null;

    const vlr = typeof valor === 'number' ? valor : parseFloat(String(valor));
    if (isNaN(vlr)) return null;

    // Se houver mais páginas, elas contêm variantes (controle/local de estoque).
    // Para e-commerce só precisamos do preço base — retorna já.
    return { codprod, vlr_venda: vlr, codtab: CODTAB };
  }
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
Deno.serve(async (_req: Request) => {
  const startTime = Date.now();

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: logRow, error: logErr } = await supabase
    .from('log_sincronizacao')
    .insert({ entidade: 'preco', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Snapshot local para comparação incremental (evita upserts desnecessários)
    const { data: existentes, error: existErr } = await supabase
      .from('preco')
      .select('codprod, vlr_venda')
      .eq('codtab', CODTAB);
    if (existErr) throw new Error(`Falha ao carregar preços locais: ${existErr.message}`);

    const mapaLocal = new Map<number, number | null>(
      (existentes ?? []).map(p => [p.codprod as number, p.vlr_venda as number | null]),
    );

    // Lista de produtos ativos (AD_SYNCSITE='S')
    const { data: produtos, error: prodErr } = await supabase
      .from('produto')
      .select('codprod');
    if (prodErr) throw new Error(`Falha ao carregar produtos: ${prodErr.message}`);

    const listaProdutos = (produtos ?? []).map(p => p.codprod as number);
    const total = listaProdutos.length;

    let totalProcessado = 0;
    let totalSemPreco   = 0;
    let totalIgnorado   = 0;
    let totalErro       = 0;
    let deadlineAtingido = false;

    // Processa em lotes paralelos para concluir rápido sem sobrecarregar a API
    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (Date.now() - startTime > DEADLINE_MS) {
        deadlineAtingido = true;
        break;
      }

      const lote = listaProdutos.slice(i, i + BATCH_SIZE);

      const resultados = await Promise.allSettled(
        lote.map(codprod => fetchPreco(token, apiBase, codprod)),
      );

      const aUpsert: PrecoRow[] = [];

      for (let j = 0; j < lote.length; j++) {
        const codprod = lote[j];
        const res = resultados[j];

        if (res.status === 'rejected') {
          totalErro++;
          console.error(`Erro produto ${codprod}: ${res.reason}`);
          continue;
        }

        const preco = res.value;
        if (!preco) { totalSemPreco++; continue; }

        // Só faz upsert se o preço mudou ou é novo
        const vlrAtual = mapaLocal.get(codprod);
        if (vlrAtual !== undefined && vlrAtual === preco.vlr_venda) {
          totalIgnorado++;
          continue;
        }

        aUpsert.push(preco);
      }

      if (aUpsert.length > 0) {
        const payload = aUpsert.map(p => ({ ...p, dtalter: new Date().toISOString() }));
        const { error: upsertErr } = await supabase
          .from('preco')
          .upsert(payload, { onConflict: 'codprod,codtab' });
        if (upsertErr) throw new Error(`Upsert falhou: ${upsertErr.message}`);
        totalProcessado += aUpsert.length;
      }
    }

    const statusFinal = deadlineAtingido ? 'parcial' : 'sucesso';
    const mensagem = deadlineAtingido
      ? `Deadline atingido. Processados ${totalProcessado} de ${total} produtos.`
      : undefined;

    await supabase
      .from('log_sincronizacao')
      .update({
        status: statusFinal,
        registros_processados: totalProcessado,
        mensagem_erro: mensagem ?? null,
        finalizado_em: new Date().toISOString(),
      })
      .eq('id', logId);

    return json({
      success: true,
      status: statusFinal,
      total_produtos: total,
      registros_atualizados: totalProcessado,
      registros_ignorados: totalIgnorado,
      sem_preco_na_tabela: totalSemPreco,
      erros_individuais: totalErro,
      tempo_ms: Date.now() - startTime,
      ...(deadlineAtingido && { aviso: mensagem }),
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
