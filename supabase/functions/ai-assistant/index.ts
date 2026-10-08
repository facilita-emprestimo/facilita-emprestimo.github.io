import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PORTAL_URL = "https://facilita-emprestimo.github.io/";

const SYSTEM_PROMPT_BASE = `Você é a assistente do Portal Interno da Facilita Empréstimo (correspondente bancário de crédito consignado em São Luís/MA). Ajuda colaboradores a (1) achar coisas no Portal, (2) tirar dúvidas sobre processos e produtos da Facilita e (3) responder sobre os convênios/bancos que estão na Base de Conhecimento (mais abaixo).

FORMA DE RESPONDER (obrigatório):
- Seja objetiva. Vá direto ao ponto: sem saudação, sem introdução, sem repetir a pergunta.
- No máximo 4 linhas curtas. Use lista só quando houver passos.
- Português do Brasil, linguagem simples.

QUANDO PERGUNTAREM "ONDE ESTÁ / ONDE ACHO / COMO ACESSO" ALGO:
- Procure SOMENTE no "MAPA DO PORTAL" abaixo (pastas e documentos reais, já filtrados pelo que esta pessoa pode ver). Compare por palavras parecidas, sem acento e sem diferenciar maiúsculas (ex.: "script de vídeo" = "Video Chamada" = "roteiro de videochamada").
- Responda exatamente neste formato, copiando o caminho e o link do mapa sem alterar nada:
  Caminho: <caminho do mapa>
  [Abrir agora](<link do mapa>)
- Se houver mais de um resultado, liste até 3, cada um com caminho e link.
- Se não estiver no mapa, diga: "Não encontrei isso no portal." e sugira usar a busca da Biblioteca ou de Documentos. NUNCA invente pasta, caminho ou link.

SOBRE A FACILITA:
- Crédito consignado para servidores estaduais, municipais, federais e aposentados/pensionistas do INSS.
- Produtos: empréstimo novo, refinanciamento, compra de dívida, portabilidade, cartão consignado e cartão benefício (saque), saque complementar, empréstimo pessoal via Banco do Brasil.
- Departamentos: Comercial, Back Office e Administrativo.

PÁGINAS DO PORTAL (menu lateral) e links diretos:
- Home: ${PORTAL_URL}#pagina=home
- Prioridades do Dia (ordem de bancos por convênio/produto): ${PORTAL_URL}#pagina=prioridades
- Comunicados: ${PORTAL_URL}#pagina=comunicados · Informativos: ${PORTAL_URL}#pagina=informativos
- Fala aí! (Sugestões): ${PORTAL_URL}#pagina=sugestoes · Enquetes: ${PORTAL_URL}#pagina=enquetes
- Marketing (artes e campanhas): ${PORTAL_URL}#pagina=marketing
- Documentos (arquivos por pasta): ${PORTAL_URL}#pagina=documentos
- Biblioteca (POPs e Regras): circulares, regras, POPs, roteiros de atendimento, scripts de videochamada, manuais: ${PORTAL_URL}#pagina=biblioteca
- Lojas (unidades e colaboradores): ${PORTAL_URL}#pagina=unidades
- Pessoas e Cultura: ${PORTAL_URL}#pagina=pessoas-cultura · Sobre Nós: ${PORTAL_URL}#pagina=sobre-nos
- Trilha do Conhecimento (treinamentos e roteiros por convênio): ${PORTAL_URL}#pagina=trilha-conhecimento
- Calendário: ${PORTAL_URL}#pagina=calendario · Tarefas: ${PORTAL_URL}#pagina=tarefas · Chamados: ${PORTAL_URL}#pagina=chamados · Planos de Ação: ${PORTAL_URL}#pagina=planos-acao
- Ferramentas (bloco na Home): E-mail UOL Host, CRM Live Cred e Konnect, Ponto (Tiquetaque), Tabela de Prioridades completa.

OUTRAS REGRAS:
- Qual banco oferecer / prioridade / tabela / prazo: use "PRIORIDADES COMERCIAIS VIGENTES". Diga o 1º banco, a tabela/prazo e as exceções. Se o 1º não liberou, indique o próximo. Se não houver prioridade para o convênio/produto, diga isso e oriente o Back Office.
- Dúvida sobre convênio/banco: use a "BASE DE CONHECIMENTO POR CONVÊNIO/BANCO" e informe o link quando existir. Se o convênio não estiver lá, diga que o roteiro ainda não foi cadastrado e oriente o Back Office.
- Se não tiver certeza (comissão, política interna, dados de pessoas), diga que não sabe e indique supervisor, RH, Back Office ou administrador. Não invente.
- Você não vê dados em tempo real (tarefas de alguém, propostas, margem de cliente).
- Não peça nem processe senhas, dados bancários ou documentos pessoais.`;

const AREA_LABEL: Record<string, string> = {
  "documentos": "Documentos",
  "marketing": "Marketing",
  "pessoas-cultura": "Pessoas e Cultura",
  "sobre-nos": "Sobre Nós",
  "trilha-conhecimento": "Trilha do Conhecimento",
  "biblioteca": "Biblioteca (POPs e Regras)",
};

function formatDateBR(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("pt-BR");
  } catch {
    return iso;
  }
}

function adminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

// Cliente com o login de quem perguntou: as políticas de acesso (RLS) filtram só o que a pessoa pode ver.
function userClient(authHeader: string | null) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  return createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
}

async function buildMapaPortal(authHeader: string | null): Promise<string> {
  const supabase = userClient(authHeader);
  if (!supabase) return "MAPA DO PORTAL: (indisponível no momento)";
  try {
    const [fRes, dRes] = await Promise.all([
      supabase.from("folders").select("id, name, area, parent_id").limit(2000),
      supabase.from("documents").select("*").limit(3000),
    ]);
    if (fRes.error || !fRes.data) return "MAPA DO PORTAL: (indisponível no momento — erro ao consultar pastas)";
    const folders = fRes.data as any[];
    const byId: Record<string, any> = {};
    for (const f of folders) byId[f.id] = f;

    const caminho = (f: any): string => {
      const nomes: string[] = [];
      let atual = f, guard = 0;
      while (atual && guard++ < 12) {
        nomes.unshift(atual.name);
        atual = atual.parent_id ? byId[atual.parent_id] : null;
      }
      const raiz = f && (function () { let a = f, g = 0; while (a.parent_id && byId[a.parent_id] && g++ < 12) a = byId[a.parent_id]; return a; })();
      const area = AREA_LABEL[(raiz && raiz.area) || "documentos"] || "Documentos";
      return ["Menu", area, ...nomes].join(" › ");
    };

    const docsPorPasta: Record<string, any[]> = {};
    for (const d of (dRes.data || []) as any[]) {
      if (d.status === "revogado") continue;
      (docsPorPasta[d.folder_id] = docsPorPasta[d.folder_id] || []).push(d);
    }

    const linhas: string[] = [];
    const ordenadas = folders
      .map((f) => ({ f, c: caminho(f) }))
      .sort((a, b) => a.c.localeCompare(b.c, "pt-BR"));
    for (const { f, c } of ordenadas) {
      const docs = docsPorPasta[f.id] || [];
      linhas.push(`- PASTA: ${c} (${docs.length} arquivo(s)) | link: ${PORTAL_URL}#pasta=${f.id}`);
      for (const d of docs.slice(0, 40)) {
        const nome = (d.codigo ? d.codigo + " — " : "") + (d.name || "arquivo");
        const extra = d.palavras_chave ? ` | palavras-chave: ${d.palavras_chave}` : "";
        linhas.push(`    - ARQUIVO: ${nome}${extra} | caminho: ${c} | link: ${PORTAL_URL}#doc=${d.id}`);
      }
    }
    let texto = linhas.join("\n");
    if (texto.length > 60000) texto = texto.slice(0, 60000) + "\n(... mapa truncado)";
    return "MAPA DO PORTAL (pastas e arquivos reais que esta pessoa pode acessar; use estes caminhos e links exatamente como estão):\n" + texto;
  } catch (_e) {
    return "MAPA DO PORTAL: (indisponível no momento — erro ao consultar)";
  }
}

async function buildKnowledgeSection(): Promise<string> {
  const supabase = adminClient();
  if (!supabase) {
    return "BASE DE CONHECIMENTO POR CONVÊNIO/BANCO: (indisponível no momento — configuração do servidor incompleta)";
  }
  try {
    const { data, error } = await supabase
      .from("ai_conhecimento_bancos")
      .select("banco, titulo, conteudo, atualizado_em")
      .eq("ativo", true)
      .order("banco", { ascending: true });

    if (error || !data || !data.length) {
      return "BASE DE CONHECIMENTO POR CONVÊNIO/BANCO: nenhum roteiro operacional cadastrado ainda.";
    }

    const blocos = data.map((row: any) => {
      return `### ${row.titulo || row.banco} (atualizado em ${formatDateBR(row.atualizado_em)})\n${row.conteudo}`;
    });

    return "BASE DE CONHECIMENTO POR CONVÊNIO/BANCO (use estas informações sempre que a pergunta for sobre um destes convênios; cada bloco é o roteiro operacional oficial mais atual daquele convênio):\n\n" +
      blocos.join("\n\n---\n\n");
  } catch (_e) {
    return "BASE DE CONHECIMENTO POR CONVÊNIO/BANCO: (indisponível no momento — erro ao consultar)";
  }
}

async function buildPrioridadesSection(): Promise<string> {
  const supabase = adminClient();
  if (!supabase) return "PRIORIDADES COMERCIAIS VIGENTES: (indisponível no momento)";
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("prioridades_comerciais")
      .select("publico, produto, ordem, banco, tabela, prazo, regras, valido_ate, updated_at")
      .eq("ativo", true)
      .order("publico").order("produto").order("ordem");
    if (error || !data) return "PRIORIDADES COMERCIAIS VIGENTES: (indisponível no momento — erro ao consultar)";
    const vigentes = data.filter((r: any) => !r.valido_ate || r.valido_ate >= hoje);
    if (!vigentes.length) return "PRIORIDADES COMERCIAIS VIGENTES: nenhuma prioridade cadastrada.";
    const grupos: Record<string, any[]> = {};
    for (const r of vigentes) {
      const k = `${r.publico} — ${r.produto}`;
      (grupos[k] = grupos[k] || []).push(r);
    }
    const blocos = Object.entries(grupos).map(([k, itens]) => {
      const linhas = itens.map((r: any) => {
        let l = `${r.ordem}º ${r.banco}`;
        if (r.tabela) l += ` | Tabela: ${r.tabela}`;
        if (r.prazo) l += ` | Prazo: ${r.prazo}`;
        if (r.regras) l += ` | Exceções/regras: ${r.regras}`;
        if (r.valido_ate) l += ` | Válida até ${formatDateBR(r.valido_ate + "T12:00:00")}`;
        return "- " + l;
      });
      return `### ${k}\n${linhas.join("\n")}`;
    });
    return "PRIORIDADES COMERCIAIS VIGENTES (ordem oficial de oferta; o 1º é sempre o primeiro a oferecer):\n\n" + blocos.join("\n\n");
  } catch (_e) {
    return "PRIORIDADES COMERCIAIS VIGENTES: (indisponível no momento — erro ao consultar)";
  }
}

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            "A assistente ainda não foi configurada. Peça ao administrador para adicionar a chave da OpenAI (OPENAI_API_KEY) nos secrets do Supabase.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      return new Response(JSON.stringify({ error: "Nenhuma mensagem enviada." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
    const authHeader = req.headers.get("Authorization");
    const [knowledge, prioridades, mapa] = await Promise.all([
      buildKnowledgeSection(),
      buildPrioridadesSection(),
      buildMapaPortal(authHeader),
    ]);
    const systemPrompt = SYSTEM_PROMPT_BASE + "\n\n" + mapa + "\n\n" + prioridades + "\n\n" + knowledge;

    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        temperature: 0.2,
        messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-20)],
      }),
    });

    const data = await openaiResp.json();

    if (!openaiResp.ok) {
      const msg = (data && data.error && data.error.message) || "Erro ao consultar a assistente.";
      return new Response(JSON.stringify({ error: msg }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const text =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";

    return new Response(JSON.stringify({ reply: text.trim() || "Não consegui gerar uma resposta agora." }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (_err) {
    return new Response(JSON.stringify({ error: "Erro inesperado ao consultar a assistente." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
