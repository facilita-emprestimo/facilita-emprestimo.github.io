-- Saúde do Portal: falhas registradas pelas funções (Lia, leitura de documentos, e-mails).
-- Lida pela checagem diária (saude_02). Só administradores enxergam; escrita pelas funções (service role / security definer).
create table if not exists public.saude_eventos (
  id bigint generated always as identity primary key,
  componente text not null,          -- lia | lia-leitura | email | cron ...
  ok boolean not null default false,
  detalhe text,
  criado_em timestamptz not null default now()
);
create index if not exists saude_eventos_criado_em_idx on public.saude_eventos (criado_em desc);
alter table public.saude_eventos enable row level security;
create policy saude_eventos_admin_select on public.saude_eventos
  for select to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));
