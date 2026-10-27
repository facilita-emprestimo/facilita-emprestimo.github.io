import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import JSZip from "npm:jszip@3.10.1";

// Lia: lê o conteúdo dos documentos do portal e guarda em ai_documentos_texto.
// Quem pode chamar: administrador (qualquer documento, ou os pendentes em lote)
// ou quem acabou de enviar o arquivo (só o próprio documento).

const BUCKET = "documentos";
const MAX_TEXTO = 40000;
const IMAGENS = ["png", "jpg", "jpeg", "jfif", "webp", "gif"];
const OFFICE = ["docx", "pptx", "xlsx"];
const LIDOS = ["pdf", ...IMAGENS, ...OFFICE];
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_OFFICE_BYTES = 40 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function openai(body: unknown) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + Deno.env.get("OPENAI_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Erro na OpenAI");
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

const PEDIDO_LEITURA = `Você vai ler um documento interno da Facilita (correspondente bancário de crédito consignado).
Responda SOMENTE em JSON, no formato {"resumo": "...", "texto": "..."}.
- "resumo": 1 a 3 frases dizendo do que o documento trata e para que serve (ex.: "POP que explica...", "Arte de bom dia para redes sociais").
- "texto": transcreva fielmente TODO o texto do documento, sem resumir e sem inventar. Mantenha números, prazos, nomes de bancos, convênios e passos exatamente como estão. Em FAQ, use "P:" para pergunta e "R:" para resposta. Se for imagem sem texto relevante, deixe "texto" com uma descrição curta do que a imagem mostra.`;

function parseLeitura(raw: string) {
  try {
    const o = JSON.parse(raw);
    return { resumo: String(o.resumo || "").slice(0, 600), texto: String(o.texto || "").slice(0, MAX_TEXTO) };
  } catch {
    return { resumo: "", texto: raw.slice(0, MAX_TEXTO) };
  }
}

// Extrai o texto de Word, PowerPoint e Excel lendo o XML de dentro do arquivo.
async function textoOffice(bytes: Uint8Array, ext: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const pegar = (xml: string, tag: string) => {
    const re = new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g");
    const out: string[] = [];
    let m;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
  };
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  if (ext === "docx") {
    const xml = await zip.file("word/document.xml")?.async("string") || "";
    return xml.split(/<\/w:p>/).map((p) => pegar(p, "w:t").join("")).filter(Boolean).map(decode).join("\n");
  }
  if (ext === "pptx") {
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.replace(/\D/g, "")) - parseInt(b.replace(/\D/g, "")));
    const partes: string[] = [];
    for (const [i, n] of slides.entries()) {
      const xml = await zip.file(n)!.async("string");
      const linhas = xml.split(/<\/a:p>/).map((p) => pegar(p, "a:t").join("")).filter(Boolean).map(decode);
      if (linhas.length) partes.push(`[Slide ${i + 1}]\n` + linhas.join("\n"));
    }
    return partes.join("\n\n");
  }
  const xml = await zip.file("xl/sharedStrings.xml")?.async("string") || "";
  return pegar(xml, "t").map(decode).join(" | ");
}

async function lerDocumento(admin: any, doc: any) {
  const ext = String(doc.file_type || "").toLowerCase();
  if (!doc.storage_path || !LIDOS.includes(ext)) return { status: "ignorado", erro: "Tipo de arquivo não lido pela Lia (" + (ext || "sem arquivo") + ")" };
  const nome = (doc.codigo ? doc.codigo + " — " : "") + doc.name;

  if (IMAGENS.includes(ext)) {
    const signed = await admin.storage.from(BUCKET).createSignedUrl(doc.storage_path, 600);
    if (signed.error) throw new Error(signed.error.message);
    const raw = await openai({
      model: "gpt-4o-mini", temperature: 0, max_tokens: 3000, response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: PEDIDO_LEITURA + "\nNome do arquivo: " + nome },
        { type: "image_url", image_url: { url: signed.data.signedUrl, detail: "high" } },
      ] }],
    });
    return { status: "ok", ...parseLeitura(raw) };
  }

  const dl = await admin.storage.from(BUCKET).download(doc.storage_path);
  if (dl.error || !dl.data) throw new Error("Não foi possível baixar o arquivo");
  const bytes = new Uint8Array(await dl.data.arrayBuffer());

  if (ext === "pdf") {
    if (bytes.length > MAX_PDF_BYTES) return { status: "ignorado", erro: "PDF grande demais para leitura automática" };
    const raw = await openai({
      model: "gpt-4o-mini", temperature: 0, max_tokens: 16000, response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "file", file: { filename: "documento.pdf", file_data: "data:application/pdf;base64," + encodeBase64(bytes) } },
        { type: "text", text: PEDIDO_LEITURA + "\nNome do arquivo: " + nome },
      ] }],
    });
    return { status: "ok", ...parseLeitura(raw) };
  }

  if (bytes.length > MAX_OFFICE_BYTES) return { status: "ignorado", erro: "Arquivo grande demais para leitura automática" };
  const texto = (await textoOffice(bytes, ext)).slice(0, MAX_TEXTO);
  if (!texto.trim()) return { status: "ok", resumo: "", texto: "" };
  const resumo = await openai({
    model: "gpt-4o-mini", temperature: 0, max_tokens: 200,
    messages: [{ role: "user", content: "Em 1 a 3 frases, diga do que trata este documento interno da Facilita e para que serve. Nome: " + nome + "\n\n" + texto.slice(0, 12000) }],
  });
  return { status: "ok", resumo: resumo.slice(0, 600), texto };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u || !u.user) return json({ error: "Login necessário." }, 401);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: perfil } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).maybeSingle();
    const isAdmin = !!(perfil && perfil.is_admin);

    const body = await req.json().catch(() => ({}));
    let docs: any[] = [];
    if (body.document_id) {
      const { data } = await admin.from("documents").select("id, name, codigo, file_type, storage_path, uploaded_by").eq("id", body.document_id).maybeSingle();
      if (!data) return json({ error: "Documento não encontrado." }, 404);
      if (!isAdmin && data.uploaded_by !== u.user.id) return json({ error: "Sem permissão." }, 403);
      docs = [data];
    } else {
      // Lote de pendentes: só administrador.
      if (!isAdmin) return json({ error: "Só administradores podem atualizar a leitura em lote." }, 403);
      const limite = Math.min(Math.max(parseInt(body.limite) || 3, 1), 5);
      const [{ data: todos }, { data: lidos }] = await Promise.all([
        admin.from("documents").select("id, name, codigo, file_type, storage_path").order("created_at", { ascending: false }).limit(3000),
        admin.from("ai_documentos_texto").select("document_id").limit(5000),
      ]);
      const feitos = new Set((lidos || []).map((r: any) => r.document_id));
      const pendentes = (todos || []).filter((d: any) => !feitos.has(d.id));
      docs = pendentes.slice(0, limite);
      body._restantes = Math.max(pendentes.length - docs.length, 0);
    }

    const resultados: any[] = [];
    for (const doc of docs) {
      let r: any;
      try { r = await lerDocumento(admin, doc); }
      catch (e) { r = { status: "erro", erro: String((e as Error).message || e).slice(0, 500) }; }
      await admin.from("ai_documentos_texto").upsert({
        document_id: doc.id, status: r.status, resumo: r.resumo || null, texto: r.texto || null,
        erro: r.erro || null, atualizado_em: new Date().toISOString(),
      });
      resultados.push({ id: doc.id, nome: doc.name, status: r.status, erro: r.erro || null });
    }
    return json({ processados: resultados, restantes: body._restantes ?? 0 });
  } catch (e) {
    return json({ error: "Erro inesperado: " + String((e as Error).message || e) }, 500);
  }
});
