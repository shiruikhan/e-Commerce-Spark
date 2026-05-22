import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
interface CidadeRow {
  codcid:  number;
  nomecid: string;
  uf:      string | null;
  codibge: number | null;
}

interface BairroRow {
  codbai:  number;
  nomebai: string;
  codcid:  number | null;
}

// ---------------------------------------------------------------------------
// Auth Sankhya — OAuth 2.0 Client Credentials
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
// Busca todas as páginas de uma entidade via loadRecords
// ---------------------------------------------------------------------------
async function fetchTodasPaginas(
  token: string,
  apiBase: string,
  rootEntity: string,
  fieldList: string,
): Promise<Array<Record<string, unknown>>> {
  const url = `${apiBase}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json`;
  const todos: Array<Record<string, unknown>> = [];
  let page = 0;

  while (true) {
    const body = {
      serviceName: 'CRUDServiceProvider.loadRecords',
      requestBody: {
        dataSet: {
          rootEntity,
          ignoreCalculatedFields: 'true',
          offsetPage: String(page),
          entity: [{ path: '', fieldset: { list: fieldList } }],
        },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`loadRecords ${rootEntity} p${page} falhou: ${res.status} ${await res.text()}`);

    const data = await res.json();
    if (data.status !== '1' && data.status !== 1) {
      throw new Error(`Sankhya erro ${rootEntity}: ${JSON.stringify(data.statusMessage ?? data.error ?? data)}`);
    }

    const entities = data?.responseBody?.entities;
    const rawList: Record<string, unknown>[] = Array.isArray(entities?.entity)
      ? entities.entity
      : (entities?.entity ? [entities.entity] : []);

    // Anexa fieldMap em cada registro para uso posterior
    const fieldMap = buildFieldMap(entities?.metadata);
    rawList.forEach(e => { (e as Record<string, unknown>).__fieldMap = fieldMap; });

    todos.push(...rawList);

    if (entities?.hasMoreResult !== 'true' && entities?.hasMoreResult !== true) break;
    page++;
  }

  return todos;
}

// ---------------------------------------------------------------------------
// Sincroniza cidades (TGFCID)
// ---------------------------------------------------------------------------
async function syncCidades(
  token: string,
  apiBase: string,
  supabase: ReturnType<typeof createClient>,
): Promise<number> {
  const raw = await fetchTodasPaginas(token, apiBase, 'Cidade', 'CODCID,NOMECID,UF,CODIBGE');

  const cidades: CidadeRow[] = [];
  for (const e of raw) {
    const fm = e.__fieldMap as Record<string, number>;
    const codcid = Number(getField(e, 'CODCID', fm));
    if (!codcid || isNaN(codcid)) continue;
    const nomecid = getField(e, 'NOMECID', fm);
    if (!nomecid) continue;
    const codibgeRaw = getField(e, 'CODIBGE', fm);
    const codibge = codibgeRaw ? Number(codibgeRaw) : null;
    cidades.push({ codcid, nomecid, uf: getField(e, 'UF', fm), codibge: codibge && !isNaN(codibge) ? codibge : null });
  }

  if (cidades.length === 0) return 0;

  // Deduplica por codcid (Sankhya pode retornar duplicatas na mesma página)
  const cidadesMap = new Map<number, CidadeRow>();
  for (const c of cidades) cidadesMap.set(c.codcid, c);
  const cidadesUnicas = Array.from(cidadesMap.values());

  // Upsert em lotes de 500 para não sobrecarregar o Supabase
  const LOTE = 500;
  for (let i = 0; i < cidadesUnicas.length; i += LOTE) {
    const { error } = await supabase
      .from('cidade')
      .upsert(cidadesUnicas.slice(i, i + LOTE), { onConflict: 'codcid' });
    if (error) throw new Error(`Upsert cidade falhou: ${error.message}`);
  }

  return cidades.length;
}

// ---------------------------------------------------------------------------
// Sincroniza bairros (TGFBAI)
// ---------------------------------------------------------------------------
async function syncBairros(
  token: string,
  apiBase: string,
  supabase: ReturnType<typeof createClient>,
): Promise<number> {
  // CODCID não é campo disponível em TGFBAI via loadRecords — omitido
  const raw = await fetchTodasPaginas(token, apiBase, 'Bairro', 'CODBAI,NOMEBAI');

  const bairros: BairroRow[] = [];
  for (const e of raw) {
    const fm = e.__fieldMap as Record<string, number>;
    const codbai = Number(getField(e, 'CODBAI', fm));
    if (!codbai || isNaN(codbai)) continue;
    const nomebai = getField(e, 'NOMEBAI', fm);
    if (!nomebai) continue;
    bairros.push({ codbai, nomebai, codcid: null });
  }

  if (bairros.length === 0) return 0;

  // Deduplica por codbai
  const bairrosMap = new Map<number, BairroRow>();
  for (const b of bairros) bairrosMap.set(b.codbai, b);
  const bairrosUnicos = Array.from(bairrosMap.values());

  const LOTE = 500;
  for (let i = 0; i < bairrosUnicos.length; i += LOTE) {
    const { error } = await supabase
      .from('bairro')
      .upsert(bairrosUnicos.slice(i, i + LOTE), { onConflict: 'codbai' });
    if (error) throw new Error(`Upsert bairro falhou: ${error.message}`);
  }

  return bairros.length;
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
    .insert({ entidade: 'bairro', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Cidades primeiro (FK de bairro → cidade)
    const totalCidades  = await syncCidades(token, apiBase, supabase);
    const totalBairros  = await syncBairros(token, apiBase, supabase);
    const totalRegistros = totalCidades + totalBairros;

    await supabase
      .from('log_sincronizacao')
      .update({
        status: 'sucesso',
        registros_processados: totalRegistros,
        finalizado_em: new Date().toISOString(),
      })
      .eq('id', logId);

    return json({ success: true, cidades: totalCidades, bairros: totalBairros });

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
