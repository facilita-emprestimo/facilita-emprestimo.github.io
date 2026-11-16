-- Lia: leitura automática dos documentos novos, a cada 2 minutos, sem depender de alguém abrir a Administração.
-- A senha da rotina fica no Vault (lia_cron_secret), criada à parte com:
--   select vault.create_secret('<senha aleatória>', 'lia_cron_secret', 'Senha da rotina automatica de leitura de documentos da Lia');
-- A função lia-ler-documentos confere a senha chamando lia_cron_ok (só service_role).
create or replace function public.lia_cron_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public, vault as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'lia_cron_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.lia_cron_ok(text) from public, anon, authenticated;
grant execute on function public.lia_cron_ok(text) to service_role;

create or replace function public.fn_lia_ler_pendentes()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_pendentes int;
begin
  select count(*) into v_pendentes
    from public.documents d
   where d.storage_path is not null
     and not exists (select 1 from public.ai_documentos_texto t where t.document_id = d.id);
  if v_pendentes = 0 then return; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'lia_cron_secret' limit 1;
  if v_secret is null then
    insert into public.saude_eventos (componente, ok, detalhe) values ('lia-leitura', false, 'lia_cron_secret ausente no Vault');
    return;
  end if;

  perform net.http_post(
    url := 'https://zlztcabjiwyssafwkphy.supabase.co/functions/v1/lia-ler-documentos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsenRjYWJqaXd5c3NhZndrcGh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMDY5MDUsImV4cCI6MjEwMjU4MjkwNX0.MIjVd6SlXQpny3J7Pgg1fgNq39zAciDOEuiXyCd_noU',
      'x-lia-cron', v_secret
    ),
    body := jsonb_build_object('limite', 3),
    timeout_milliseconds := 150000
  );
end;
$$;
revoke execute on function public.fn_lia_ler_pendentes() from public, anon, authenticated;

select cron.schedule('lia-ler-documentos', '*/2 * * * *', 'select public.fn_lia_ler_pendentes();');
