# Universidade Facilita

Clone da Universidade Corporativa do SULTS, construído em cima da **Trilha do Conhecimento** que o portal já tinha (curso = pasta da Trilha, aula = vídeo do YouTube ou arquivo de vídeo).

## Arquitetura

```
Navegador (GitHub Pages)                         Supabase (projeto facilita-portal-interno)
──────────────────────────                       ───────────────────────────────────────────
index.html  ── Trilha do Conhecimento            folders / documents      (cursos e aulas)
   │           (cards de aula, botão Concluído)  aula_progresso           (aula concluída)
   │                                             aula_visualizacoes  NOVO (segundos assistidos)
universidade.js  NOVO                            certificados        NOVO (código único)
   ├─ Rastreador de vídeo (YouTube API / <video>) ──► registrar_visualizacao()  limita tempo por chamada
   ├─ Libera "Concluído" com 90% assistido       ──► RLS de aula_progresso confere os 90%
   ├─ Painel do Aluno (Universidade no menu)
   ├─ Certificado                                 ──► emitir_certificado()   confere todas as aulas
   └─ Relatório do gestor + CSV                   ──► universidade_relatorio() só com permissão
verificar.html  NOVO (público, sem login)         ──► verificar_certificado()  devolve nome/curso/datas
```

Regra de ouro: **o navegador mostra, o banco decide.** Quem diz se a aula pode ser concluída e se o certificado pode ser emitido é o Supabase, não a tela.

### Como a medição funciona
- O player do YouTube (API oficial) ou o `<video>` informa a posição a cada segundo.
- Só conta segundo que **tocou de verdade**. Pular para frente não conta; rever o mesmo trecho não conta duas vezes.
- A cada 15s (e ao pausar/terminar/sair da aba) o total vai para `registrar_visualizacao`, que aceita no máximo o tempo que passou desde o último envio (×2,2 para quem assiste em 2x, +20s).
- Ao passar de 90%, a aula é concluída sozinha.
- Links do Google Drive não dão para medir: continuam com o botão manual.

### Limite conhecido
Isso impede o "clicar em concluído sem abrir o vídeo" e o "pular até o fim". Não impede alguém deixar o vídeo rodando sem prestar atenção. Para provar aprendizado, o próximo passo é uma **prova por curso** (nota mínima para liberar o certificado).

## Como colocar no ar

1. **Banco (uma vez):** Supabase → projeto `facilita-portal-interno` → SQL Editor → New query → colar `sql/universidade_01_visualizacao_certificados.sql` → Run. Só adiciona coisas; pode rodar de novo sem problema.
2. **Site:** aprovar o pull request. O GitHub Pages publica sozinho em 1 a 2 minutos.
3. **Permissão do relatório:** Administração → Permissões → "Ver relatório da Universidade". Já vem liberado para diretor e coordenador.
4. **Teste:** abra um curso na Trilha, dê play num vídeo do YouTube, confira o botão "Assista ao vídeo para concluir · X%" subindo. Depois emita o certificado e abra o link de verificação impresso nele.

Se o passo 1 não for feito, o portal continua funcionando no modo antigo (botão manual e certificado sem código).

## Rodar no seu computador (para testar mudanças)

Não precisa instalar biblioteca nenhuma: é HTML + JavaScript puro.

```bash
git clone https://github.com/facilita-emprestimo/facilita-emprestimo.github.io
cd facilita-emprestimo.github.io
python -m http.server 8000      # ou: npx serve .
# abra http://localhost:8000
```

Atenção: rodando local, o portal usa o **mesmo banco de produção**. Use um usuário de teste.

## Arquivos
| Arquivo | O que é |
|---|---|
| `index.html` | Portal (cópia idêntica em `facilita-intranet.html`) |
| `universidade.js` | Módulo da Universidade (medição, painel, certificado, relatório) |
| `verificar.html` | Página pública de verificação de certificado |
| `sql/universidade_01_visualizacao_certificados.sql` | Tabelas, regras e funções no Supabase |
