-- =====================================================================
-- DP — EVENTOS MENSAIS (fechamento da folha)
-- ---------------------------------------------------------------------
-- O DP registra, ao longo do mês, as ocorrências de cada colaborador
-- (faltas, atrasos, atestados, férias, licenças, advertências, admissão,
-- desligamento...) e o resultado do mês (meta, realizado e prêmio).
-- No fim do mês o portal gera o relatório para conferência e envio à
-- contabilidade. Quando a competência é FECHADA, ninguém altera mais
-- (só o Administrador reabre).
--
-- Acesso: permissão 'dp.gerenciar' (RH/DP por padrão) + Administradores.
-- Dados de remuneração: NÃO ficam visíveis para os demais perfis.
-- =====================================================================

-- 1. Competências (mês de referência) -----------------------------------
create table if not exists public.dp_competencias (
  competencia date primary key check (extract(day from competencia) = 1),
  status text not null default 'aberta' check (status in ('aberta', 'fechada')),
  observacao text,
  fechada_em timestamptz,
  fechada_por uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles(id)
);
comment on table public.dp_competencias is 'DP: mês de referência dos eventos mensais. fechada = ninguém altera (só Administrador reabre).';

-- 2. Resultado do mês por colaborador -----------------------------------
create table if not exists public.dp_lancamentos (
  id uuid primary key default gen_random_uuid(),
  competencia date not null references public.dp_competencias(competencia) on delete cascade,
  colaborador_id uuid not null references public.colaboradores(id) on delete cascade,
  unidade_id uuid references public.unidades(id) on delete set null,
  meta numeric(14,2),
  realizado numeric(14,2),
  premio_valor numeric(12,2) not null default 0,
  outros_valores numeric(12,2) not null default 0,
  outros_descricao text,
  observacao text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles(id),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references public.profiles(id),
  unique (competencia, colaborador_id)
);
comment on table public.dp_lancamentos is 'DP: meta, realizado, prêmio e outros valores do colaborador no mês.';

-- 3. Ocorrências do mês -------------------------------------------------
create table if not exists public.dp_eventos (
  id uuid primary key default gen_random_uuid(),
  competencia date not null references public.dp_competencias(competencia) on delete cascade,
  colaborador_id uuid not null references public.colaboradores(id) on delete cascade,
  tipo text not null check (tipo in (
    'falta_injustificada', 'falta_justificada', 'atraso', 'atestado',
    'ferias', 'licenca', 'afastamento', 'folga',
    'advertencia', 'suspensao', 'admissao', 'desligamento', 'outro')),
  data_inicio date not null,
  data_fim date,
  dias numeric(5,1),
  minutos integer,
  observacao text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles(id),
  check (data_fim is null or data_fim >= data_inicio)
);
comment on table public.dp_eventos is 'DP: ocorrências do colaborador no mês (faltas, atrasos, atestados, férias, licenças etc.).';

create index if not exists dp_lancamentos_comp_idx on public.dp_lancamentos (competencia);
create index if not exists dp_eventos_comp_idx on public.dp_eventos (competencia, colaborador_id);

-- 4. Regras auxiliares --------------------------------------------------
create or replace function public.dp_competencia_aberta(p_comp date)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select c.status = 'aberta' from public.dp_competencias c where c.competencia = p_comp), true)
      or coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.dp_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists dp_lancamentos_touch on public.dp_lancamentos;
create trigger dp_lancamentos_touch before update on public.dp_lancamentos
  for each row execute function public.dp_touch();

-- Fechar/reabrir: grava quem e quando. Reabrir só Administrador.
create or replace function public.dp_competencia_status()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'fechada' and old.status is distinct from 'fechada' then
    new.fechada_em := now();
    new.fechada_por := auth.uid();
  elsif new.status = 'aberta' and old.status = 'fechada' then
    if not coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false) then
      raise exception 'Somente o Administrador pode reabrir uma competência fechada.';
    end if;
    new.fechada_em := null;
    new.fechada_por := null;
  end if;
  return new;
end $$;

drop trigger if exists dp_competencias_status on public.dp_competencias;
create trigger dp_competencias_status before update on public.dp_competencias
  for each row execute function public.dp_competencia_status();

-- 5. Segurança (RLS) ----------------------------------------------------
alter table public.dp_competencias enable row level security;
alter table public.dp_lancamentos enable row level security;
alter table public.dp_eventos enable row level security;

drop policy if exists dp_competencias_select on public.dp_competencias;
create policy dp_competencias_select on public.dp_competencias for select to authenticated
  using (public.has_permission('dp.gerenciar'));
drop policy if exists dp_competencias_insert on public.dp_competencias;
create policy dp_competencias_insert on public.dp_competencias for insert to authenticated
  with check (public.has_permission('dp.gerenciar'));
drop policy if exists dp_competencias_update on public.dp_competencias;
create policy dp_competencias_update on public.dp_competencias for update to authenticated
  using (public.has_permission('dp.gerenciar')) with check (public.has_permission('dp.gerenciar'));

drop policy if exists dp_lancamentos_select on public.dp_lancamentos;
create policy dp_lancamentos_select on public.dp_lancamentos for select to authenticated
  using (public.has_permission('dp.gerenciar'));
drop policy if exists dp_lancamentos_write on public.dp_lancamentos;
create policy dp_lancamentos_write on public.dp_lancamentos for all to authenticated
  using (public.has_permission('dp.gerenciar') and public.dp_competencia_aberta(competencia))
  with check (public.has_permission('dp.gerenciar') and public.dp_competencia_aberta(competencia));

drop policy if exists dp_eventos_select on public.dp_eventos;
create policy dp_eventos_select on public.dp_eventos for select to authenticated
  using (public.has_permission('dp.gerenciar'));
drop policy if exists dp_eventos_write on public.dp_eventos;
create policy dp_eventos_write on public.dp_eventos for all to authenticated
  using (public.has_permission('dp.gerenciar') and public.dp_competencia_aberta(competencia))
  with check (public.has_permission('dp.gerenciar') and public.dp_competencia_aberta(competencia));

-- 6. Permissão padrão: RH/DP ---------------------------------------------
insert into public.role_permissions (role, permission_key, allowed, updated_at)
values ('rh_dp', 'dp.gerenciar', true, now())
on conflict (role, permission_key) do update set allowed = excluded.allowed, updated_at = now();
