import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const IBGE_BASE = "https://servicodados.ibge.gov.br/api/v1/localidades/estados";
const LOTE = 100;

// Códigos internos do Sankhya → sigla IBGE do estado
const SANKHYA_UF: Record<string, string> = {
  "1": "SP", "2": "MG", "3": "DF", "4": "GO",  "5": "MT",
  "6": "BA", "7": "RJ", "8": "PR", "9": "PA",  "10": "PE",
  "11": "RO", "12": "MS", "13": "SC", "14": "TO", "15": "RS",
  "16": "ES", "17": "PB", "18": "AM", "19": "AL", "20": "AC",
  "21": "CE", "22": "SE", "23": "PI", "24": "RR", "26": "RN",
  "28": "AP", "31": "MA",
};

// Exceções: normalizar(nomeSankhya)|siglaUF → candidatos IBGE (tentados em ordem)
const EXCECOES: Record<string, string[]> = {
  "cabaceiras paraguacu|BA":       ["Cabaceiras do Paraguacu"],
  "alto alegre parecis|RO":        ["Alto Alegre dos Parecis"],
  "afogados ingazeira|PE":         ["Afogados da Ingazeira"],
  "brejo madre deus|PE":           ["Brejo da Madre de Deus"],
  "cabo santo agostinho|PE":       ["Cabo de Santo Agostinho"],
  "dois irmaos missoes|RS":        ["Dois Irmaos das Missoes"],
  "benjamin constant s|RS":        ["Benjamin Constant do Sul"],
  "boa vista missoes|RS":          ["Boa Vista das Missoes"],
  "alm tamandare sul|RS":          ["Almirante Tamandare do Sul"],
  "conceicao aparecida|MG":        ["Conceicao da Aparecida"],
  "conceic barra minas|MG":        ["Conceicao da Barra de Minas"],
  "divino laranjeiras|MG":         ["Divino das Laranjeiras"],
  "divinolandia minas|MG":         ["Divinolandia de Minas"],
  "bonfinopolis minas|MG":         ["Bonfimopolis de Minas", "Bonfimopolis"],
  "palmeiral botelhos|MG":         ["Botelhos"],
  "brasopolis|MG":                 ["Brazopolis"],
  "vila dos cabanos barcarena|PA": ["Barcarena"],
  "bom jesus tocantins|PA":        ["Bom Jesus do Tocantins"],
  "caicara rio vento|RN":          ["Caicara do Rio do Vento"],
  "aguas lindas goias|GO":         ["Aguas Lindas de Goias"],
  "divino sao lourenco|ES":        ["Divino de Sao Lourenco"],
  "aguas santa barbara|SP":        ["Aguas de Santa Barbara"],
  "bom jesus perdoes|SP":          ["Bom Jesus dos Perdoes"],
  "bom sucesso itarare|SP":        ["Bom Sucesso de Itarare"],
  "mirante paranapanema|SP":       ["Mirante do Paranapanema"],
  "moji mirim|SP":                 ["Mogi Mirim"],
  "belem brejo cruz|PB":           ["Belem do Brejo do Cruz"],
  "bela vista paraiso|PR":         ["Bela Vista do Paraiso"],
  "alto alegre colorado|PR":       ["Colorado"],
  "boa esperanca iguacu|PR":       ["Boa Esperanca do Iguacu"],
  "boa ventura s roque|PR":        ["Boa Ventura de Sao Roque"],
  "boa vista aparecida|PR":        ["Boa Vista da Aparecida"],
  "agua doce maranhao|MA":         ["Agua Doce do Maranhao"],
  "bela vista maranhao|MA":        ["Bela Vista do Maranhao"],
  "formosa serra negra|MA":        ["Formosa da Serra Negra"],
  "alto alegre maranhao|MA":       ["Alto Alegre do Maranhao"],
  "alto alegre pindare|MA":        ["Alto Alegre do Pindare"],
  "nova olinda maranhao|MA":       ["Nova Olinda do Maranhao"],
  "bom jesus araguaia|MT":         ["Bom Jesus do Araguaia"],
  "bom principio piaui|PI":        ["Bom Principio do Piaui"],
  "dois irmaos buriti|MS":         ["Dois Irmaos do Buriti"],
  "bandeirantes tocant|TO":        ["Bandeirantes do Tocantins"],
  "divinopolis tocant|TO":         ["Divinopolis do Tocantins"],
  "dois irmaos tocant|TO":         ["Dois Irmaos do Tocantins"],
  "bom jesus tocantins|TO":        ["Bom Jesus do Tocantins"],
  "brasilandia tocant|TO":         ["Brasilandia do Tocantins"],
  "com levy gasparian|RJ":         ["Levy Gasparian", "Comendador Levy Gasparian"],
  "bom jesus itabapoana|RJ":       ["Bom Jesus do Itabapoana"],
  "amparo sao francisco|SE":       ["Amparo do Sao Francisco", "Amparo de Sao Francisco"],
};

// Remove diacríticos usando comparação numérica de codepoint (evita ambiguidade de regex)
function removerDiacriticos(s: string): string {
  return s.normalize("NFD").split("").filter(
    (c) => c.charCodeAt(0) < 0x0300 || c.charCodeAt(0) > 0x036f,
  ).join("");
}

function normalizar(s: string): string {
  return removerDiacriticos(s)
    .replace(/['''ʼ]/g, "")
    .replace(/-/g, " ")
    .replace(/[().]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

interface CidadeRow {
  codcid: number;
  nomecid: string;
  uf: string;
}

interface IbgeMunicipio {
  id: number;
  nome: string;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Busca todas as cidades paginando (PostgREST tem max_rows=1000 no servidor)
  const cidades: CidadeRow[] = [];
  const PAGE = 1000;
  let offset = 0;

  while (true) {
    let q = supabase
      .from("cidade")
      .select("codcid, nomecid, uf")
      .range(offset, offset + PAGE - 1);
    if (!force) q = q.is("codibge", null);

    const { data, error } = await q;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    if (!data || data.length === 0) break;

    cidades.push(...(data as CidadeRow[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  if (cidades.length === 0) {
    return new Response(
      JSON.stringify({ success: true, mensagem: "Nenhuma cidade pendente.", atualizadas: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Agrupa por sigla IBGE, ignorando estrangeiras
  const porSigla = new Map<string, CidadeRow[]>();
  const estrangeiras: string[] = [];

  for (const c of cidades as CidadeRow[]) {
    const sigla = SANKHYA_UF[c.uf] ?? (/^[A-Za-z]{2}$/.test(c.uf ?? "") ? c.uf.toUpperCase() : null);
    if (!sigla) {
      estrangeiras.push(`${c.nomecid} (coduf=${c.uf})`);
      continue;
    }
    if (!porSigla.has(sigla)) porSigla.set(sigla, []);
    porSigla.get(sigla)!.push(c);
  }

  const updates: { codcid: number; codibge: number }[] = [];
  const semMatch: string[] = [];

  // Para cada UF consulta IBGE e faz match (correlação sempre com a mesma UF)
  for (const [sigla, cidadesUf] of porSigla) {
    const res = await fetch(`${IBGE_BASE}/${sigla}/municipios`);
    if (!res.ok) {
      semMatch.push(...cidadesUf.map((c) => `${c.nomecid}/${sigla} (erro API IBGE ${res.status})`));
      continue;
    }

    const municipios: IbgeMunicipio[] = await res.json();

    const ibgeMap = new Map<string, number>();
    for (const m of municipios) {
      ibgeMap.set(normalizar(m.nome), m.id);
    }

    for (const cidade of cidadesUf) {
      const normSankhya = normalizar(cidade.nomecid);

      // Tentativa direta
      let codibge = ibgeMap.get(normSankhya);

      // Fallback: dicionário de exceções (mantém correlação com a mesma UF)
      if (codibge === undefined) {
        const candidatos = EXCECOES[`${normSankhya}|${sigla}`];
        if (candidatos) {
          for (const candidato of candidatos) {
            codibge = ibgeMap.get(normalizar(candidato));
            if (codibge !== undefined) break;
          }
        }
      }

      if (codibge !== undefined) {
        updates.push({ codcid: cidade.codcid, codibge });
      } else {
        semMatch.push(`${cidade.nomecid}/${sigla}`);
      }
    }
  }

  // Desduplicar por codibge (Sankhya pode ter cidades duplicadas mapeando para o mesmo município IBGE)
  const seenCodibge = new Set<number>();
  const updatesFinais = updates.filter(({ codibge }) => {
    if (seenCodibge.has(codibge)) return false;
    seenCodibge.add(codibge);
    return true;
  });

  // Atualiza tudo em uma única chamada SQL via RPC (evita milhares de HTTP calls)
  let atualizadas = 0;
  let erroRpc: string | null = null;

  if (updatesFinais.length > 0) {
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "update_codibge_batch",
      { updates: updatesFinais },
    );
    if (rpcError) {
      erroRpc = rpcError.message;
    } else {
      atualizadas = (rpcData as { atualizadas: number }).atualizadas;
    }
  }

  return new Response(
    JSON.stringify({
      success: erroRpc === null,
      total_lido: cidades.length,
      brasileiras: cidades.length - estrangeiras.length,
      atualizadas,
      sem_match: semMatch.length,
      sem_match_lista: semMatch,
      estrangeiras: estrangeiras.length,
      ...(erroRpc ? { erro_rpc: erroRpc } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
