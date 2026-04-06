import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface ProdutoRow {
  codprod: number;
  descrprod: string;
  comnome: string | null;
  desccurta: string | null;
  descrprodoed: string | null;
  dtalter: string | null;
  peso: number | null;
  altura: number | null;
  largura: number | null;
  comprimento: number | null;
}

// Snapshot do Supabase usado para comparação local
interface ExistenteRow {
  dtalter: string | null;
  peso: number | null;
  altura: number | null;
  largura: number | null;
  comprimento: number | null;
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
// Parsers
// ---------------------------------------------------------------------------

/** Sankhya BR (DD/MM/AAAA HH:MM:SS) → ISO 8601 (UTC-3) */
function sankhyaToIso(s: string): string | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-03:00`;
}

function toNumeric(val: string | null): number | null {
  if (!val) return null;
  const n = parseFloat(val.replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Decide se o produto precisa de upsert.
// Atualiza se:
//   1. Produto não existe no Supabase (novo)
//   2. DTALTER do Sankhya é mais recente que o do Supabase (modificado no ERP)
//   3. Algum campo mapeado está nulo no Supabase mas tem valor no Sankhya
//      (cobre adição de novos campos ao sincronizador sem precisar re-sync manual)
// ---------------------------------------------------------------------------
function precisaAtualizar(sankhya: ProdutoRow, existente: ExistenteRow | undefined): boolean {
  if (existente === undefined) return true;

  // Sankhya mais recente?
  if (sankhya.dtalter && existente.dtalter &&
      new Date(sankhya.dtalter).getTime() > new Date(existente.dtalter).getTime()) return true;
  if (sankhya.dtalter && !existente.dtalter) return true;

  // Campos nulos no Supabase mas preenchidos no Sankhya?
  if (sankhya.peso        !== null && existente.peso        === null) return true;
  if (sankhya.altura      !== null && existente.altura      === null) return true;
  if (sankhya.largura     !== null && existente.largura     === null) return true;
  if (sankhya.comprimento !== null && existente.comprimento === null) return true;

  return false;
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
): ProdutoRow | null {
  const codprod = Number(getField(entity, 'CODPROD', fieldMap));
  if (!codprod || isNaN(codprod)) return null;
  const dtalterRaw = getField(entity, 'DTALTER', fieldMap);
  return {
    codprod,
    descrprod:    getField(entity, 'DESCRPROD',       fieldMap) ?? '',
    comnome:      getField(entity, 'AD_COMNOME',      fieldMap),
    desccurta:    getField(entity, 'AD_DESCCURTA',    fieldMap),
    descrprodoed: getField(entity, 'AD_DESCRPRODOED', fieldMap),
    dtalter:      dtalterRaw ? sankhyaToIso(dtalterRaw) : null,
    peso:         toNumeric(getField(entity, 'PESOBRUTO', fieldMap)),
    altura:       toNumeric(getField(entity, 'ALTURA',    fieldMap)),
    largura:      toNumeric(getField(entity, 'LARGURA',   fieldMap)),
    comprimento:  toNumeric(getField(entity, 'ESPESSURA', fieldMap)),
  };
}

// ---------------------------------------------------------------------------
// Busca página do Sankhya — AD_SYNCSITE='S', sem filtro de data
// ---------------------------------------------------------------------------
async function fetchPagina(
  token: string,
  apiBase: string,
  page: number,
): Promise<{ produtos: ProdutoRow[]; hasMore: boolean }> {
  const body = {
    serviceName: 'CRUDServiceProvider.loadRecords',
    requestBody: {
      dataSet: {
        rootEntity: 'Produto',
        ignoreCalculatedFields: 'true',
        offsetPage: String(page),
        criteria: {
          expression: { $: "AD_SYNCSITE = ?" },
          parameter:  [{ $: 'S', type: 'S' }],
        },
        entity: [{
          path: '',
          fieldset: {
            list: 'CODPROD,DESCRPROD,AD_COMNOME,AD_DESCCURTA,AD_DESCRPRODOED,DTALTER,PESOBRUTO,ALTURA,LARGURA,ESPESSURA',
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
    produtos: rawList.map(e => normalizar(e, fieldMap)).filter((p): p is ProdutoRow => p !== null),
    hasMore:  entities?.hasMoreResult === 'true' || entities?.hasMoreResult === true,
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
    .insert({ entidade: 'produto', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    // Carrega snapshot do Supabase incluindo campos dimensionais
    // para detectar tanto produtos modificados quanto campos recém-adicionados ao sync
    const { data: existentes, error: existErr } = await supabase
      .from('produto')
      .select('codprod, dtalter, peso, altura, largura, comprimento');
    if (existErr) throw new Error(`Falha ao carregar produtos: ${existErr.message}`);

    const mapaLocal = new Map<number, ExistenteRow>(
      (existentes ?? []).map(p => [p.codprod as number, {
        dtalter:     p.dtalter     as string | null,
        peso:        p.peso        as number | null,
        altura:      p.altura      as number | null,
        largura:     p.largura     as number | null,
        comprimento: p.comprimento as number | null,
      }])
    );

    let page            = 0;
    let totalProcessado = 0;
    let totalIgnorado   = 0;
    let hasMore         = true;

    while (hasMore) {
      const { produtos: pagina, hasMore: more } = await fetchPagina(token, apiBase, page);
      hasMore = more;
      page++;

      const aAtualizar = pagina.filter(p => precisaAtualizar(p, mapaLocal.get(p.codprod)));
      totalIgnorado += pagina.length - aAtualizar.length;

      if (aAtualizar.length === 0) continue;

      const { error: upsertErr } = await supabase
        .from('produto')
        .upsert(aAtualizar, { onConflict: 'codprod' });
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
