import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const HTTP_TIMEOUT_MS = 20_000;
const DEADLINE_MS     = 130_000;
const BATCH_SIZE      = 5; // escritas no Sankhya — conservador para evitar rate limit

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------
interface ClienteRow {
  id:        string;
  nome:      string;
  cpf_cnpj:  string;
  email:     string | null;
  telefone:  string | null;
}

interface EnderecoRow {
  cep:         string | null;
  logradouro:  string | null;
  numero:      string | null;
  complemento: string | null;
  bairro:      string | null;
  cidade:      string | null;
  uf:          string | null;
}

interface ResultadoCliente {
  cliente_id: string;
  cpf:        string;
  acao:       'criado' | 'reconciliado' | 'ignorado' | 'erro_permanente' | 'erro';
  codparc?:   number;
  erro?:      string;
}

// ---------------------------------------------------------------------------
// Auth Sankhya — OAuth 2.0 Client Credentials
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
    if (!res.ok) throw new Error(`Auth falhou: ${res.status} ${await res.text()}`);
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
// Helpers
// ---------------------------------------------------------------------------

/** Remove tudo que não é dígito */
function apenasDigitos(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/** Formata CPF com máscara: 12345678900 → 123.456.789-00 */
function formatarCpf(cpf: string): string {
  const d = apenasDigitos(cpf);
  if (d.length !== 11) return d;
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
}

/** Normaliza string para comparação: trim + uppercase */
function normalizar(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase();
}

/** Extrai DDD e número de uma string de telefone brasileira */
function parseTelefone(tel: string | null): { ddd: string; numero: string } | null {
  if (!tel) return null;
  const d = apenasDigitos(tel);
  const sem55 = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (sem55.length < 10) return null;
  return { ddd: sem55.slice(0, 2), numero: sem55.slice(2) };
}

// ---------------------------------------------------------------------------
// Verifica se CPF já existe no Sankhya via loadRecords (TGFPAR)
// ---------------------------------------------------------------------------
async function buscarCodparcPorCpf(
  token: string,
  apiBase: string,
  cpf: string,
): Promise<number | null> {
  const cpfFormatado = formatarCpf(cpf);

  const body = {
    serviceName: 'CRUDServiceProvider.loadRecords',
    requestBody: {
      dataSet: {
        rootEntity: 'Parceiro',
        ignoreCalculatedFields: 'true',
        offsetPage: '0',
        limitPag: '1',
        criteria: {
          expression: { $: "REPLACE(REPLACE(THIS.CGC_CPF, '.', ''), '-', '') = ? OR THIS.CGC_CPF = ?" },
          parameter: [
            { $: cpf,          type: 'S' },
            { $: cpfFormatado, type: 'S' },
          ],
        },
        entity: [{ path: '', fieldset: { list: 'CODPARC,CGC_CPF,TIPPESSOA' } }],
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
    if (!res.ok) throw new Error(`loadRecords Parceiro falhou: ${res.status} ${await res.text()}`);

    const data = await res.json();
    if (data.status !== '1' && data.status !== 1) return null;

    const entities = data?.responseBody?.entities;
    const rawList  = Array.isArray(entities?.entity) ? entities.entity : (entities?.entity ? [entities.entity] : []);
    if (!rawList.length) return null;

    const fields: Array<{ name: string }> = entities?.metadata?.fields?.field ?? [];
    const idx: Record<string, number> = {};
    fields.forEach((f, i) => { idx[f.name] = i; });

    const first = rawList[0] as Record<string, { $?: unknown }>;
    const codparcVal = first[`f${idx['CODPARC']}`]?.$ ?? null;
    return codparcVal !== null ? Number(codparcVal) : null;
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Resolve o bairro: busca localmente e, se ausente, cria no Sankhya (TGFBAI)
// Garante que o bairro exista no ERP antes de tentar criar o parceiro,
// pois o endpoint POST /v1/parceiros/clientes faz lookup interno por nome.
// ---------------------------------------------------------------------------
async function resolverBairro(
  token: string,
  apiBase: string,
  supabase: ReturnType<typeof createClient>,
  nomebai: string | null,
  nomecid: string | null,
  uf: string | null,
): Promise<void> {
  if (!nomebai) return; // sem bairro → não há o que resolver

  const nomebaiNorm = normalizar(nomebai);

  // 1. Busca local na tabela bairro (sync de TGFBAI)
  const { data: encontrado } = await supabase
    .from('bairro')
    .select('codbai')
    .filter('nomebai', 'ilike', nomebai.trim())
    .limit(1)
    .maybeSingle();

  if (encontrado) return; // bairro já existe no Sankhya

  // 2. Não existe localmente → busca CODCID pela cidade
  let codcid: number | null = null;

  if (nomecid && uf) {
    const { data: cidadeRow } = await supabase
      .from('cidade')
      .select('codcid')
      .filter('nomecid', 'ilike', nomecid.trim())
      .eq('uf', uf.trim().toUpperCase())
      .limit(1)
      .maybeSingle();

    codcid = cidadeRow?.codcid ?? null;
  }

  // 3. Cria o bairro no Sankhya via saveRecord
  const localFields: Array<{ name: string; value: { $: string } }> = [
    { name: 'NOMEBAI', value: { $: nomebaiNorm } },
  ];
  if (codcid) {
    localFields.push({ name: 'CODCID', value: { $: String(codcid) } });
  }

  const saveBody = {
    serviceName: 'CRUDServiceProvider.saveRecord',
    requestBody: {
      dataSet: {
        rootEntity: 'Bairro',
        dataRows: {
          dataRow: [{ localFields: { localField: localFields } }],
        },
      },
    },
  };

  const url  = `${apiBase}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.saveRecord&outputType=json`;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(saveBody),
      signal: ctrl.signal,
    });

    const data = await res.json();
    if (!res.ok || (data.status !== '1' && data.status !== 1)) {
      // Falha ao criar bairro — loga mas não bloqueia; o parceiro pode ser rejeitado
      // na próxima etapa com mensagem mais clara
      console.warn(`saveRecord Bairro falhou para "${nomebaiNorm}": ${JSON.stringify(data)}`);
      return;
    }

    // 4. Extrai o CODBAI gerado e persiste localmente
    const codbaiGerado = data?.responseBody?.entities?.entity?.[0]?.key?.CODBAI
      ?? data?.responseBody?.pk?.CODBAI;

    if (codbaiGerado) {
      await supabase.from('bairro').upsert(
        { codbai: Number(codbaiGerado), nomebai: nomebaiNorm, codcid },
        { onConflict: 'codbai' },
      );
    }

  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Cria parceiro no Sankhya via REST API
// POST /v1/parceiros/clientes
// ---------------------------------------------------------------------------
async function criarParceiro(
  token: string,
  apiBase: string,
  cliente: ClienteRow,
  endereco: EnderecoRow | null,
): Promise<number> {
  const cpf     = apenasDigitos(cliente.cpf_cnpj);
  const fone    = parseTelefone(cliente.telefone);
  const cepLimpo = apenasDigitos(endereco?.cep);

  const contato: Record<string, unknown> = {
    tipo:    'PF',
    cnpjCpf: cpf,
    nome:    cliente.nome,
    email:   cliente.email ?? undefined,
    ...(fone && { telefoneDdd: fone.ddd, telefoneNumero: fone.numero }),
    endereco: {
      cep:         cepLimpo || undefined,
      logradouro:  endereco?.logradouro  ?? '',
      numero:      endereco?.numero      ?? 'S/N',
      complemento: endereco?.complemento ?? undefined,
      bairro:      endereco?.bairro      ?? undefined,
      cidade:      endereco?.cidade      ?? '',
      uf:          endereco?.uf          ?? '',
    },
  };

  const payload = { contatos: [contato] };

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/parceiros/clientes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const msg = (data?.mensagem ?? data?.message ?? JSON.stringify(data)) as string;
      throw new Error(`POST /v1/parceiros/clientes falhou: ${res.status} — ${JSON.stringify(data?.error ?? msg)}`);
    }

    const codigoCliente =
      (data?.codigoCliente as number | undefined) ??
      ((data?.contatos as Array<Record<string,unknown>>)?.[0]?.codigoCliente as number | undefined) ??
      ((data?.clientes  as Array<Record<string,unknown>>)?.[0]?.codigoCliente as number | undefined);

    if (!codigoCliente) {
      throw new Error(`codigoCliente não encontrado no response: ${JSON.stringify(data)}`);
    }

    return codigoCliente;
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Classifica se um erro HTTP do Sankhya é permanente (400) ou transitório (5xx)
// Erros permanentes não devem ser retentados automaticamente.
// ---------------------------------------------------------------------------
function erroEhPermanente(msg: string): boolean {
  // HTTP 400 do Sankhya = erro de negócio/dados — não adianta retentar sem corrigir dado
  return msg.includes('falhou: 400');
}

// ---------------------------------------------------------------------------
// Processa um cliente
// ---------------------------------------------------------------------------
async function processarCliente(
  token: string,
  apiBase: string,
  supabase: ReturnType<typeof createClient>,
  cliente: ClienteRow,
  endereco: EnderecoRow | null,
  temPedido: boolean,
): Promise<ResultadoCliente> {
  const cpf = apenasDigitos(cliente.cpf_cnpj);

  try {
    // 1. Verifica se já existe no Sankhya pelo CPF
    const codparcExistente = await buscarCodparcPorCpf(token, apiBase, cpf);

    let codparc: number;
    let acao: 'criado' | 'reconciliado' | 'ignorado';

    if (codparcExistente !== null) {
      codparc = codparcExistente;
      acao    = 'reconciliado';
    } else if (!temPedido) {
      return { cliente_id: cliente.id, cpf, acao: 'ignorado' };
    } else {
      // Garante que o bairro existe no Sankhya antes de criar o parceiro
      await resolverBairro(
        token, apiBase, supabase,
        endereco?.bairro ?? null,
        endereco?.cidade ?? null,
        endereco?.uf     ?? null,
      );

      codparc = await criarParceiro(token, apiBase, cliente, endereco);
      acao    = 'criado';
    }

    // 2. Atualiza codparc + status no Supabase
    const { error: updErr } = await supabase
      .from('cliente')
      .update({ codparc, integracao_status: 'integrado', integracao_erro: null })
      .eq('id', cliente.id);

    if (updErr) throw new Error(`Falha ao atualizar codparc no Supabase: ${updErr.message}`);

    return { cliente_id: cliente.id, cpf, acao, codparc };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanente = erroEhPermanente(msg);

    // Persiste o status de erro para evitar retentativas infinitas em falhas permanentes
    await supabase
      .from('cliente')
      .update({
        integracao_status: permanente ? 'erro_permanente' : null,
        integracao_erro:   msg,
      })
      .eq('id', cliente.id);

    return {
      cliente_id: cliente.id,
      cpf,
      acao: permanente ? 'erro_permanente' : 'erro',
      erro: msg,
    };
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
    .insert({ entidade: 'cliente', status: 'processando' })
    .select('id')
    .single();
  if (logErr) return json({ success: false, error: logErr.message }, 500);
  const logId = logRow.id;

  try {
    // Busca clientes PF sem codparc que ainda não tenham erro permanente
    const { data: clientesRaw, error: cliErr } = await supabase
      .from('cliente')
      .select(`
        id, nome, cpf_cnpj, email, telefone,
        pedido(id),
        endereco(cep, logradouro, numero, complemento, bairro, cidade, uf, is_padrao)
      `)
      .is('codparc', null)
      .or('integracao_status.is.null,integracao_status.eq.pendente');

    if (cliErr) throw new Error(`Falha ao buscar clientes: ${cliErr.message}`);

    // Filtra apenas PF (CPF = 11 dígitos)
    const clientes = (clientesRaw ?? [])
      .filter(c => apenasDigitos(c.cpf_cnpj).length === 11)
      .map(c => ({
        ...c,
        temPedido: Array.isArray(c.pedido) ? c.pedido.length > 0 : !!c.pedido,
      }));

    const total = clientes.length;

    if (total === 0) {
      await supabase
        .from('log_sincronizacao')
        .update({ status: 'sucesso', registros_processados: 0, finalizado_em: new Date().toISOString() })
        .eq('id', logId);
      return json({ success: true, status: 'sucesso', mensagem: 'Nenhum cliente elegível encontrado.', total_clientes: 0 });
    }

    const token   = await getSankhyaToken();
    const apiBase = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);

    const resultados: ResultadoCliente[] = [];
    let deadlineAtingido = false;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (Date.now() - startTime > DEADLINE_MS) {
        deadlineAtingido = true;
        break;
      }

      const lote = clientes.slice(i, i + BATCH_SIZE);

      const loteResultados = await Promise.all(
        lote.map(c => {
          const clienteRow: ClienteRow = {
            id:       c.id,
            nome:     c.nome,
            cpf_cnpj: c.cpf_cnpj,
            email:    c.email,
            telefone: c.telefone,
          };

          const enderecos = Array.isArray(c.endereco) ? c.endereco : (c.endereco ? [c.endereco] : []);
          const endPadrao = enderecos.find((e: { is_padrao: boolean }) => e.is_padrao) ?? enderecos[0] ?? null;
          const enderecoRow: EnderecoRow | null = endPadrao ? {
            cep:         endPadrao.cep,
            logradouro:  endPadrao.logradouro,
            numero:      endPadrao.numero,
            complemento: endPadrao.complemento,
            bairro:      endPadrao.bairro,
            cidade:      endPadrao.cidade,
            uf:          endPadrao.uf,
          } : null;

          return processarCliente(token, apiBase, supabase, clienteRow, enderecoRow, c.temPedido);
        }),
      );

      resultados.push(...loteResultados);
    }

    const criados          = resultados.filter(r => r.acao === 'criado').length;
    const reconciliados    = resultados.filter(r => r.acao === 'reconciliado').length;
    const ignorados        = resultados.filter(r => r.acao === 'ignorado').length;
    const errosPermanentes = resultados.filter(r => r.acao === 'erro_permanente');
    const errosTransitorios = resultados.filter(r => r.acao === 'erro');
    const totalOk          = criados + reconciliados;
    const totalErros       = errosPermanentes.length + errosTransitorios.length;

    const statusFinal = totalErros > 0 && totalOk === 0
      ? 'erro'
      : deadlineAtingido ? 'parcial' : 'sucesso';

    const todosErros = [...errosPermanentes, ...errosTransitorios];

    await supabase
      .from('log_sincronizacao')
      .update({
        status: statusFinal,
        registros_processados: totalOk,
        mensagem_erro: todosErros.length > 0
          ? todosErros.map(e => `[${e.cpf}][${e.acao}] ${e.erro}`).join(' | ')
          : null,
        finalizado_em: new Date().toISOString(),
      })
      .eq('id', logId);

    return json({
      success: true,
      status: statusFinal,
      total_elegiveis: total,
      criados,
      reconciliados,
      ignorados,
      erros_permanentes: errosPermanentes.length,
      erros_transitorios: errosTransitorios.length,
      detalhes_erros: todosErros.map(e => ({ cpf: e.cpf, acao: e.acao, erro: e.erro })),
      tempo_ms: Date.now() - startTime,
      ...(deadlineAtingido && { aviso: `Deadline atingido. ${total - resultados.length} clientes não processados.` }),
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
