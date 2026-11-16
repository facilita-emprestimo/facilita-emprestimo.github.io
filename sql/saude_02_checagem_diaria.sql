-- Checagem automática diária do Portal (07:00 de Brasília = 10:00 UTC).
-- Confere se as rotinas e funções estão funcionando e manda um e-mail de alerta SÓ quando algo está errado.
-- O resultado de cada dia fica em saude_checagens (também quando está tudo bem).
-- Destinatários do alerta: portal_config.alerta_emails (lista separada por vírgula).

create table if not exists public.portal_config (
  chave text primary key,
  valor text,
  atualizado_em timestamptz not null default now()
);
alter table public.portal_config enable row level security;
create policy portal_config_admin_all on public.portal_config
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

create table if not exists public.saude_checagens (
  id bigint generated always as identity primary key,
  feita_em timestamptz not null default now(),
  ok boolean not null,
  problemas jsonb not null default '[]'::jsonb
);
alter table public.saude_checagens enable row level security;
create policy saude_checagens_admin_select on public.saude_checagens
  for select to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

create or replace function public.fn_checagem_diaria()
returns jsonb
language plpgsql
security definer
set search_path = public, cron, storage
as $$
declare
  p text[] := '{}';
  n int;
  t text;
  v_ultima timestamptz;
  v_dest text;
  v_html text;
  e text;
begin
  -- 1) Falhas registradas pelas funções nas últimas 24h (Lia, leitura de documentos, e-mails).
  for t, n in
    select componente, count(*) from public.saude_eventos
     where not ok and criado_em > now() - interval '24 hours' and componente <> 'checagem'
     group by componente
  loop
    p := p || format('%s falha(s) em "%s" nas últimas 24h. Exemplo: %s', n, t,
      (select detalhe from public.saude_eventos where componente = t and not ok order by criado_em desc limit 1));
  end loop;

  -- 2) E-mails parados na fila.
  select count(*) into n from public.email_fila where status in ('pendente', 'enviando') and criado_em < now() - interval '30 minutes';
  if n > 0 then p := p || format('%s e-mail(s) parados na fila há mais de 30 minutos.', n); end if;

  -- 3) Rotinas agendadas: falharam ou pararam de rodar.
  for t, n in
    select j.jobname, count(*) from cron.job_run_details d join cron.job j using (jobid)
     where d.status = 'failed' and d.start_time > now() - interval '24 hours' group by j.jobname
  loop
    p := p || format('Rotina "%s" falhou %s vez(es) nas últimas 24h.', t, n);
  end loop;
  for t, v_ultima in
    select j.jobname, max(d.start_time) from cron.job j left join cron.job_run_details d using (jobid)
     where j.active group by j.jobname
  loop
    if (t = 'lembretes-calendario-diario' and (v_ultima is null or v_ultima < now() - interval '26 hours'))
       or (t = 'email-fila' and (v_ultima is null or v_ultima < now() - interval '15 minutes'))
       or (t = 'lia-ler-documentos' and (v_ultima is null or v_ultima < now() - interval '30 minutes')) then
      p := p || format('Rotina "%s" não roda desde %s.', t, coalesce(to_char(v_ultima at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca'));
    end if;
  end loop;

  -- 4) Leitura de documentos da Lia atrasada (arquivo enviado há mais de 1h e ainda não lido).
  select count(*) into n from public.documents d
   where d.storage_path is not null and d.created_at < now() - interval '1 hour'
     and not exists (select 1 from public.ai_documentos_texto x where x.document_id = d.id);
  if n > 0 then p := p || format('%s documento(s) enviados há mais de 1h ainda não foram lidos pela Lia.', n); end if;

  -- 5) Arquivos sumidos: documento cadastrado sem o arquivo no Storage.
  select count(*) into n from public.documents d
   where d.storage_path is not null and not exists (select 1 from storage.objects o where o.name = d.storage_path);
  if n > 0 then p := p || format('%s documento(s) da Biblioteca/Documentos sem o arquivo no Storage.', n); end if;

  -- 6) Conteúdo comercial desatualizado.
  select count(*) into n from public.prioridades_comerciais
   where ativo and valido_ate is not null and valido_ate < (now() at time zone 'America/Sao_Paulo')::date;
  if n > 0 then p := p || format('%s prioridade(s) comercial(is) ativa(s) com validade vencida.', n); end if;
  select max(atualizado_em) into v_ultima from public.ai_conhecimento_bancos where ativo;
  if v_ultima is null or v_ultima < now() - interval '30 days' then
    p := p || format('Base de conhecimento da Lia sem atualização desde %s.', coalesce(to_char(v_ultima, 'DD/MM/YYYY'), 'sempre'));
  end if;

  insert into public.saude_checagens (ok, problemas) values (cardinality(p) = 0, to_jsonb(p));

  -- 7) Alerta por e-mail só quando há problema.
  if cardinality(p) > 0 then
    select valor into v_dest from public.portal_config where chave = 'alerta_emails';
    v_html := '<p>A checagem diária do Portal Facilita encontrou ' || cardinality(p) || ' ponto(s) de atenção:</p><ul>';
    foreach t in array p loop v_html := v_html || '<li>' || replace(replace(t, '<', '&lt;'), '>', '&gt;') || '</li>'; end loop;
    v_html := v_html || '</ul><p><a href="https://facilita-emprestimo.github.io/">Abrir o portal</a></p>';
    foreach e in array string_to_array(coalesce(v_dest, ''), ',') loop
      if trim(e) <> '' then
        perform public.fn_send_email(trim(e), '⚠️ Portal Facilita: ' || cardinality(p) || ' ponto(s) de atenção hoje', v_html, 'checagem_diaria', null);
      end if;
    end loop;
  end if;

  return to_jsonb(p);
end;
$$;
revoke execute on function public.fn_checagem_diaria() from public, anon, authenticated;

select cron.schedule('checagem-diaria', '0 10 * * *', 'select public.fn_checagem_diaria();');
-- Destinatário inicial (ajuste pelo SQL Editor ou peça ao Claude):
-- insert into public.portal_config (chave, valor) values ('alerta_emails', 'email@exemplo.com') on conflict (chave) do update set valor = excluded.valor;
