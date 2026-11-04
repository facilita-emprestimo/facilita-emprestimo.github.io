-- =====================================================================
-- DP — DATA DE SAÍDA PARA A LISTA "EVENTOS DO MÊS"
-- ---------------------------------------------------------------------
-- Regra: quem foi desligado aparece no DP até o fim do mês da saída
-- (para lançar rescisão, faltas, prêmio) e depois some.
-- Data de saída = colaboradores.desligado_em (Lojas > Encerrar vínculo)
--               ou profiles.desativado_em (Administração > desativar acesso).
-- =====================================================================

-- 1. Revoga o EXECUTE público da função auxiliar do DP
revoke execute on function public.dp_competencia_aberta(date) from anon, public;
grant execute on function public.dp_competencia_aberta(date) to authenticated;

-- 2. Data em que o acesso foi desativado
alter table public.profiles add column if not exists desativado_em timestamptz;
comment on column public.profiles.desativado_em is 'Quando o acesso foi desativado em Administração (usado pelo DP: aparece até o fim do mês da saída).';

CREATE OR REPLACE FUNCTION public.admin_set_user_active(target_id uuid, new_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  caller_is_admin boolean;
begin
  select is_admin into caller_is_admin from public.profiles where id = auth.uid();
  if not coalesce(caller_is_admin, false) then
    raise exception 'not authorized';
  end if;
  if target_id = auth.uid() and new_active = false then
    raise exception 'cannot deactivate own account';
  end if;
  update public.profiles
     set active = new_active,
         desativado_em = case
           when new_active then null
           when active is distinct from false then now()
           else desativado_em
         end
   where id = target_id;
  update auth.users set banned_until = case when new_active then null else 'infinity'::timestamptz end where id = target_id;
end;
$function$;
