import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Tabela de preço do e-commerce no Sankhya
const CODTAB = 201;

interface PrecoRow {
  codprod: number;
  vlr_venda: number;
  codtab: number;
}

// Snapshot do Supabase usado para comparação incremental
interface ExistenteRow {
  vlr_venda: number | null;
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
): PrecoRow | null {
  const codprod = Number(getField(entity, 'CODPROD', fieldMap));
  if (!codprod || isNaN(codprod)) return null;

  // Ignora produtos que não estão na tabela produto (não têm AD_SYNCSITE='S')
  if (!produtosConhecidos.has(codprod)) return null;

  const vlr_venda = toNumeric(getField(entity, 'VLRVENDA', fieldMap));
  if (vlr_venda === null) return null;

  return { codprod, vlr_venda, codtab: CODTAB };
}

// ---------------------------------------------------------------------------
// Decide se o preço precisa de upsert.
// Atualiza se:
//   1. Produto não tem preço registrado no Supabase (novo)
//   2. vlr_venda mudou
// ---------------------------------------------------------------------------
function precisaAtualizar(sankhya: PrecoRow, existente: ExistenteRow | undefined): boolean {
  if (existente === undefined) return true;
  if (existente.vlr_venda === null) return true;
  if (sankhya.vlr_venda !== existente.vlr_venda) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Busca página do Sankhya via loadRecords — TGFPRC filtrada por CODTAB
// Usa offsetPage base-0 (padrão do loadRecords)
// ---------------------------------------------------------------------------
async function fetchPagina(
  token: string,
  apiBase: string,
  page: number,
): Promise<{ precos: Array<Record<string, unknown>>; fieldMap: Record<string, number>; hasMore: boolean }> {
  const body = {
    serviceName: 'CRUDServiceProvider.loadRecords',
    requestBody: {
      dataSet: {
        rootEntity: 'PrecoProduto',
        ignoreCalculatedFields: 'true',
        offsetPage: String(page),
        criteria: {
          expression: { $: 'CODTAB = ?' },
          parameter: [
            { $: String(CODTAB), type: 'I' },
          ],
        },
        entity: [{
          path: '',
          fieldset: {
            list: 'CODPROD,VLRVENDA,CODTAB',
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
    precos: rawList,
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
    .insert({ entidade: 'preco', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Snapshot do Supabase para comparação incremental
    const { data: existentes, error: existErr } = await supabase
      .from('preco')
      .select('codprod, vlr_venda')
      .eq('codtab', CODTAB);
    if (existErr) throw new Error(`Falha ao carregar preços: ${existErr.message}`);

    const mapaLocal = new Map<number, ExistenteRow>(
      (existentes ?? []).map(p => [p.codprod as number, {
        vlr_venda: p.vlr_venda as number | null,
      }])
    );

    // Apenas produtos com AD_SYNCSITE='S'
    const { data: produtos, error: prodErr } = await supabase
      .from('produto')
      .select('codprod');
    if (prodErr) throw new Error(`Falha ao carregar produtos: ${prodErr.message}`);

    const produtosConhecidos = new Set<number>(
      (produtos ?? []).map(p => p.codprod as number)
    );

    let page            = 0; // loadRecords usa base-0
    let totalProcessado = 0;
    let totalIgnorado   = 0;
    let hasMore         = true;

    while (hasMore) {
      const { precos: rawList, fieldMap, hasMore: more } = await fetchPagina(token, apiBase, page);
      hasMore = more;
      page++;

      const pagResult = rawList
        .map(e => normalizar(e, fieldMap, produtosConhecidos))
        .filter((e): e is PrecoRow => e !== null);

      const aAtualizar = pagResult.filter(p => precisaAtualizar(p, mapaLocal.get(p.codprod)));
      totalIgnorado += pagResult.length - aAtualizar.length;

      if (aAtualizar.length === 0) continue;

      const payload = aAtualizar.map(p => ({ ...p, dtalter: new Date().toISOString() }));

      const { error: upsertErr } = await supabase
        .from('preco')
        .upsert(payload, { onConflict: 'codprod,codtab' });
      if (upsertErr) throw new Error(`Upsert falhou: ${upsertErr.message}`);

      totalProcessado += aAtualizar.length;
    }

    await supabase
      .from('log_sincronizacao')
      .update({ status: 'sucesso', registros_processados: totalProcessado, finalizado_em: new Date().toISOString() })
      .eq('id', logId);

    return json({ success: true, registros_processados: totalProcessado, registros_ignorados: totalIgnorado });

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
