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
  acao:       'criado' | 'reconciliado' | 'ignorado' | 'erro';
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

/** Extrai DDD e número de uma string de telefone brasileira.
 *  Suporta: "(11) 98765-4321", "11987654321", "+55 11 98765-4321", etc.
 */
function parseTelefone(tel: string | null): { ddd: string; numero: string } | null {
  if (!tel) return null;
  const d = apenasDigitos(tel);
  // Remove código de país +55
  const sem55 = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (sem55.length < 10) return null;
  return { ddd: sem55.slice(0, 2), numero: sem55.slice(2) };
}

// ---------------------------------------------------------------------------
// Verifica se CPF já existe no Sankhya via loadRecords (TGFPAR)
// Retorna CODPARC se encontrado, null caso contrário.
// Busca tanto pelo CPF com máscara quanto sem, para cobrir os dois formatos.
// ---------------------------------------------------------------------------
async function buscarCodparcPorCpf(
  token: string,
  apiBase: string,
  cpf: string,              // apenas dígitos (11 chars)
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
          // Normaliza CGC_CPF removendo pontuação antes de comparar
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

  const url = `${apiBase}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json`;
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
    if (data.status !== '1' && data.status !== 1) return null; // não encontrado = sem erro crítico

    const entities = data?.responseBody?.entities;
    const rawList  = Array.isArray(entities?.entity) ? entities.entity : (entities?.entity ? [entities.entity] : []);
    if (!rawList.length) return null;

    // Parsing posicional
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
// Cria parceiro no Sankhya via REST API
// POST /v1/parceiros/clientes
// Retorna codigoCliente (= CODPARC) gerado pelo ERP.
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
    tipo:     'PF',
    cnpjCpf:  cpf,
    nome:     cliente.nome,
    email:    cliente.email ?? undefined,
    ...(fone && { telefoneDdd: fone.ddd, telefoneNumero: fone.numero }),
    endereco: {
      cep:         cepLimpo || undefined,
      logradouro:  endereco?.logradouro  ?? '',
      numero:      endereco?.numero      ?? 'S/N',
      complemento: endereco?.complemento ?? undefined,
      bairro:      endereco?.bairro      ?? '',
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
      throw new Error(`POST /v1/parceiros/clientes falhou: ${res.status} — ${msg}`);
    }

    // O response pode retornar codigoCliente diretamente ou dentro de contatos[0]
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
// Processa um cliente:
//   - Se CPF já existe no Sankhya → reconcilia CODPARC no Supabase
//   - Se não existe E tem pedido   → cria no Sankhya e salva CODPARC
//   - Se não existe E sem pedido   → ignora (sem criação para evitar cadastros sem compra)
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
    // 1. Verifica se já existe no Sankhya pelo CPF/CNPJ
    const codparcExistente = await buscarCodparcPorCpf(token, apiBase, cpf);

    let codparc: number;
    let acao: 'criado' | 'reconciliado' | 'ignorado';

    if (codparcExistente !== null) {
      // Já existe no Sankhya — reconcilia para evitar duplicidade
      codparc = codparcExistente;
      acao    = 'reconciliado';
    } else if (!temPedido) {
      // Não existe no Sankhya e não realizou compra — não sobe cadastro
      return { cliente_id: cliente.id, cpf, acao: 'ignorado' };
    } else {
      // Não existe no Sankhya E tem pedido — cria o cadastro
      codparc = await criarParceiro(token, apiBase, cliente, endereco);
      acao    = 'criado';
    }

    // 2. Atualiza codparc no Supabase
    const { error: updErr } = await supabase
      .from('cliente')
      .update({ codparc })
      .eq('id', cliente.id);

    if (updErr) throw new Error(`Falha ao atualizar codparc no Supabase: ${updErr.message}`);

    return { cliente_id: cliente.id, cpf, acao, codparc };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { cliente_id: cliente.id, cpf, acao: 'erro', erro: msg };
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
    // Busca TODOS os clientes PF sem codparc para:
    //   a) reconciliar com Sankhya se o CPF já existir lá (evita duplicidade)
    //   b) criar no Sankhya apenas os que fizeram compra no site
    // Usa LEFT JOIN em pedido para detectar se houve compra sem excluir clientes sem pedido.
    const { data: clientesRaw, error: cliErr } = await supabase
      .from('cliente')
      .select(`
        id, nome, cpf_cnpj, email, telefone,
        pedido(id),
        endereco(cep, logradouro, numero, complemento, bairro, cidade, uf, is_padrao)
      `)
      .is('codparc', null);

    if (cliErr) throw new Error(`Falha ao buscar clientes: ${cliErr.message}`);

    // Filtra apenas PF (CPF = 11 dígitos) e enriquece com flag de pedido
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

          // Pega o endereço padrão ou o primeiro disponível
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

    const criados       = resultados.filter(r => r.acao === 'criado').length;
    const reconciliados = resultados.filter(r => r.acao === 'reconciliado').length;
    const ignorados     = resultados.filter(r => r.acao === 'ignorado').length;
    const erros         = resultados.filter(r => r.acao === 'erro');
    const totalOk       = criados + reconciliados;

    const statusFinal = erros.length > 0 && totalOk === 0
      ? 'erro'
      : deadlineAtingido ? 'parcial' : 'sucesso';

    await supabase
      .from('log_sincronizacao')
      .update({
        status: statusFinal,
        registros_processados: totalOk,
        mensagem_erro: erros.length > 0
          ? erros.map(e => `[${e.cpf}] ${e.erro}`).join(' | ')
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
      erros: erros.length,
      detalhes_erros: erros.map(e => ({ cpf: e.cpf, erro: e.erro })),
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
