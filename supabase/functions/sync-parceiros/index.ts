import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
  if (!res.ok) throw new Error(`Auth falhou: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('access_token não recebido');
  return access_token;
}

function getApiBase(authUrl: string): string {
  const u = new URL(authUrl);
  return `${u.protocol}//${u.host}`;
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);
    const url     = `${apiBase}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json`;

    let page = 0;
    let total = 0;
    const LOTE = 500;
    let lote: Array<{ codparc: number; cgc_cpf: string | null }> = [];

    while (true) {
      const body = {
        serviceName: 'CRUDServiceProvider.loadRecords',
        requestBody: {
          dataSet: {
            rootEntity: 'Parceiro',
            ignoreCalculatedFields: 'true',
            offsetPage: String(page),
            entity: [{ path: '', fieldset: { list: 'CODPARC,CGC_CPF' } }],
          },
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`loadRecords p${page} falhou: ${res.status} ${await res.text()}`);

      const data = await res.json();
      if (data.status !== '1' && data.status !== 1)
        throw new Error(`Sankhya erro: ${JSON.stringify(data.statusMessage ?? data.error ?? data)}`);

      const entities = data?.responseBody?.entities;
      const rawList: Record<string, unknown>[] = Array.isArray(entities?.entity)
        ? entities.entity
        : (entities?.entity ? [entities.entity] : []);

      const fields: Array<{ name: string }> = entities?.metadata?.fields?.field ?? [];
      const idx: Record<string, number> = {};
      fields.forEach((f, i) => { idx[f.name] = i; });

      for (const e of rawList) {
        const row = e as Record<string, { $?: unknown }>;
        const codparc = Number(row[`f${idx['CODPARC']}`]?.$ ?? 0);
        if (!codparc) continue;
        const cgc_cpf = String(row[`f${idx['CGC_CPF']}`]?.$ ?? '') || null;
        lote.push({ codparc, cgc_cpf });
      }

      // Upsert incremental a cada LOTE registros para não acumular tudo na memória
      if (lote.length >= LOTE) {
        const map = new Map<number, { codparc: number; cgc_cpf: string | null }>();
        for (const r of lote) map.set(r.codparc, r);
        const { error } = await supabase
          .from('parceiro')
          .upsert(Array.from(map.values()), { onConflict: 'codparc' });
        if (error) throw new Error(`Upsert parceiro falhou: ${error.message}`);
        total += map.size;
        lote = [];
      }

      if (entities?.hasMoreResult !== 'true' && entities?.hasMoreResult !== true) break;
      page++;
    }

    // Upsert do lote final
    if (lote.length > 0) {
      const map = new Map<number, { codparc: number; cgc_cpf: string | null }>();
      for (const r of lote) map.set(r.codparc, r);
      const { error } = await supabase
        .from('parceiro')
        .upsert(Array.from(map.values()), { onConflict: 'codparc' });
      if (error) throw new Error(`Upsert parceiro falhou: ${error.message}`);
      total += map.size;
    }

    return json({ success: true, total });

  } catch (err) {
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
