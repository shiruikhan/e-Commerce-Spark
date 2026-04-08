import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const LIMIT_PAG      = 500;   // registros por página no Sankhya
const DEADLINE_MS    = 130_000;
const HTTP_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
interface EspecRow {
  id_espec: number;
  codprod:  number;
  label:    string;
  valor:    string;
}

// ---------------------------------------------------------------------------
// Auth Sankhya
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
// Parsing posicional (f0, f1...)
// ---------------------------------------------------------------------------
function buildFieldMap(metadata: unknown): Record<string, number> {
  const map: Record<string, number> = {};
  const list = ((metadata as Record<string, unknown>)?.fields as Record<string, unknown>)?.field;
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

// ---------------------------------------------------------------------------
// Busca uma página da AD_PROESP sem filtro (busca toda a tabela)
// Usamos sync completo pois AD_PROESP não tem campo de data de alteração.
// ---------------------------------------------------------------------------
async function fetchPagina(
  token: string,
  apiBase: string,
  page: number,
): Promise<{ registros: Array<Record<string, unknown>>; fieldMap: Record<string, number>; hasMore: boolean }> {
  const body = {
    serviceName: 'CRUDServiceProvider.loadRecords',
    requestBody: {
      dataSet: {
        rootEntity: 'AD_PROESP',
        ignoreCalculatedFields: 'true',
        offsetPage: String(page),
        limitPag: String(LIMIT_PAG),
        entity: [{ path: '', fieldset: { list: 'NUESP,CODPROD,TIPESP,VLRESP' } }],
      },
    },
  };

  const url  = `${apiBase}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json`;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`loadRecords AD_PROESP falhou: ${res.status} ${await res.text()}`);

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
      registros: rawList,
      fieldMap,
      hasMore: entities?.hasMoreResult === 'true' || entities?.hasMoreResult === true,
    };
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Normaliza um registro do Sankhya para o formato Supabase.
// Retorna null se campos obrigatórios estiverem ausentes ou o produto
// não pertencer ao conjunto de produtos ativos (AD_SYNCSITE='S').
// ---------------------------------------------------------------------------
function normalizar(
  entity: Record<string, unknown>,
  fieldMap: Record<string, number>,
  produtosConhecidos: Set<number>,
): EspecRow | null {
  const nuesp   = Number(getField(entity, 'NUESP',   fieldMap));
  const codprod = Number(getField(entity, 'CODPROD', fieldMap));
  const tipesp  = getField(entity, 'TIPESP', fieldMap);
  const vlresp  = getField(entity, 'VLRESP', fieldMap);

  if (!nuesp || isNaN(nuesp))   return null;
  if (!codprod || isNaN(codprod)) return null;
  if (!tipesp || !vlresp)        return null;
  if (!produtosConhecidos.has(codprod)) return null;

  return { id_espec: nuesp, codprod, label: tipesp, valor: vlresp };
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
    .insert({ entidade: 'especificacao', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Produtos ativos no Supabase (AD_SYNCSITE='S')
    const { data: produtos, error: prodErr } = await supabase
      .from('produto')
      .select('codprod');
    if (prodErr) throw new Error(`Falha ao carregar produtos: ${prodErr.message}`);

    const produtosConhecidos = new Set<number>(
      (produtos ?? []).map(p => p.codprod as number),
    );

    // Coleta todas as especificações do Sankhya em memória
    const especsSankhya = new Map<number, EspecRow>(); // key = id_espec (NUESP)
    let page             = 0;
    let hasMore          = true;
    let deadlineAtingido = false;

    while (hasMore) {
      if (Date.now() - startTime > DEADLINE_MS) {
        deadlineAtingido = true;
        break;
      }

      const { registros, fieldMap, hasMore: more } = await fetchPagina(token, apiBase, page);
      hasMore = more;
      page++;

      for (const e of registros) {
        const row = normalizar(e, fieldMap, produtosConhecidos);
        if (row) especsSankhya.set(row.id_espec, row);
      }
    }

    if (deadlineAtingido) {
      const msg = `Deadline atingido após ${page} páginas. Sync parcial — abortando sem alterar o banco.`;
      await supabase.from('log_sincronizacao').update({
        status: 'parcial', mensagem_erro: msg, finalizado_em: new Date().toISOString(),
      }).eq('id', logId);
      return json({ success: false, status: 'parcial', aviso: msg });
    }

    // Snapshot atual no Supabase (apenas para produtos conhecidos)
    const { data: especsLocais, error: localErr } = await supabase
      .from('especificacao')
      .select('id_espec, codprod, label, valor')
      .in('codprod', [...produtosConhecidos]);
    if (localErr) throw new Error(`Falha ao carregar especificações locais: ${localErr.message}`);

    const mapaLocal = new Map<number, EspecRow>(
      (especsLocais ?? []).map(e => [e.id_espec as number, e as EspecRow]),
    );

    // Identifica registros a upsert (novos ou alterados)
    const aUpsert: EspecRow[] = [];
    for (const [id_espec, sankhya] of especsSankhya) {
      const local = mapaLocal.get(id_espec);
      if (!local || local.label !== sankhya.label || local.valor !== sankhya.valor || local.codprod !== sankhya.codprod) {
        aUpsert.push(sankhya);
      }
    }

    // Identifica registros a deletar (existem no Supabase mas sumiram do Sankhya)
    const aExcluir: number[] = [];
    for (const [id_espec] of mapaLocal) {
      if (!especsSankhya.has(id_espec)) {
        aExcluir.push(id_espec);
      }
    }

    // Executa upsert em lotes de 200
    let totalUpsert = 0;
    for (let i = 0; i < aUpsert.length; i += 200) {
      const lote = aUpsert.slice(i, i + 200);
      const { error: uErr } = await supabase
        .from('especificacao')
        .upsert(lote, { onConflict: 'id_espec' });
      if (uErr) throw new Error(`Upsert especificacao falhou: ${uErr.message}`);
      totalUpsert += lote.length;
    }

    // Executa delete em lotes de 200
    let totalDelete = 0;
    for (let i = 0; i < aExcluir.length; i += 200) {
      const lote = aExcluir.slice(i, i + 200);
      const { error: dErr } = await supabase
        .from('especificacao')
        .delete()
        .in('id_espec', lote);
      if (dErr) throw new Error(`Delete especificacao falhou: ${dErr.message}`);
      totalDelete += lote.length;
    }

    await supabase.from('log_sincronizacao').update({
      status: 'sucesso',
      registros_processados: totalUpsert,
      finalizado_em: new Date().toISOString(),
    }).eq('id', logId);

    return json({
      success: true,
      status: 'sucesso',
      total_sankhya: especsSankhya.size,
      atualizados: totalUpsert,
      removidos:   totalDelete,
      sem_alteracao: especsSankhya.size - aUpsert.length,
      paginas_lidas: page,
      tempo_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from('log_sincronizacao').update({
      status: 'erro', mensagem_erro: msg, finalizado_em: new Date().toISOString(),
    }).eq('id', logId);
    return json({ success: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
