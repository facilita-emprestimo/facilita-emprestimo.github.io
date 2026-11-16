# Saúde do Portal: rotinas automáticas e checagem diária

## Rotinas (pg_cron no Supabase)

| Rotina | Quando | O que faz |
| --- | --- | --- |
| `lembretes-calendario-diario` | 08:00 (Brasília) | Coloca na fila os lembretes de eventos do calendário |
| `email-fila` | a cada minuto | Envia até 8 e-mails da fila, confere a resposta do Resend, repete os recusados por limite (429) e registra falhas |
| `lia-ler-documentos` | a cada 2 min | Lê o conteúdo dos documentos ainda não lidos (3 por vez) para a Lia |
| `checagem-diaria` | 07:00 (Brasília) | Confere tudo abaixo e manda e-mail só quando há problema |

## O que a checagem diária confere

1. Falhas registradas em `saude_eventos` nas últimas 24h (Lia, leitura de documentos, e-mails).
2. E-mails parados na fila há mais de 30 min.
3. Rotinas que falharam ou pararam de rodar.
4. Documentos enviados há mais de 1h e ainda não lidos pela Lia.
5. Documentos sem o arquivo no Storage.
6. Prioridades comerciais vencidas e base de conhecimento da Lia sem atualização há mais de 30 dias.

Resultado de cada dia: tabela `saude_checagens`. Destinatários do alerta: `portal_config.alerta_emails` (separados por vírgula).

## Regra para novas automações

Toda nova rotina ou função só vai ao ar com resposta para "como eu fico sabendo se ela parar?":
ela registra falhas em `saude_eventos` e, se for agendada, entra na lista de rotinas conferidas pela checagem.

## E-mail (Resend)

O remetente vem do segredo `email_from` no Vault. Enquanto ele não existir, o Resend usa o remetente de teste
e só entrega para o dono da conta. Para entregar à equipe: verificar o domínio facilitaemprestimo.com.br no Resend
(registros DNS) e criar o segredo `email_from`, por exemplo `Portal Facilita <portal@facilitaemprestimo.com.br>`.
