-- E-mails do Portal: fila com envio espaçado e conferência da resposta do Resend.
-- Antes: fn_send_email disparava tudo de uma vez (estourava o limite de 10/s) e nunca conferia se o Resend aceitou.
-- Agora: fn_send_email só coloca na fila; a rotina email-fila (a cada minuto) envia até 8 por vez,
-- confere a resposta, tenta de novo quando o Resend pede para esperar (429) e registra falhas em saude_eventos.
-- Remetente: segredo 'email_from' no Vault (ex.: 'Portal Facilita <portal@facilitaemprestimo.com.br>');
-- sem ele, usa o remetente de teste do Resend (só entrega para o dono da conta).

create table if not exists public.email_fila (
  id bigint generated always as identity primary key,
  para text not null,
  assunto text not null,
  html text not null,
  tipo text,
  referencia_id uuid,
  status text not null default 'pendente',   -- pendente | enviando | enviado | falhou
  tentativas int not null default 0,
  request_id bigint,
  http_status int,
  erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists email_fila_status_idx on public.email_fila (status, criado_em);
alter table public.email_fila enable row level security;
create policy email_fila_admin_select on public.email_fila
  for select to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

create or replace function public.fn_send_email(p_to text, p_subject text, p_html text, p_tipo text default null, p_referencia_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_to is null or p_to = '' then
    return;
  end if;
  insert into public.email_fila (para, assunto, html, tipo, referencia_id)
  values (p_to, p_subject, p_html, coalesce(p_tipo, 'desconhecido'), p_referencia_id);
exception when others then
  insert into public.notificacoes_log (tipo, referencia_id, destinatario_email, assunto, request_id)
  values (coalesce(p_tipo, 'desconhecido') || '_erro', p_referencia_id, p_to, p_subject, null);
end;
$function$;

create or replace function public.fn_email_processar_fila()
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'vault'
as $function$
declare
  v_api_key text;
  v_from text;
  r record;
  v_req bigint;
begin
  -- 1) Confere as respostas dos envios anteriores.
  for r in
    select f.id, f.tentativas, f.para, f.assunto, f.tipo, resp.status_code, resp.content, resp.error_msg, f.atualizado_em
      from public.email_fila f
      left join net._http_response resp on resp.id = f.request_id
     where f.status = 'enviando'
  loop
    if r.status_code between 200 and 299 then
      update public.email_fila set status = 'enviado', http_status = r.status_code, atualizado_em = now() where id = r.id;
    elsif r.status_code = 429 and r.tentativas < 5 then
      update public.email_fila set status = 'pendente', http_status = 429, atualizado_em = now() where id = r.id;
    elsif r.status_code is not null or r.error_msg is not null or r.atualizado_em < now() - interval '30 minutes' then
      update public.email_fila
         set status = 'falhou', http_status = r.status_code,
             erro = left(coalesce(r.content, r.error_msg, 'sem resposta do Resend'), 500), atualizado_em = now()
       where id = r.id;
      insert into public.saude_eventos (componente, ok, detalhe)
      values ('email', false, left(coalesce(r.tipo, '') || ' para ' || r.para || ' — HTTP ' || coalesce(r.status_code::text, '?') || ': ' || coalesce(r.content, r.error_msg, 'sem resposta'), 500));
    end if;
  end loop;

  -- 2) Envia os próximos (até 8 por minuto, abaixo do limite de 10 por segundo do Resend).
  if not exists (select 1 from public.email_fila where status = 'pendente') then
    return;
  end if;

  select decrypted_secret into v_api_key from vault.decrypted_secrets
   where name in ('resend_api_key', 'resend') order by (name = 'resend_api_key') desc limit 1;
  if v_api_key is null or v_api_key = '' then
    insert into public.saude_eventos (componente, ok, detalhe) values ('email', false, 'Chave do Resend ausente no Vault');
    return;
  end if;
  select decrypted_secret into v_from from vault.decrypted_secrets where name = 'email_from' limit 1;
  v_from := coalesce(nullif(v_from, ''), 'Portal Interno Facilita <onboarding@resend.dev>');

  for r in
    select * from public.email_fila where status = 'pendente' order by criado_em limit 8 for update skip locked
  loop
    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_api_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(r.para), 'subject', r.assunto, 'html', r.html)
    ) into v_req;
    update public.email_fila
       set status = 'enviando', request_id = v_req, tentativas = tentativas + 1, atualizado_em = now()
     where id = r.id;
    insert into public.notificacoes_log (tipo, referencia_id, destinatario_email, assunto, request_id)
    values (r.tipo, r.referencia_id, r.para, r.assunto, v_req);
  end loop;
end;
$function$;
revoke execute on function public.fn_email_processar_fila() from public, anon, authenticated;

select cron.schedule('email-fila', '* * * * *', 'select public.fn_email_processar_fila();');
