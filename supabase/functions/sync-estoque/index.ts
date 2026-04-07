import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface EstoqueRow {
  codprod: number;
  estoque_real: number;
  // estoque_disponivel é GENERATED ALWAYS AS (estoque_real * proporcao) — calculado pelo banco
}

// Snapshot do Supabase — apenas estoque_real para comparação incremental
// proporcao e estoque_disponivel são gerenciados pelo banco
interface ExistenteRow {
  estoque_real: number | null;
}

// ---------------------------------------------------------------------------
// Auth Sankhya
// ---------------------------------------------------------------------------
async function getSankhyaToken(): Promise<string> {
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
  });
  if (!res.ok) throw new Error(`Auth Sankhya falhou: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('access_token não recebido');
  return access_token;
}

function getApiBase(authUrl: string): string {
  const u = new URL(authUrl);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// Parsing posicional (f0, f1, f2...)
// ---------------------------------------------------------------------------
function buildFieldMap(metadata: unknown): Record<string, number> {
  const map: Record<string, number> = {};
  const list = ((metadata as Record<string,unknown>)?.fields as Record<string,unknown>)?.field;
  if (Array.isArray(list)) {
    list.forEach((f: Record<string, unknown>, i: number) => {
      if (f.name) map[String(f.name)] = i;
    });
  }
  return map;
}

function getField(
  entity: Record<string, unknown>,
  fieldName: string,
  fieldMap: Record<string, number>,
): string | null {
  const pos = fieldMap[fieldName];
  if (pos === undefined) return null;
  const cell = entity[`f${pos}`];
  if (!cell || typeof cell !== 'object') return null;
  const val = (cell as Record<string, unknown>)['$'];
  if (val === undefined || val === null || val === '') return null;
  return String(val);
}

function toNumeric(val: string | null): number | null {
  if (!val) return null;
  const n = parseFloat(val.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function normalizar(
  entity: Record<string, unknown>,
  fieldMap: Record<string, number>,
  produtosConhecidos: Set<number>,
): EstoqueRow | null {
  const codprod = Number(getField(entity, 'CODPROD', fieldMap));
  if (!codprod || isNaN(codprod)) return null;

  // Ignora produtos que não estão na tabela produto (não têm AD_SYNCSITE='S')
  if (!produtosConhecidos.has(codprod)) return null;

  const estoque_real = toNumeric(getField(entity, 'ESTOQUE', fieldMap)) ?? 0;

  return { codprod, estoque_real };
}

// ---------------------------------------------------------------------------
// Decide se o estoque precisa de upsert.
// Atualiza se:
//   1. Produto não tem registro de estoque no Supabase (novo)
//   2. estoque_real mudou no Sankhya
// ---------------------------------------------------------------------------
function precisaAtualizar(sankhya: EstoqueRow, existente: ExistenteRow | undefined): boolean {
  if (existente === undefined) return true;
  if (existente.estoque_real === null) return true;
  if (sankhya.estoque_real !== existente.estoque_real) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Busca página do Sankhya — TGFEST filtrado por CODEMP=1 e CODLOCAL=109
// ---------------------------------------------------------------------------
async function fetchPagina(
  token: string,
  apiBase: string,
  page: number,
): Promise<{ estoques: Array<Record<string, unknown>>; fieldMap: Record<string, number>; hasMore: boolean }> {
  const body = {
    serviceName: 'CRUDServiceProvider.loadRecords',
    requestBody: {
      dataSet: {
        rootEntity: 'Estoque',
        ignoreCalculatedFields: 'true',
        offsetPage: String(page),
        criteria: {
          expression: { $: 'CODEMP = ? AND CODLOCAL = ?' },
          parameter: [
            { $: '1',   type: 'I' },
            { $: '109', type: 'I' },
          ],
        },
        entity: [{
          path: '',
          fieldset: {
            list: 'CODPROD,ESTOQUE',
          },
        }],
      },
    },
  };

  const url = `${apiBase}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`loadRecords falhou: ${res.status} ${await res.text()}`);

  const data = await res.json();
  if (data.status !== '1' && data.status !== 1) {
    throw new Error(`Sankhya erro: ${JSON.stringify(data.statusMessage ?? data.error ?? data)}`);
  }

  const entities = data?.responseBody?.entities;
  const fieldMap = buildFieldMap(entities?.metadata);
  const rawList: Record<string, unknown>[] = Array.isArray(entities?.entity)
    ? entities.entity
    : (entities?.entity ? [entities.entity] : []);

  return {
    estoques: rawList,
    fieldMap,
    hasMore: entities?.hasMoreResult === 'true' || entities?.hasMoreResult === true,
  };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: logRow, error: logErr } = await supabase
    .from('log_sincronizacao')
    .insert({ entidade: 'estoque', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Carrega snapshot do Supabase para comparação incremental
    const { data: existentes, error: existErr } = await supabase
      .from('estoque')
      .select('codprod, estoque_real');
    if (existErr) throw new Error(`Falha ao carregar estoques: ${existErr.message}`);

    const mapaLocal = new Map<number, ExistenteRow>(
      (existentes ?? []).map(e => [e.codprod as number, {
        estoque_real: e.estoque_real as number | null,
      }])
    );

    // Carrega codprod conhecidos (apenas produtos com AD_SYNCSITE='S')
    // para ignorar estoques de produtos fora do escopo do e-commerce
    const { data: produtos, error: prodErr } = await supabase
      .from('produto')
      .select('codprod');
    if (prodErr) throw new Error(`Falha ao carregar produtos: ${prodErr.message}`);

    const produtosConhecidos = new Set<number>(
      (produtos ?? []).map(p => p.codprod as number)
    );

    // Coleta todas as páginas primeiro — necessário para identificar ausentes (zerados)
    const todasSankhya: EstoqueRow[] = [];
    let page    = 0;
    let hasMore = true;

    while (hasMore) {
      const { estoques: rawList, fieldMap, hasMore: more } = await fetchPagina(token, apiBase, page);
      hasMore = more;
      page++;

      const pagina = rawList
        .map(e => normalizar(e, fieldMap, produtosConhecidos))
        .filter((e): e is EstoqueRow => e !== null);

      todasSankhya.push(...pagina);
    }

    // Produtos presentes no Sankhya com estoque > 0
    const sankhyaSet = new Set(todasSankhya.map(e => e.codprod));

    // Produtos que estavam com estoque > 0 no Supabase mas sumiram do Sankhya
    // (linha removida da TGFEST quando estoque chega a zero) → zerar
    const aZerar: EstoqueRow[] = [];
    for (const [codprod, existente] of mapaLocal.entries()) {
      if (!sankhyaSet.has(codprod) && (existente.estoque_real ?? 0) > 0) {
        aZerar.push({ codprod, estoque_real: 0 });
      }
    }

    // Produtos com estoque alterado no Sankhya
    const aAtualizar = todasSankhya.filter(e => precisaAtualizar(e, mapaLocal.get(e.codprod)));

    const totalIgnorado = todasSankhya.length - aAtualizar.length;
    const loteUpsert   = [...aAtualizar, ...aZerar];

    let totalProcessado = 0;

    if (loteUpsert.length > 0) {
      // Upsert apenas codprod e estoque_real
      // proporcao NÃO é incluída (preserva valor manual)
      // estoque_disponivel NÃO é incluído (GENERATED ALWAYS pelo banco)
      const { error: upsertErr } = await supabase
        .from('estoque')
        .upsert(loteUpsert, { onConflict: 'codprod' });
      if (upsertErr) throw new Error(`Upsert falhou: ${upsertErr.message}`);
      totalProcessado = loteUpsert.length;
    }

    await supabase
      .from('log_sincronizacao')
      .update({ status: 'sucesso', registros_processados: totalProcessado, finalizado_em: new Date().toISOString() })
      .eq('id', logId);

    return json({
      success: true,
      registros_processados: totalProcessado,
      registros_ignorados:   totalIgnorado,
      zerados:               aZerar.length,
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
