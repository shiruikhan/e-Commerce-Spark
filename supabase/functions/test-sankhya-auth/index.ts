import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const REQUIRED_SECRETS = [
  'SANKHYA_CLIENT_ID',
  'SANKHYA_CLIENT_SECRET',
  'SANKHYA_X_TOKEN',
  'SANKHYA_AUTH_URL',
] as const;

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `${'*'.repeat(trimmed.length)} (${trimmed.length} chars)`;
  return `${trimmed.slice(0, 4)}...${ trimmed.slice(-4)} (${trimmed.length} chars, trimmed=${trimmed.length !== value.length})`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return json({ error: 'Use GET' }, 405);
  }

  const report: Record<string, unknown> = {};

  // --- 1. Verificar presença e preview dos secrets ---
  const secretsCheck: Record<string, boolean> = {};
  const secretsPreview: Record<string, string> = {};
  for (const key of REQUIRED_SECRETS) {
    const val = Deno.env.get(key) ?? '';
    secretsCheck[key]   = val.length > 0;
    secretsPreview[key] = val.length > 0 ? mask(val) : '(vazio)';
  }
  report.secrets         = secretsCheck;
  report.secrets_preview = secretsPreview;

  const missingSecrets = REQUIRED_SECRETS.filter(k => !secretsCheck[k]);
  if (missingSecrets.length > 0) {
    return json({
      success: false,
      step: 'secrets_check',
      message: `Secrets ausentes: ${missingSecrets.join(', ')}`,
      report,
    });
  }

  // --- 2. Autenticar via OAuth 2.0 Client Credentials ---
  const authUrl      = Deno.env.get('SANKHYA_AUTH_URL')!.trim();
  const clientId     = Deno.env.get('SANKHYA_CLIENT_ID')!.trim();
  const clientSecret = Deno.env.get('SANKHYA_CLIENT_SECRET')!.trim();
  const xToken       = Deno.env.get('SANKHYA_X_TOKEN')!.trim();

  const formBody = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  report.request_url     = authUrl;
  report.request_headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Token': mask(xToken) };
  report.request_body    = `grant_type=client_credentials&client_id=${mask(clientId)}&client_secret=${mask(clientSecret)}`;

  let authOk = false;
  try {
    const res = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Token': xToken,
      },
      body: formBody.toString(),
    });

    const raw = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw); } catch { body = { raw_text: raw }; }

    report.auth_http_status = res.status;
    report.auth_ok          = res.ok;

    if (res.ok && body.access_token) {
      authOk = true;
      report.token_received = true;
      report.token_type     = body.token_type  ?? null;
      report.expires_in     = body.expires_in  ?? null;
      report.scope          = body.scope        ?? null;
    } else {
      report.token_received = false;
      const { access_token: _t, ...safeBody } = body;
      report.auth_error_body = safeBody;
    }
  } catch (err) {
    report.auth_exception = err instanceof Error ? err.message : String(err);
  }

  return json({
    success: authOk,
    step: authOk ? 'completed' : 'auth_failed',
    message: authOk
      ? 'Autenticação Sankhya bem-sucedida. Todos os secrets estão configurados corretamente.'
      : 'Falha na autenticação. Verifique os valores dos secrets e a URL.',
    report,
    timestamp: new Date().toISOString(),
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
