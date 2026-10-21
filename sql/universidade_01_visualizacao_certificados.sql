-- =====================================================================
-- Universidade Facilita — passo 1
--   1. Registro de quanto do vídeo cada colaborador ASSISTIU de fato
--   2. "Concluído" só libera depois de assistir 90% (vídeos do YouTube ou enviados)
--   3. Certificado salvo no banco, com código único e verificação pública
--   4. Relatório do gestor (quem concluiu o quê)
--
-- Só ADICIONA tabelas, colunas e funções. Não apaga dados existentes.
-- Pode rodar mais de uma vez sem problema.
-- Rodar no Supabase: projeto facilita-portal-interno > SQL Editor > New query > colar > Run.
-- JÁ APLICADO em produção em 21/10/2026.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Configuração: percentual mínimo assistido para liberar "Concluído"
-- ---------------------------------------------------------------------
create or replace function public.univ_percentual_minimo()
returns numeric language sql immutable as $$ select 0.90::numeric $$;

-- Duração oficial do vídeo (segundos). Preenchida automaticamente na
-- primeira vez que alguém abre a aula (normalmente quem publicou).
alter table public.documents add column if not exists duracao_seg integer;

-- O que conta como "aula" dentro de um curso (mesma regra do portal).
create or replace function public.univ_eh_aula(d public.documents)
returns boolean language sql stable as $$
  select coalesce(d.is_aula, false)
      or lower(coalesce(d.file_type, '')) in ('mp4','webm','mov','avi','mkv','m4v')
$$;

-- Aula com vídeo que o portal consegue medir (YouTube ou arquivo de vídeo enviado).
-- Links do Drive/outros não dão para medir: continuam com "Marcar como concluído" manual.
create or replace function public.univ_aula_rastreavel(d public.documents)
returns boolean language sql stable as $$
  select coalesce(d.link_externo, '') ~* '(youtube\.com|youtu\.be)'
      or (d.storage_path is not null and lower(coalesce(d.file_type, '')) in ('mp4','webm','mov','m4v'))
$$;

-- ---------------------------------------------------------------------
-- 1. Visualizações (quanto cada pessoa assistiu de cada aula)
-- ---------------------------------------------------------------------
create table if not exists public.aula_visualizacoes (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  segundos_assistidos integer not null default 0,  -- tempo REAL de reprodução (pular o vídeo não conta)
  ultima_posicao integer not null default 0,       -- para "continuar de onde parou"
  iniciado_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (documento_id, user_id)
);
create index if not exists aula_visualizacoes_user_idx on public.aula_visualizacoes(user_id);

alter table public.aula_visualizacoes enable row level security;

-- Ninguém grava direto na tabela: só pela função registrar_visualizacao (abaixo),
-- que limita quanto tempo pode ser somado a cada chamada.
drop policy if exists visualizacoes_select on public.aula_visualizacoes;
create policy visualizacoes_select on public.aula_visualizacoes for select to authenticated
  using (user_id = auth.uid() or public.has_permission('universidade.relatorios'));

-- Registra tempo assistido. O navegador manda o total que ele contou; o banco aceita
-- no máximo o tempo que passou desde o último registro (x2,2 para quem assiste em 2x,
-- + folga de 20s). Assim não dá para "assistir" 1 hora de vídeo em 1 minuto.
create or replace function public.registrar_visualizacao(
  p_documento uuid, p_segundos integer, p_posicao integer, p_duracao integer
) returns public.aula_visualizacoes
language plpgsql security definer set search_path = public as $$
declare
  v_doc public.documents;
  v_row public.aula_visualizacoes;
  v_dur integer;
  v_permitido integer;
  v_novo integer;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;

  -- Só registra aulas que a pessoa pode ver (respeita a permissão da pasta).
  select d.* into v_doc from public.documents d
   join public.folders f on f.id = d.folder_id
   where d.id = p_documento
     and (f.allow_all or exists (select 1 from public.profiles p where p.id = auth.uid()
                                  and (p.is_admin or p.role = any (f.allowed_roles))));
  if not found then raise exception 'aula não encontrada'; end if;

  -- Primeira duração informada vira a duração oficial da aula.
  if v_doc.duracao_seg is null and coalesce(p_duracao, 0) > 0 then
    update public.documents set duracao_seg = p_duracao where id = p_documento;
    v_doc.duracao_seg := p_duracao;
  end if;
  v_dur := coalesce(v_doc.duracao_seg, 0);

  select * into v_row from public.aula_visualizacoes
   where documento_id = p_documento and user_id = auth.uid() for update;

  if not found then
    v_novo := least(greatest(coalesce(p_segundos, 0), 0), 30);
    if v_dur > 0 then v_novo := least(v_novo, v_dur); end if;
    insert into public.aula_visualizacoes(documento_id, user_id, segundos_assistidos, ultima_posicao)
      values (p_documento, auth.uid(), v_novo, greatest(coalesce(p_posicao, 0), 0))
      returning * into v_row;
    return v_row;
  end if;

  v_permitido := v_row.segundos_assistidos
               + ceil(extract(epoch from (now() - v_row.updated_at)) * 2.2)::integer + 20;
  v_novo := least(greatest(coalesce(p_segundos, 0), v_row.segundos_assistidos), v_permitido);
  if v_dur > 0 then v_novo := least(v_novo, v_dur); end if;

  update public.aula_visualizacoes
     set segundos_assistidos = v_novo,
         ultima_posicao = greatest(coalesce(p_posicao, 0), 0),
         updated_at = now()
   where id = v_row.id
   returning * into v_row;
  return v_row;
end $$;
grant execute on function public.registrar_visualizacao(uuid, integer, integer, integer) to authenticated;

-- Pode marcar como concluída? Vídeo rastreável exige 90% assistido; o resto é livre.
create or replace function public.univ_pode_concluir(p_documento uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.documents d
     where d.id = p_documento
       and (
         not public.univ_aula_rastreavel(d)
         or exists (
           select 1 from public.aula_visualizacoes v
            where v.documento_id = d.id and v.user_id = auth.uid()
              and coalesce(d.duracao_seg, 0) > 0
              and v.segundos_assistidos >= floor(d.duracao_seg * public.univ_percentual_minimo())
         )
       )
  )
$$;
grant execute on function public.univ_pode_concluir(uuid) to authenticated;

-- Regra nova de "marcar como concluído" (antes bastava clicar).
-- Políticas RESTRITIVAS: somam-se às que já existem sem precisar apagá-las.
drop policy if exists univ_concluir_exige_video on public.aula_progresso;
create policy univ_concluir_exige_video on public.aula_progresso as restrictive for insert to authenticated
  with check (public.univ_pode_concluir(documento_id));

-- Antes qualquer pessoa logada via o progresso de todo mundo. Agora: o próprio ou quem tem relatório.
drop policy if exists univ_progresso_privado on public.aula_progresso;
create policy univ_progresso_privado on public.aula_progresso as restrictive for select to authenticated
  using (user_id = auth.uid() or public.has_permission('universidade.relatorios'));

-- ---------------------------------------------------------------------
-- 2. Certificados (salvos, com código único e verificáveis)
-- ---------------------------------------------------------------------
create table if not exists public.certificados (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  aluno_nome text not null,          -- "foto" do momento da emissão
  curso_nome text not null,
  carga_horaria_min integer,
  total_aulas integer not null,
  inicio_em timestamptz,
  concluido_em timestamptz not null,
  emitido_em timestamptz not null default now(),
  revogado_em timestamptz,
  unique (user_id, folder_id)
);
alter table public.certificados enable row level security;

drop policy if exists certificados_select on public.certificados;
create policy certificados_select on public.certificados for select to authenticated
  using (user_id = auth.uid() or public.has_permission('universidade.relatorios'));
-- Sem insert/update direto: só pela função emitir_certificado.

-- Emite (ou devolve o já emitido) certificado do curso = pasta da Trilha.
-- O banco confere se TODAS as aulas foram concluídas; o navegador não decide isso.
create or replace function public.emitir_certificado(p_folder uuid)
returns public.certificados
language plpgsql security definer set search_path = public as $$
declare
  v_folder public.folders;
  v_cert public.certificados;
  v_total integer;
  v_feitas integer;
  v_inicio timestamptz;
  v_fim timestamptz;
  v_nome text;
  v_codigo text;
  v_seg integer;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;

  select * into v_cert from public.certificados where user_id = auth.uid() and folder_id = p_folder;
  if found then return v_cert; end if;

  select f.* into v_folder from public.folders f
   where f.id = p_folder and f.area = 'trilha-conhecimento'
     and (f.allow_all or exists (select 1 from public.profiles p where p.id = auth.uid()
                                  and (p.is_admin or p.role = any (f.allowed_roles))));
  if not found then raise exception 'curso não encontrado'; end if;

  select count(*), count(ap.id), min(coalesce(v.iniciado_at, ap.concluido_at)), max(ap.concluido_at),
         sum(d.duracao_seg)
    into v_total, v_feitas, v_inicio, v_fim, v_seg
    from public.documents d
    left join public.aula_progresso ap on ap.documento_id = d.id and ap.user_id = auth.uid()
    left join public.aula_visualizacoes v on v.documento_id = d.id and v.user_id = auth.uid()
   where d.folder_id = p_folder and public.univ_eh_aula(d);

  if v_total = 0 then raise exception 'este curso não tem aulas'; end if;
  if v_feitas < v_total then
    raise exception 'curso incompleto: % de % aulas concluídas', v_feitas, v_total;
  end if;

  select coalesce(nullif(trim(full_name), ''), email) into v_nome from public.profiles where id = auth.uid();

  loop
    v_codigo := 'FAC-' || upper(substr(md5(gen_random_uuid()::text), 1, 4)) || '-' ||
                upper(substr(md5(gen_random_uuid()::text), 1, 4));
    exit when not exists (select 1 from public.certificados where codigo = v_codigo);
  end loop;

  insert into public.certificados(codigo, user_id, folder_id, aluno_nome, curso_nome,
                                  carga_horaria_min, total_aulas, inicio_em, concluido_em)
  values (v_codigo, auth.uid(), p_folder, coalesce(v_nome, 'Colaborador(a)'), v_folder.name,
          -- carga horária: a definida no curso; se não houver, a soma da duração dos vídeos
          coalesce(v_folder.carga_horaria_min, ceil(v_seg / 60.0)::integer), v_total, v_inicio, coalesce(v_fim, now()))
  returning * into v_cert;
  return v_cert;
end $$;
grant execute on function public.emitir_certificado(uuid) to authenticated;

-- Verificação PÚBLICA (sem login), usada pela página verificar.html.
-- Devolve só o necessário para conferir — nada de e-mail ou ids internos.
create or replace function public.verificar_certificado(p_codigo text)
returns table (codigo text, aluno_nome text, curso_nome text, carga_horaria_min integer,
               total_aulas integer, concluido_em timestamptz, emitido_em timestamptz, valido boolean)
language sql stable security definer set search_path = public as $$
  select c.codigo, c.aluno_nome, c.curso_nome, c.carga_horaria_min, c.total_aulas,
         c.concluido_em, c.emitido_em, (c.revogado_em is null)
    from public.certificados c
   where c.codigo = upper(trim(p_codigo))
$$;
grant execute on function public.verificar_certificado(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Relatório do gestor: uma linha por colaborador x curso
--    (só cursos que a pessoa tem permissão de ver)
-- ---------------------------------------------------------------------
create or replace function public.universidade_relatorio()
returns table (user_id uuid, nome text, email text, role text, folder_id uuid, curso text,
               total_aulas integer, concluidas integer, ultima_atividade timestamptz,
               certificado text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_permission('universidade.relatorios') then
    raise exception 'sem permissão para o relatório da Universidade';
  end if;
  return query
  with cursos as (
    select f.id, f.name, f.allow_all, f.allowed_roles, count(d.id)::integer as total
      from public.folders f
      join public.documents d on d.folder_id = f.id and public.univ_eh_aula(d)
     where f.area = 'trilha-conhecimento'
     group by f.id
  )
  select p.id, coalesce(nullif(trim(p.full_name), ''), p.email), p.email, p.role::text,
         c.id, c.name, c.total,
         (select count(*)::integer from public.aula_progresso ap
            join public.documents d on d.id = ap.documento_id
           where ap.user_id = p.id and d.folder_id = c.id and public.univ_eh_aula(d)),
         (select max(x.t) from (
            select ap.concluido_at t from public.aula_progresso ap
              join public.documents d on d.id = ap.documento_id
             where ap.user_id = p.id and d.folder_id = c.id
            union all
            select v.updated_at from public.aula_visualizacoes v
              join public.documents d on d.id = v.documento_id
             where v.user_id = p.id and d.folder_id = c.id) x),
         (select ce.codigo from public.certificados ce
           where ce.user_id = p.id and ce.folder_id = c.id and ce.revogado_em is null)
    from public.profiles p
    join cursos c on (c.allow_all or p.role = any (c.allowed_roles) or p.is_admin)
   where coalesce(p.active, true)
   order by 2, 6;
end $$;
grant execute on function public.universidade_relatorio() to authenticated;

-- Permissão nova (aparece em Administração > Permissões). Diretor já vê por ser admin.
insert into public.role_permissions(role, permission_key, allowed)
select r, 'universidade.relatorios', r in ('diretor','coordenador')
  from unnest(enum_range(null::app_role)) r
on conflict (role, permission_key) do nothing;
