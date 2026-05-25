import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const HTTP_TIMEOUT_MS = 20_000;
const DEADLINE_MS     = 130_000;
const BATCH_SIZE      = 5;

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
  acao:       'criado' | 'reconciliado' | 'ignorado' | 'endereco_incompleto' | 'erro_permanente' | 'erro';
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
function apenasDigitos(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

function formatarCpf(cpf: string): string {
  const d = apenasDigitos(cpf);
  if (d.length !== 11) return d;
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
}

function parseTelefone(tel: string | null): { ddd: string; numero: string } | null {
  if (!tel) return null;
  const d = apenasDigitos(tel);
  const sem55 = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (sem55.length < 10) return null;
  return { ddd: sem55.slice(0, 2), numero: sem55.slice(2) };
}

// ---------------------------------------------------------------------------
// Verifica se CPF já existe no espelho local da tabela parceiro
// ---------------------------------------------------------------------------
async function buscarCodparcPorCpf(
  supabase: ReturnType<typeof createClient>,
  cpfDigitos: string,
): Promise<number | null> {
  const cpfFormatado = formatarCpf(cpfDigitos);
  const { data } = await supabase
    .from('parceiro')
    .select('codparc')
    .or(`cgc_cpf.eq.${cpfDigitos},cgc_cpf.eq.${cpfFormatado}`)
    .maybeSingle();
  return data?.codparc ?? null;
}


// ---------------------------------------------------------------------------
// Carrega mapa cidade-normalizada → codibge a partir da tabela local
// ---------------------------------------------------------------------------
function normalizarNome(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

interface CidadeEntry { codibge: string; nomecid: string; }

async function carregarCidadeMap(
  supabase: ReturnType<typeof createClient>,
): Promise<Map<string, CidadeEntry>> {
  const { data } = await supabase
    .from('cidade')
    .select('nomecid, codibge')
    .not('codibge', 'is', null);

  const map = new Map<string, CidadeEntry>();
  for (const row of data ?? []) {
    map.set(normalizarNome(row.nomecid), { codibge: String(row.codibge), nomecid: row.nomecid });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Cria parceiro no Sankhya via REST POST /v1/parceiros/clientes
// ---------------------------------------------------------------------------
async function criarParceiro(
  token: string,
  apiBase: string,
  cliente: ClienteRow,
  endereco: EnderecoRow | null,
  cidadeMap: Map<string, CidadeEntry>,
): Promise<number> {
  const cpfFormatado = formatarCpf(apenasDigitos(cliente.cpf_cnpj));
  const fone         = parseTelefone(cliente.telefone);
  const cepLimpo     = apenasDigitos(endereco?.cep);

  const cidadeEntry = endereco?.cidade
    ? cidadeMap.get(normalizarNome(endereco.cidade)) ?? null
    : null;
  if (!cidadeEntry) throw new Error(`Código IBGE não encontrado para ${endereco?.cidade}/${endereco?.uf}`);

  const enderecoPayload: Record<string, unknown> = {
    logradouro:  endereco!.logradouro,
    numero:      endereco!.numero,
    bairro:      endereco!.bairro,
    cidade:      cidadeEntry.nomecid,
    uf:          endereco!.uf,
    cep:         cepLimpo,
    codigolbge:  cidadeEntry.codibge,
  };
  if (endereco?.complemento) enderecoPayload['complemento'] = endereco.complemento;

  const payload: Record<string, unknown> = {
    tipo:    'PF',
    cnpjCpf: cpfFormatado,
    ieRg:    'ISENTO',
    nome:    cliente.nome.toUpperCase(),
  };

  if (cliente.email) payload['email'] = cliente.email;
  if (fone) {
    payload['telefoneDdd']    = fone.ddd;
    payload['telefoneNumero'] = fone.numero;
  }
  payload['endereco'] = enderecoPayload;

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

    const rawText = await res.text();
    let data: Record<string, unknown>;
    try { data = JSON.parse(rawText); } catch { throw new Error(`POST /v1/parceiros resposta não-JSON: ${rawText.slice(0, 500)}`); }

    if (!res.ok) {
      throw new Error(`POST /v1/parceiros falhou: ${res.status} — ${rawText.slice(0, 1000)}`);
    }

    // O response retorna codigoParceiro, codparc ou id dependendo da versão
    const codparc =
      (data?.codigoParceiro as number | undefined) ??
      (data?.codParc        as number | undefined) ??
      (data?.codparc        as number | undefined) ??
      (data?.id             as number | undefined);

    if (!codparc) {
      throw new Error(`CODPARC não encontrado no response: ${rawText.slice(0, 500)}`);
    }

    return Number(codparc);
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
// Erros que não devem ser retentados sem correção de dados
// (CPF duplicado, campo inválido, etc.)
// ---------------------------------------------------------------------------
function erroEhPermanente(msg: string): boolean {
  // Erros que indicam bug de código/configuração = transitório (retentável após correção)
  if (msg.includes('PreparedStatement')) return false;
  if (msg.includes('ORA-')) return false;
  // 400 com mensagem de negócio (CPF duplicado, campo inválido) = verdadeiramente permanente
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
  cidadeMap: Map<string, string>,
): Promise<ResultadoCliente> {
  const cpf = apenasDigitos(cliente.cpf_cnpj);

  try {
    // 1. Valida campos obrigatórios do endereço antes de qualquer chamada à API
    //    POST /v1/parceiros/clientes exige endereco completo; campo ausente = erro 400 no Sankhya
    const camposFaltando: string[] = [];
    if (!endereco?.logradouro) camposFaltando.push('logradouro');
    if (!endereco?.numero)     camposFaltando.push('numero');
    if (!endereco?.bairro)     camposFaltando.push('bairro');
    if (!endereco?.cidade)     camposFaltando.push('cidade');
    if (!endereco?.uf)         camposFaltando.push('uf');
    if (!apenasDigitos(endereco?.cep)) camposFaltando.push('cep');

    if (camposFaltando.length > 0) {
      const msg = `Endereço incompleto — campos obrigatórios ausentes: ${camposFaltando.join(', ')}`;
      await supabase
        .from('cliente')
        .update({ integracao_status: null, integracao_erro: msg })
        .eq('id', cliente.id);
      return { cliente_id: cliente.id, cpf, acao: 'endereco_incompleto', erro: msg };
    }

    // 2. Verifica se já existe no espelho local pelo CPF
    const codparcExistente = await buscarCodparcPorCpf(supabase, cpf);

    let codparc: number;
    let acao: 'criado' | 'reconciliado' | 'ignorado';

    if (codparcExistente !== null) {
      codparc = codparcExistente;
      acao    = 'reconciliado';
    } else if (!temPedido) {
      return { cliente_id: cliente.id, cpf, acao: 'ignorado' };
    } else {
      codparc = await criarParceiro(token, apiBase, cliente, endereco, cidadeMap);
      acao    = 'criado';
    }

    // 3. Atualiza codparc + status no Supabase
    const { error: updErr } = await supabase
      .from('cliente')
      .update({ codparc, integracao_status: 'integrado', integracao_erro: null })
      .eq('id', cliente.id);

    if (updErr) throw new Error(`Falha ao atualizar codparc: ${updErr.message}`);

    return { cliente_id: cliente.id, cpf, acao, codparc };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanente = erroEhPermanente(msg);

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

    // Apenas PF (CPF = 11 dígitos)
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
      return json({ success: true, status: 'sucesso', mensagem: 'Nenhum cliente elegível.', total_clientes: 0 });
    }

    const token      = await getSankhyaToken();
    const apiBase    = getApiBase(Deno.env.get('SANKHYA_AUTH_URL')!);
    const cidadeMap  = await carregarCidadeMap(supabase);

    const resultados: ResultadoCliente[] = [];
    let deadlineAtingido = false;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (Date.now() - startTime > DEADLINE_MS) { deadlineAtingido = true; break; }

      const lote = clientes.slice(i, i + BATCH_SIZE);
      const loteResultados = await Promise.all(
        lote.map(c => {
          const clienteRow: ClienteRow = { id: c.id, nome: c.nome, cpf_cnpj: c.cpf_cnpj, email: c.email, telefone: c.telefone };
          const enderecos = Array.isArray(c.endereco) ? c.endereco : (c.endereco ? [c.endereco] : []);
          const endPadrao = enderecos.find((e: { is_padrao: boolean }) => e.is_padrao) ?? enderecos[0] ?? null;
          const enderecoRow: EnderecoRow | null = endPadrao ? {
            cep: endPadrao.cep, logradouro: endPadrao.logradouro, numero: endPadrao.numero,
            complemento: endPadrao.complemento, bairro: endPadrao.bairro,
            cidade: endPadrao.cidade, uf: endPadrao.uf,
          } : null;
          return processarCliente(token, apiBase, supabase, clienteRow, enderecoRow, c.temPedido, cidadeMap);
        }),
      );
      resultados.push(...loteResultados);
    }

    const criados              = resultados.filter(r => r.acao === 'criado').length;
    const reconciliados        = resultados.filter(r => r.acao === 'reconciliado').length;
    const ignorados            = resultados.filter(r => r.acao === 'ignorado').length;
    const enderecoIncompleto   = resultados.filter(r => r.acao === 'endereco_incompleto');
    const errosPermanentes     = resultados.filter(r => r.acao === 'erro_permanente');
    const errosTransitorios    = resultados.filter(r => r.acao === 'erro');
    const totalOk              = criados + reconciliados;
    const totalErros           = errosPermanentes.length + errosTransitorios.length;
    const statusFinal          = totalErros > 0 && totalOk === 0 ? 'erro' : deadlineAtingido ? 'parcial' : 'sucesso';
    const todosErros           = [...errosPermanentes, ...errosTransitorios];

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
      success: true, status: statusFinal,
      total_elegiveis: total, criados, reconciliados, ignorados,
      endereco_incompleto: enderecoIncompleto.length,
      erros_permanentes: errosPermanentes.length,
      erros_transitorios: errosTransitorios.length,
      detalhes_erros: todosErros.map(e => ({ cpf: e.cpf, acao: e.acao, erro: e.erro })),
      detalhes_endereco_incompleto: enderecoIncompleto.map(e => ({ cpf: e.cpf, erro: e.erro })),
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
