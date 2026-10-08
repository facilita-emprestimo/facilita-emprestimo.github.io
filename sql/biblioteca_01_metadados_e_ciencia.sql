-- Biblioteca Facilita — passo 1: metadados de documento + registro de ciência
-- Só ADICIONA campos e uma tabela nova. Não apaga nem altera dados existentes.
-- Rodar no Supabase: projeto facilita-portal-interno > SQL Editor > New query > colar > Run.

alter table public.documents
  add column if not exists codigo text,
  add column if not exists tipo text,
  add column if not exists versao text,
  add column if not exists status text not null default 'vigente',
  add column if not exists responsavel text,
  add column if not exists revisar_em date,
  add column if not exists exige_ciencia boolean not null default false,
  add column if not exists palavras_chave text;

alter table public.documents drop constraint if exists documents_status_check;
alter table public.documents add constraint documents_status_check
  check (status in ('vigente','em_revisao','revogado'));

create table if not exists public.documento_ciencias (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  versao text not null default '',
  created_at timestamptz not null default now(),
  unique (document_id, user_id, versao)
);
create index if not exists documento_ciencias_doc_idx on public.documento_ciencias(document_id);

alter table public.documento_ciencias enable row level security;

drop policy if exists ciencias_insert_own on public.documento_ciencias;
create policy ciencias_insert_own on public.documento_ciencias for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.documents d where d.id = document_id));

drop policy if exists ciencias_select on public.documento_ciencias;
create policy ciencias_select on public.documento_ciencias for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
    or public.has_permission('documentos.gerenciar')
  );

-- ---------------------------------------------------------------
-- Passo 2: nova área "biblioteca" e estrutura de pastas
-- ---------------------------------------------------------------
alter table public.folders drop constraint if exists folders_area_check;
alter table public.folders add constraint folders_area_check
  check (area = any (array['documentos','pessoas-cultura','sobre-nos','trilha-conhecimento','marketing','biblioteca']));

do $$
declare
  com app_role[] := '{diretor,coordenador,supervisor,lideres,consultores,multiplicadores,backoffice,analistas}';
  bo  app_role[] := '{diretor,coordenador,supervisor,backoffice,analistas}';
  adm app_role[] := '{diretor,coordenador,financeiro,rh_dp,analistas}';
  dono uuid := (select id from public.profiles where is_admin order by created_at nulls last limit 1);
  raiz_com uuid;
begin
  if exists (select 1 from public.folders where area = 'biblioteca') then
    raise notice 'Biblioteca já criada — nada a fazer.';
    return;
  end if;

  insert into public.folders(name, area, allow_all, allowed_roles, created_by)
    values ('Comercial', 'biblioteca', false, com, dono) returning id into raiz_com;
  insert into public.folders(name, area, allow_all, allowed_roles, created_by) values
    ('Back Office', 'biblioteca', false, bo, dono),
    ('Administrativo e Financeiro', 'biblioteca', false, adm, dono);

  insert into public.folders(name, parent_id, area, allow_all, allowed_roles, created_by) values
    ('01 · Circulares',                 raiz_com, 'biblioteca', false, com, dono),
    ('02 · Regras e Políticas',         raiz_com, 'biblioteca', false, com, dono),
    ('03 · POPs (Procedimentos)',       raiz_com, 'biblioteca', false, com, dono),
    ('04 · Segurança e Antifraude',     raiz_com, 'biblioteca', false, com, dono),
    ('05 · Roteiros de Atendimento',    raiz_com, 'biblioteca', false, com, dono),
    ('06 · Manuais de Sistemas',        raiz_com, 'biblioteca', false, com, dono),
    ('07 · PDE e Desenvolvimento',      raiz_com, 'biblioteca', false, com, dono);
end $$;
