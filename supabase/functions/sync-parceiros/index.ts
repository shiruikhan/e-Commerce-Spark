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

    const parceiros: Array<{ codparc: number; cgc_cpf: string | null }> = [];
    let page = 0;

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
        parceiros.push({ codparc, cgc_cpf });
      }

      if (entities?.hasMoreResult !== 'true' && entities?.hasMoreResult !== true) break;
      page++;
    }

    if (parceiros.length === 0) return json({ success: true, total: 0 });

    const LOTE = 500;
    for (let i = 0; i < parceiros.length; i += LOTE) {
      const { error } = await supabase
        .from('parceiro')
        .upsert(parceiros.slice(i, i + LOTE), { onConflict: 'codparc' });
      if (error) throw new Error(`Upsert parceiro falhou: ${error.message}`);
    }

    return json({ success: true, total: parceiros.length });

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
