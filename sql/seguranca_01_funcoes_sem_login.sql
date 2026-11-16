-- Segurança: funções SECURITY DEFINER não podem ser chamadas por quem não está logado (papel anon).
-- Exceção: verificar_certificado (a página pública verificar.html confere certificados sem login).
-- Funções de gatilho e de rotina (cron) também saem do alcance de usuários logados: só o banco as executa.

-- Usadas pelo portal com login: tira de anon/public, mantém para authenticated.
do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_list_usuarios()',
    'public.admin_set_user_active(uuid, boolean)',
    'public.can_see_document_thumb(text)',
    'public.emitir_certificado(uuid)',
    'public.registrar_visualizacao(uuid, integer, integer, integer)',
    'public.univ_pode_concluir(uuid)',
    'public.universidade_relatorio()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;

  -- Gatilhos e rotinas: ninguém chama pela API.
  foreach f in array array[
    'public.fn_enviar_lembretes_calendario()',
    'public.handle_new_user()',
    'public.rls_auto_enable()',
    'public.trg_notify_chamado()',
    'public.trg_notify_comunicado()',
    'public.trg_notify_enquete()',
    'public.trg_notify_plano_acao()',
    'public.trg_notify_tarefa()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- search_path fixo nas funções apontadas pelo verificador do Supabase.
alter function public.fn_set_ai_conhecimento_atualizado_em() set search_path = public;
alter function public.univ_percentual_minimo() set search_path = public;
alter function public.univ_eh_aula(public.documents) set search_path = public;
alter function public.univ_aula_rastreavel(public.documents) set search_path = public;
