-- Lia: texto lido de cada documento do portal (PDF, Word, PowerPoint, Excel e imagens).
-- Preenchido pela função lia-ler-documentos. A Lia só usa o texto de documentos que a pessoa pode ver
-- (a lista de documentos visíveis vem da consulta com o login de quem pergunta).
create table if not exists public.ai_documentos_texto (
  document_id uuid primary key references public.documents(id) on delete cascade,
  status text not null default 'ok',          -- ok | ignorado | erro
  resumo text,                                 -- 1 a 3 frases sobre o assunto do documento
  texto text,                                  -- texto completo (limitado a ~40 mil caracteres)
  erro text,
  atualizado_em timestamptz not null default now()
);

alter table public.ai_documentos_texto enable row level security;

-- Só administradores enxergam (para o painel de status). Escrita só pela função (service role).
create policy ai_documentos_texto_admin_select on public.ai_documentos_texto
  for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));
