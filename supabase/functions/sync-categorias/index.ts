import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface CategoriaRow {
  codgrupoprod: number;
  descr_grupo: string;
  codgrupopai: number | null;
}

// Snapshot do Supabase usado para comparação local
interface ExistenteRow {
  descr_grupo: string;
  codgrupopai: number | null;
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

function normalizar(
  entity: Record<string, unknown>,
  fieldMap: Record<string, number>,
): CategoriaRow | null {
  const codgrupoprod = Number(getField(entity, 'CODGRUPOPROD', fieldMap));
  if (!codgrupoprod || isNaN(codgrupoprod)) return null;

  const descr_grupo = getField(entity, 'DESCRGRUPOPROD', fieldMap);
  if (!descr_grupo) return null;

  // CODGRUPAI = 0 ou -999999999 significa categoria raiz no Sankhya — armazenar como null
  const codgrupopaiRaw = getField(entity, 'CODGRUPAI', fieldMap);
  const codgrupopaiNum = codgrupopaiRaw ? Number(codgrupopaiRaw) : null;
  const codgrupopai = codgrupopaiNum && codgrupopaiNum > 0 ? codgrupopaiNum : null;

  return { codgrupoprod, descr_grupo, codgrupopai };
}

// ---------------------------------------------------------------------------
// Decide se a categoria precisa de upsert.
// Atualiza se:
//   1. Categoria não existe no Supabase (nova)
//   2. descr_grupo foi alterada no ERP
//   3. codgrupopai foi alterado (reestruturação da hierarquia)
// ---------------------------------------------------------------------------
function precisaAtualizar(sankhya: CategoriaRow, existente: ExistenteRow | undefined): boolean {
  if (existente === undefined) return true;
  if (sankhya.descr_grupo !== existente.descr_grupo) return true;
  if (sankhya.codgrupopai !== existente.codgrupopai) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Busca página do Sankhya — todos os grupos de produto (sem filtro)
// ---------------------------------------------------------------------------
async function fetchPagina(
  token: string,
  apiBase: string,
  page: number,
): Promise<{ categorias: CategoriaRow[]; hasMore: boolean }> {
  const body = {
    serviceName: 'CRUDServiceProvider.loadRecords',
    requestBody: {
      dataSet: {
        rootEntity: 'GrupoProduto',
        ignoreCalculatedFields: 'true',
        offsetPage: String(page),
        entity: [{
          path: '',
          fieldset: {
            list: 'CODGRUPOPROD,DESCRGRUPOPROD,CODGRUPAI',
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
    categorias: rawList
      .map(e => normalizar(e, fieldMap))
      .filter((c): c is CategoriaRow => c !== null),
    hasMore: entities?.hasMoreResult === 'true' || entities?.hasMoreResult === true,
  };
}

// ---------------------------------------------------------------------------
// Ordena categorias em ondas topológicas para respeitar a FK self-referencing.
// Retorna um array de batches onde cada batch pode ser upsertado com segurança
// (todos os pais já existem antes do filho ser inserido).
// ---------------------------------------------------------------------------
function ordenarTopologicamente(
  categorias: CategoriaRow[],
  jaPresentes: Set<number>,
): CategoriaRow[][] {
  const batches: CategoriaRow[][] = [];
  let restantes = [...categorias];
  const inseridos = new Set<number>(jaPresentes);

  // Máximo de 20 passadas para evitar loop infinito em caso de dado inconsistente
  for (let pass = 0; pass < 20 && restantes.length > 0; pass++) {
    const prontos = restantes.filter(
      c => c.codgrupopai === null || inseridos.has(c.codgrupopai),
    );
    if (prontos.length === 0) break; // órfãos ou referência circular — encerra

    prontos.forEach(c => inseridos.add(c.codgrupoprod));
    restantes = restantes.filter(c => !inseridos.has(c.codgrupoprod));
    batches.push(prontos);
  }

  // Categorias órfãs (pai não existe nem no Sankhya nem no Supabase) — inserir por último
  // com codgrupopai = null para não bloquear a sync
  if (restantes.length > 0) {
    batches.push(restantes.map(c => ({ ...c, codgrupopai: null })));
  }

  return batches;
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
    .insert({ entidade: 'categoria', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Carrega snapshot do Supabase para comparação local
    const { data: existentes, error: existErr } = await supabase
      .from('categoria')
      .select('codgrupoprod, descr_grupo, codgrupopai');
    if (existErr) throw new Error(`Falha ao carregar categorias: ${existErr.message}`);

    const mapaLocal = new Map<number, ExistenteRow>(
      (existentes ?? []).map(c => [c.codgrupoprod as number, {
        descr_grupo: c.descr_grupo as string,
        codgrupopai: c.codgrupopai as number | null,
      }])
    );

    // Coleta todas as páginas antes de processar (necessário para ordenação topológica)
    const todasSankhya: CategoriaRow[] = [];
    let page    = 0;
    let hasMore = true;

    while (hasMore) {
      const { categorias: pagina, hasMore: more } = await fetchPagina(token, apiBase, page);
      todasSankhya.push(...pagina);
      hasMore = more;
      page++;
    }

    const totalIgnorado  = todasSankhya.filter(
      c => !precisaAtualizar(c, mapaLocal.get(c.codgrupoprod)),
    ).length;

    const aAtualizar = todasSankhya.filter(
      c => precisaAtualizar(c, mapaLocal.get(c.codgrupoprod)),
    );

    // Ordena em batches topológicos para respeitar a FK codgrupopai → codgrupoprod
    const jaPresentes = new Set<number>(mapaLocal.keys());
    const batches = ordenarTopologicamente(aAtualizar, jaPresentes);

    let totalProcessado = 0;

    for (const batch of batches) {
      if (batch.length === 0) continue;
      const { error: upsertErr } = await supabase
        .from('categoria')
        .upsert(batch, { onConflict: 'codgrupoprod' });
      if (upsertErr) throw new Error(`Upsert falhou: ${upsertErr.message}`);
      totalProcessado += batch.length;
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
