// =====================================================================
// UNIVERSIDADE FACILITA
// ---------------------------------------------------------------------
// Módulo carregado pelo index.html depois do script principal. Usa as
// variáveis globais do portal: supabase, appState, hasPermission,
// progressoCache, previewKindOf, extractYouTubeId, formatDateBR,
// formatCargaHoraria, navigate, portalAbrirLink, PORTAL_URL.
//
// O que ele faz:
//   1. MEDE quanto de cada vídeo a pessoa assistiu (YouTube e vídeo enviado)
//      e só libera "Concluído" com 90% assistido. Ao chegar em 90%, conclui sozinho.
//   2. Emite o certificado pelo BANCO (que confere se todas as aulas foram
//      concluídas) com código único, verificável em verificar.html.
//   3. Painel do Aluno: cursos, progresso, "continuar de onde parou", certificados.
//   4. Relatório do gestor: colaborador x curso, com exportação CSV.
//
// Se o SQL sql/universidade_01_visualizacao_certificados.sql ainda não foi
// rodado no Supabase, tudo volta ao comportamento antigo (botão manual e
// certificado só na tela) — nada quebra.
// =====================================================================

var UNIV = {
  disponivel: null,        // null = ainda não verificado; true/false depois
  MIN_PCT: 0.9,            // mesmo valor de univ_percentual_minimo() no banco
  FLUSH_MS: 15000,         // de quanto em quanto tempo salva o tempo assistido
  visu: {},                // documento_id -> { segundos_assistidos, ultima_posicao, updated_at }
  durLocal: {},            // documento_id -> duração (s) informada pelo player
  botoes: {},              // documento_id -> [{ render, onChange }]
  docs: {},                // documento_id -> doc (para recalcular %)
  painel: null,            // dados do painel do aluno já calculados
  filtro: 'todos',
  relatorio: [],           // linhas do relatório do gestor
  _deteccao: null,
  _ytApi: null
};

// ---------------------------------------------------------------------
// 0. Utilidades
// ---------------------------------------------------------------------

// Descobre (uma vez) se o SQL da Universidade já foi aplicado no Supabase.
function univDetectar() {
  if (UNIV._deteccao) return UNIV._deteccao;
  UNIV._deteccao = supabase.from('aula_visualizacoes').select('id', { head: true, count: 'exact' }).limit(1)
    .then(function (res) {
      UNIV.disponivel = !res.error;
      if (res.error) console.info('Universidade: SQL ainda não aplicado — modo antigo.', res.error.message);
      return UNIV.disponivel;
    })
    .catch(function () { UNIV.disponivel = false; return false; });
  return UNIV._deteccao;
}

function univMeuId() {
  return appState && appState.session && appState.session.user ? appState.session.user.id : null;
}

// Mesma regra do banco (univ_eh_aula): aula marcada ou arquivo de vídeo.
function univEhAula(d) {
  return !!d.is_aula || previewKindOf(d.name, d.file_type) === 'video';
}

// Mesma regra do banco (univ_aula_rastreavel): YouTube ou vídeo enviado.
function univRastreavel(doc) {
  if (extractYouTubeId(doc.link_externo)) return true;
  return !!doc.storage_path && previewKindOf(doc.name, doc.file_type) === 'video';
}

function univDuracao(doc) {
  return doc.duracao_seg || UNIV.durLocal[doc.id] || 0;
}

// Fração assistida (0 a 1) da aula.
function univPct(doc) {
  var dur = univDuracao(doc);
  var v = UNIV.visu[doc.id];
  if (!dur || !v) return 0;
  return Math.min(1, (v.segundos_assistidos || 0) / dur);
}

function univPctTexto(doc) {
  return Math.floor(univPct(doc) * 100) + '%';
}

// Pode marcar como concluída? (o banco confere de novo na hora de gravar)
function univPodeConcluir(doc) {
  UNIV.docs[doc.id] = doc;
  if (!UNIV.disponivel) return true;
  if (!univRastreavel(doc)) return true;
  return univPct(doc) >= UNIV.MIN_PCT - 0.001;
}

// Capa do YouTube: se a imagem não carregar, fica o fundo padrão.
function univImg(src) {
  var img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.onerror = function () { img.remove(); };
  return img;
}

function univEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function univBarra(pct) {
  var outer = univEl('div', 'trilha-progress-bar-outer');
  var inner = univEl('div', 'trilha-progress-bar-inner');
  inner.style.width = Math.round(pct * 100) + '%';
  outer.appendChild(inner);
  return outer;
}

function univUrlVerificacao(codigo) {
  var base = (typeof PORTAL_URL !== 'undefined' && PORTAL_URL) ? PORTAL_URL : (location.origin + '/');
  return base.replace(/\/?$/, '/') + 'verificar.html?c=' + encodeURIComponent(codigo);
}

// ---------------------------------------------------------------------
// 1. Progresso assistido (carregar, desenhar, salvar)
// ---------------------------------------------------------------------

// Chamado por loadProgresso() quando uma pasta da Trilha abre.
async function univCarregarVisualizacoes(ids) {
  await univDetectar();
  var me = univMeuId();
  if (!UNIV.disponivel || !me || !ids || !ids.length) return;
  var res = await supabase.from('aula_visualizacoes')
    .select('documento_id,segundos_assistidos,ultima_posicao,updated_at')
    .eq('user_id', me).in('documento_id', ids);
  if (res.error) { console.warn('Universidade: falha ao ler visualizações', res.error); return; }
  (res.data || []).forEach(function (r) { UNIV.visu[r.documento_id] = r; });
}

// buildConcluidoBtn registra aqui o redesenho do botão de cada aula.
function univRegistrarBotao(doc, render, onChange) {
  UNIV.docs[doc.id] = doc;
  // Pastas são redesenhadas várias vezes: fica só o botão mais recente.
  UNIV.botoes[doc.id] = [{ render: render, onChange: onChange }];
}

function univRedesenhar(docId, progressoMudou) {
  (UNIV.botoes[docId] || []).forEach(function (b) {
    try { b.render(); if (progressoMudou && typeof b.onChange === 'function') b.onChange(); } catch (e) { /* botão saiu da tela */ }
  });
}

// Ao chegar em 90%, marca a aula como concluída sozinho (menos atrito para o aluno).
async function univAutoConcluir(doc) {
  var me = univMeuId();
  if (!me || progressoCache[doc.id] || doc._univConcluindo) return;
  doc._univConcluindo = true;
  var ins = await supabase.from('aula_progresso').insert({ documento_id: doc.id, user_id: me }).select().single();
  doc._univConcluindo = false;
  if (!ins.error) {
    progressoCache[doc.id] = (ins.data && ins.data.concluido_at) || new Date().toISOString();
    univRedesenhar(doc.id, true);
  }
}

// Rastreador: conta só segundos REALMENTE reproduzidos nesta sessão.
// Pular para frente não conta; voltar e rever o mesmo trecho não conta duas vezes.
function univCriarRastreador(doc) {
  var inicial = (UNIV.visu[doc.id] && UNIV.visu[doc.id].segundos_assistidos) || 0;
  var cobertos = {};
  var qtd = 0;
  var ultimoT = null;
  var ultimaPos = 0;
  var dur = 0;
  var ultimoEnvio = Date.now();
  var enviando = false;
  var pendente = false;

  function atualizarLocal() {
    var atual = UNIV.visu[doc.id] || { segundos_assistidos: 0, ultima_posicao: 0 };
    var estimado = Math.max(atual.segundos_assistidos || 0, inicial + qtd);
    if (dur) estimado = Math.min(estimado, Math.round(dur));
    UNIV.visu[doc.id] = { segundos_assistidos: estimado, ultima_posicao: ultimaPos, updated_at: atual.updated_at };
  }

  async function salvar() {
    if (!UNIV.disponivel || !univMeuId()) return;
    if (enviando) { pendente = true; return; }
    enviando = true;
    ultimoEnvio = Date.now();
    var res = await supabase.rpc('registrar_visualizacao', {
      p_documento: doc.id,
      p_segundos: Math.floor(inicial + qtd),
      p_posicao: Math.floor(ultimaPos),
      p_duracao: Math.round(dur) || null
    });
    enviando = false;
    if (res.error) { console.warn('Universidade: falha ao salvar tempo assistido', res.error); }
    else if (res.data) {
      UNIV.visu[doc.id] = res.data;          // valor do banco é o oficial
      if (!doc.duracao_seg && dur) doc.duracao_seg = Math.round(dur);
      univRedesenhar(doc.id, false);
      if (univPct(doc) >= UNIV.MIN_PCT && !progressoCache[doc.id]) univAutoConcluir(doc);
    }
    if (pendente) { pendente = false; salvar(); }
  }

  return {
    // Chamado a cada ~1s (YouTube) ou a cada timeupdate (vídeo enviado).
    tick: function (t, duracao, tocando) {
      if (duracao > 0) { dur = duracao; UNIV.durLocal[doc.id] = Math.round(duracao); }
      if (typeof t !== 'number' || isNaN(t)) return;
      if (tocando && ultimoT !== null) {
        var delta = t - ultimoT;
        if (delta > 0 && delta <= 2.5) {     // salto maior = pulou o vídeo, não conta
          for (var s = Math.floor(ultimoT); s < Math.floor(t); s++) {
            if (!cobertos[s]) { cobertos[s] = 1; qtd++; }
          }
        }
      }
      ultimoT = t;
      ultimaPos = t;
      var antes = univPct(doc);
      atualizarLocal();
      if (Math.floor(univPct(doc) * 100) !== Math.floor(antes * 100)) univRedesenhar(doc.id, false);
      if (tocando && Date.now() - ultimoEnvio > UNIV.FLUSH_MS) salvar();
    },
    salvar: salvar
  };
}

// Posição para retomar o vídeo (se parou no meio).
function univPosicaoRetomar(doc) {
  var v = UNIV.visu[doc.id];
  var dur = univDuracao(doc);
  if (!v || !v.ultima_posicao || v.ultima_posicao < 5) return 0;
  if (dur && v.ultima_posicao > dur - 10) return 0;
  return Math.floor(v.ultima_posicao);
}

// ---------------------------------------------------------------------
// 2. Players medidos
// ---------------------------------------------------------------------

// Vídeo enviado ao portal (<video>).
function univRastrearVideoArquivo(video, doc) {
  if (!UNIV.disponivel) return;
  var r = univCriarRastreador(doc);
  var retomar = univPosicaoRetomar(doc);
  video.addEventListener('loadedmetadata', function () {
    if (retomar) { try { video.currentTime = retomar; } catch (e) { /* ignora */ } }
  });
  video.addEventListener('timeupdate', function () {
    r.tick(video.currentTime, video.duration, !video.paused && !video.seeking);
  });
  video.addEventListener('pause', r.salvar);
  video.addEventListener('ended', r.salvar);
  document.addEventListener('visibilitychange', function () { if (document.hidden) r.salvar(); });
}

// Carrega (uma vez) a API oficial de player do YouTube.
function univCarregarYTApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (UNIV._ytApi) return UNIV._ytApi;
  UNIV._ytApi = new Promise(function (resolve, reject) {
    var anterior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof anterior === 'function') anterior();
      resolve(window.YT);
    };
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = reject;
    document.head.appendChild(tag);
    setTimeout(function () { reject(new Error('YouTube API não carregou')); }, 10000);
  });
  UNIV._ytApi.catch(function () { UNIV._ytApi = null; });
  return UNIV._ytApi;
}

// Troca a capa da aula por um player do YouTube que mede o tempo assistido.
function univMontarYouTube(wrap, doc, youtubeId) {
  wrap.innerHTML = '';
  var box = univEl('div', 'univ-yt');
  var alvo = document.createElement('div');
  box.appendChild(alvo);
  wrap.appendChild(box);

  univCarregarYTApi().then(function (YT) {
    var r = univCriarRastreador(doc);
    var player = new YT.Player(alvo, {
      videoId: youtubeId,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, start: univPosicaoRetomar(doc) },
      events: {
        onReady: function (e) { try { e.target.playVideo(); } catch (er) { /* ignora */ } },
        onStateChange: function (e) {
          // 2 = pausado, 0 = terminou: salva na hora
          if (e.data === 2 || e.data === 0) r.salvar();
        }
      }
    });
    var timer = setInterval(function () {
      if (!document.body.contains(box)) { clearInterval(timer); r.salvar(); return; }
      if (!player || typeof player.getPlayerState !== 'function') return;
      var tocando = player.getPlayerState() === 1;
      r.tick(player.getCurrentTime(), player.getDuration(), tocando);
    }, 1000);
    document.addEventListener('visibilitychange', function () { if (document.hidden) r.salvar(); });
  }).catch(function () {
    // Sem a API (bloqueio de rede/extensão): mostra o vídeo comum, sem medição.
    box.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = 'https://www.youtube.com/embed/' + youtubeId + '?autoplay=1';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    box.appendChild(iframe);
    var aviso = univEl('div', 'univ-aviso', 'Não foi possível medir este vídeo agora (o progresso não será contado). Recarregue a página para tentar de novo.');
    aviso.style.margin = '8px';
    wrap.appendChild(aviso);
  });
}

// ---------------------------------------------------------------------
// 3. Certificado (emitido e validado pelo banco)
// ---------------------------------------------------------------------

// Retorna true se tratou (Universidade ativa); false para usar o certificado antigo.
async function univAbrirCertificado(folder) {
  await univDetectar();
  if (!UNIV.disponivel) return false;
  var res = await supabase.rpc('emitir_certificado', { p_folder: folder.id });
  if (res.error) {
    alert('Não foi possível emitir o certificado: ' + (res.error.message || 'erro desconhecido'));
    return true;
  }
  univMostrarCertificado(res.data);
  return true;
}

function univMostrarCertificado(cert) {
  var modal = document.getElementById('certificadoModal');
  if (!modal || !cert) return;
  document.getElementById('certificadoNome').textContent = cert.aluno_nome;
  document.getElementById('certificadoCurso').textContent = cert.curso_nome;
  var det = [];
  if (cert.carga_horaria_min) det.push('Carga horária de ' + formatCargaHoraria(cert.carga_horaria_min));
  det.push(cert.total_aulas + ' aula' + (cert.total_aulas === 1 ? '' : 's'));
  if (cert.inicio_em) det.push('início em ' + formatDateBR(cert.inicio_em));
  det.push('conclusão em ' + formatDateBR(cert.concluido_em));
  document.getElementById('certificadoDetalhes').textContent = det.join(', ') + '.';
  var cod = document.getElementById('certificadoCodigo');
  if (cod) {
    cod.innerHTML = '';
    cod.appendChild(document.createTextNode('Código de verificação: '));
    cod.appendChild(univEl('b', null, cert.codigo));
    cod.appendChild(document.createElement('br'));
    cod.appendChild(document.createTextNode('Confira a autenticidade em ' + univUrlVerificacao(cert.codigo)));
  }
  modal.classList.remove('hidden');
}

// ---------------------------------------------------------------------
// 4. Painel do Aluno
// ---------------------------------------------------------------------

function univTrocarAba(aba) {
  document.querySelectorAll('#univTabs .tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-univ-tab') === aba);
  });
  document.getElementById('univPainel').style.display = aba === 'painel' ? '' : 'none';
  document.getElementById('univRelatorio').style.display = aba === 'relatorio' ? '' : 'none';
  if (aba === 'relatorio') univCarregarRelatorio();
}

async function univAbrirPagina() {
  await univDetectar();
  var podeRelatorio = UNIV.disponivel && hasPermission('universidade.relatorios');
  document.getElementById('univTabRelatorio').style.display = podeRelatorio ? '' : 'none';
  var aviso = document.getElementById('univAvisoSql');
  var isAdmin = !!(appState.profile && appState.profile.is_admin);
  if (!UNIV.disponivel && isAdmin) {
    aviso.textContent = 'Modo básico: para medir quanto cada pessoa assistiu, emitir certificados com código verificável e liberar o relatório da equipe, rode o arquivo sql/universidade_01_visualizacao_certificados.sql no Supabase (SQL Editor).';
    aviso.style.display = '';
  } else {
    aviso.style.display = 'none';
  }
  univTrocarAba('painel');
  univCarregarPainel();
}

// Monta os dados: cursos = pastas da Trilha que têm pelo menos uma aula.
async function univCarregarPainel() {
  var loading = document.getElementById('univPainelLoading');
  var conteudo = document.getElementById('univPainelConteudo');
  loading.style.display = '';
  loading.textContent = 'Carregando seu painel…';
  conteudo.style.display = 'none';
  var me = univMeuId();
  if (!me) return;

  var fr = await supabase.from('folders').select('*').eq('area', 'trilha-conhecimento');
  if (fr.error) { loading.textContent = 'Não foi possível carregar os cursos.'; return; }
  var pastas = fr.data || [];
  var pastaPorId = {};
  pastas.forEach(function (f) { pastaPorId[f.id] = f; });
  var ids = pastas.map(function (f) { return f.id; });

  var docs = [];
  if (ids.length) {
    var dr = await supabase.from('documents').select('*').in('folder_id', ids).order('created_at', { ascending: true });
    docs = (dr.data || []).filter(univEhAula);
  }
  var aulaIds = docs.map(function (d) { return d.id; });

  var progresso = {};
  var certs = [];
  var tarefas = [];
  if (aulaIds.length) {
    tarefas.push(supabase.from('aula_progresso').select('documento_id,concluido_at').eq('user_id', me).in('documento_id', aulaIds)
      .then(function (r) { (r.data || []).forEach(function (x) { progresso[x.documento_id] = x.concluido_at; }); }));
    tarefas.push(univCarregarVisualizacoes(aulaIds));
  }
  if (UNIV.disponivel) {
    tarefas.push(supabase.from('certificados').select('*').eq('user_id', me).is('revogado_em', null).order('emitido_em', { ascending: false })
      .then(function (r) { certs = r.data || []; }));
  }
  await Promise.all(tarefas);
  Object.keys(progresso).forEach(function (k) { progressoCache[k] = progresso[k]; });

  var certPorPasta = {};
  certs.forEach(function (c) { certPorPasta[c.folder_id] = c; });

  // Agrupa aulas por curso
  var porCurso = {};
  docs.forEach(function (d) { (porCurso[d.folder_id] = porCurso[d.folder_id] || []).push(d); });

  var cursos = Object.keys(porCurso).map(function (fid) {
    var aulas = porCurso[fid];
    var pasta = pastaPorId[fid];
    var feitas = aulas.filter(function (a) { return !!progresso[a.id]; }).length;
    var ultima = null;
    aulas.forEach(function (a) {
      var t1 = progresso[a.id], v = UNIV.visu[a.id], t2 = v && v.updated_at;
      [t1, t2].forEach(function (t) { if (t && (!ultima || t > ultima)) ultima = t; });
    });
    var proxima = aulas.filter(function (a) { return !progresso[a.id]; })[0] || null;
    var iniciou = feitas > 0 || aulas.some(function (a) { return !!UNIV.visu[a.id]; });
    var caminho = [];
    var p = pasta && pasta.parent_id ? pastaPorId[pasta.parent_id] : null;
    while (p) { caminho.unshift(p.name); p = p.parent_id ? pastaPorId[p.parent_id] : null; }
    var ytCapa = null;
    for (var i = 0; i < aulas.length && !ytCapa; i++) ytCapa = extractYouTubeId(aulas[i].link_externo);
    return {
      pasta: pasta, aulas: aulas, total: aulas.length, feitas: feitas,
      pct: aulas.length ? feitas / aulas.length : 0,
      status: feitas === aulas.length ? 'concluido' : (iniciou ? 'andamento' : 'nao_iniciado'),
      ultima: ultima, proxima: proxima, caminho: caminho.join(' / '),
      capa: ytCapa ? 'https://img.youtube.com/vi/' + ytCapa + '/hqdefault.jpg' : null,
      cert: certPorPasta[fid] || null
    };
  }).filter(function (c) { return !!c.pasta; });

  cursos.sort(function (a, b) {
    var ordem = { andamento: 0, nao_iniciado: 1, concluido: 2 };
    if (ordem[a.status] !== ordem[b.status]) return ordem[a.status] - ordem[b.status];
    return a.pasta.name.localeCompare(b.pasta.name, 'pt-BR');
  });

  UNIV.painel = { cursos: cursos, certs: certs };
  loading.style.display = 'none';
  conteudo.style.display = '';
  univRenderPainel();
}

function univRenderPainel() {
  var d = UNIV.painel;
  if (!d) return;
  var cursos = d.cursos;

  // KPIs
  var kpis = document.getElementById('univKpis');
  kpis.innerHTML = '';
  [
    [cursos.length, 'Cursos disponíveis'],
    [cursos.filter(function (c) { return c.status === 'andamento'; }).length, 'Em andamento'],
    [cursos.filter(function (c) { return c.status === 'concluido'; }).length, 'Concluídos'],
    [UNIV.disponivel ? d.certs.length : '—', 'Certificados']
  ].forEach(function (k) {
    var box = univEl('div', 'univ-kpi');
    box.appendChild(univEl('b', null, String(k[0])));
    box.appendChild(univEl('span', null, k[1]));
    kpis.appendChild(box);
  });

  // Continuar de onde parou: curso em andamento com atividade mais recente
  var cont = document.getElementById('univContinuar');
  cont.innerHTML = '';
  var emAndamento = cursos.filter(function (c) { return c.status === 'andamento'; })
    .sort(function (a, b) { return (b.ultima || '').localeCompare(a.ultima || ''); });
  if (emAndamento.length) {
    var c = emAndamento[0];
    var box = univEl('div', 'univ-continue');
    if (c.capa) box.appendChild(univImg(c.capa));
    else box.appendChild(univEl('div', 'univ-continue-ph'));
    var txt = univEl('div');
    txt.style.flex = '1';
    txt.appendChild(univEl('small', null, 'Continue de onde parou'));
    txt.appendChild(univEl('h3', null, c.pasta.name));
    var sub = univEl('div', null, (c.proxima ? 'Próxima aula: ' + c.proxima.name + ' · ' : '') + c.feitas + ' de ' + c.total + ' aulas');
    sub.style.cssText = 'font-size:12.5px;opacity:.85;margin-bottom:8px;';
    txt.appendChild(sub);
    txt.appendChild(univBarra(c.pct));
    box.appendChild(txt);
    box.addEventListener('click', function () { univAbrirCurso(c); });
    cont.appendChild(box);
  }

  // Cursos (com filtro)
  document.querySelectorAll('#univFiltroCursos .tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-filtro') === UNIV.filtro);
  });
  var grid = document.getElementById('univCursosGrid');
  grid.innerHTML = '';
  var lista = cursos.filter(function (c) { return UNIV.filtro === 'todos' || c.status === UNIV.filtro; });
  document.getElementById('univCursosVazio').style.display = lista.length ? 'none' : '';
  if (!cursos.length) document.getElementById('univCursosVazio').textContent = 'Ainda não há cursos com aulas publicadas na Trilha do Conhecimento.';
  else document.getElementById('univCursosVazio').textContent = 'Nenhum curso nesta situação.';
  lista.forEach(function (c) { grid.appendChild(univCardCurso(c)); });

  // Certificados
  var certBox = document.getElementById('univCertificados');
  certBox.innerHTML = '';
  if (!UNIV.disponivel) {
    certBox.appendChild(univEl('div', 'docs-empty', 'Conclua um curso e emita o certificado pela página do curso.'));
  } else if (!d.certs.length) {
    certBox.appendChild(univEl('div', 'docs-empty', 'Você ainda não tem certificados. Conclua todas as aulas de um curso para emitir o seu.'));
  } else {
    d.certs.forEach(function (cert) {
      var row = univEl('div', 'univ-cert-row');
      row.innerHTML = '<svg class="ic"><use href="#i-award"/></svg>';
      var info = univEl('div');
      info.appendChild(univEl('b', null, cert.curso_nome));
      info.appendChild(univEl('span', null, 'Concluído em ' + formatDateBR(cert.concluido_em) + ' · Código ' + cert.codigo));
      row.appendChild(info);
      var btn = univEl('button', 'btn-primary-sm', 'Ver / imprimir');
      btn.type = 'button';
      btn.addEventListener('click', function () { univMostrarCertificado(cert); });
      row.appendChild(btn);
      certBox.appendChild(row);
    });
  }
}

function univCardCurso(c) {
  var card = univEl('div', 'univ-curso');
  var capa = univEl('div', 'univ-curso-capa');
  if (c.capa) capa.appendChild(univImg(c.capa));
  else capa.innerHTML = '<svg class="ic"><use href="#i-book"/></svg>';
  var rotulo = { concluido: ['Concluído', 'badge-green'], andamento: ['Em andamento', 'badge-blue'], nao_iniciado: ['Não iniciado', 'badge-gray'] }[c.status];
  capa.appendChild(univEl('span', 'badge ' + rotulo[1], rotulo[0]));
  card.appendChild(capa);

  var body = univEl('div', 'univ-curso-body');
  if (c.caminho) body.appendChild(univEl('small', null, c.caminho));
  body.appendChild(univEl('b', null, c.pasta.name));
  body.appendChild(univBarra(c.pct));
  var foot = univEl('div', 'univ-curso-foot');
  foot.appendChild(univEl('span', null, c.feitas + '/' + c.total + ' aulas' +
    (c.pasta.carga_horaria_min ? ' · ' + formatCargaHoraria(c.pasta.carga_horaria_min) : '')));
  if (c.cert) {
    var b = univEl('button', 'link-more', 'Certificado');
    b.type = 'button';
    b.addEventListener('click', function (e) { e.stopPropagation(); univMostrarCertificado(c.cert); });
    foot.appendChild(b);
  } else {
    foot.appendChild(univEl('span', null, Math.round(c.pct * 100) + '%'));
  }
  body.appendChild(foot);
  card.appendChild(body);
  card.addEventListener('click', function () { univAbrirCurso(c); });
  return card;
}

function univFiltrarCursos(f) {
  UNIV.filtro = f;
  univRenderPainel();
}

// Abre o curso na Trilha do Conhecimento (mesmo link direto usado pela assistente).
function univAbrirCurso(c) {
  if (typeof portalAbrirLink === 'function') portalAbrirLink('#pasta=' + c.pasta.id);
}

// ---------------------------------------------------------------------
// 5. Relatório do gestor (colaborador x curso)
// ---------------------------------------------------------------------

function univStatusLinha(r) {
  if (r.total_aulas && r.concluidas >= r.total_aulas) return 'concluido';
  if (r.concluidas > 0 || r.ultima_atividade) return 'andamento';
  return 'nao_iniciado';
}

var UNIV_ROTULO_STATUS = { concluido: 'Concluído', andamento: 'Em andamento', nao_iniciado: 'Não iniciado' };

async function univCarregarRelatorio() {
  var body = document.getElementById('univRelBody');
  body.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">Carregando…</td></tr>';
  var res = await supabase.rpc('universidade_relatorio');
  if (res.error) {
    body.innerHTML = '';
    var tr = document.createElement('tr');
    tr.appendChild(univEl('td', null, 'Não foi possível carregar o relatório: ' + res.error.message));
    tr.firstChild.colSpan = 6;
    body.appendChild(tr);
    return;
  }
  UNIV.relatorio = (res.data || []).map(function (r) { r.status = univStatusLinha(r); return r; });

  var sel = document.getElementById('univRelCurso');
  var atual = sel.value;
  var cursos = {};
  UNIV.relatorio.forEach(function (r) { cursos[r.folder_id] = r.curso; });
  sel.innerHTML = '<option value="">Todos os cursos</option>';
  Object.keys(cursos).sort(function (a, b) { return cursos[a].localeCompare(cursos[b], 'pt-BR'); }).forEach(function (id) {
    var o = document.createElement('option');
    o.value = id; o.textContent = cursos[id];
    sel.appendChild(o);
  });
  sel.value = atual;
  univRenderRelatorio();
}

function univLinhasFiltradas() {
  var curso = document.getElementById('univRelCurso').value;
  var status = document.getElementById('univRelStatus').value;
  var busca = (document.getElementById('univRelBusca').value || '').trim().toLowerCase();
  return UNIV.relatorio.filter(function (r) {
    if (curso && r.folder_id !== curso) return false;
    if (status && r.status !== status) return false;
    if (busca && ((r.nome || '') + ' ' + (r.email || '')).toLowerCase().indexOf(busca) === -1) return false;
    return true;
  });
}

function univRenderRelatorio() {
  var linhas = univLinhasFiltradas();

  // KPIs do recorte filtrado
  var kpis = document.getElementById('univRelKpis');
  kpis.innerHTML = '';
  var pessoas = {};
  linhas.forEach(function (r) { pessoas[r.user_id] = 1; });
  var concl = linhas.filter(function (r) { return r.status === 'concluido'; }).length;
  var andam = linhas.filter(function (r) { return r.status === 'andamento'; }).length;
  [
    [Object.keys(pessoas).length, 'Colaboradores no recorte'],
    [linhas.length ? Math.round(concl / linhas.length * 100) + '%' : '—', 'Taxa de conclusão'],
    [andam, 'Matrículas em andamento'],
    [linhas.filter(function (r) { return r.status === 'nao_iniciado'; }).length, 'Não iniciaram']
  ].forEach(function (k) {
    var box = univEl('div', 'univ-kpi');
    box.appendChild(univEl('b', null, String(k[0])));
    box.appendChild(univEl('span', null, k[1]));
    kpis.appendChild(box);
  });

  var body = document.getElementById('univRelBody');
  body.innerHTML = '';
  document.getElementById('univRelVazio').style.display = linhas.length ? 'none' : '';
  linhas.forEach(function (r) {
    var tr = document.createElement('tr');
    var tdNome = univEl('td');
    tdNome.appendChild(univEl('div', 'admin-user-name', r.nome));
    tdNome.appendChild(univEl('div', 'admin-user-email', r.email));
    tr.appendChild(tdNome);
    tr.appendChild(univEl('td', null, r.role || '—'));
    tr.appendChild(univEl('td', null, r.curso));
    var tdProg = univEl('td');
    var mini = univEl('span', 'univ-mini-bar');
    var fill = document.createElement('i');
    fill.style.width = (r.total_aulas ? Math.round(r.concluidas / r.total_aulas * 100) : 0) + '%';
    mini.appendChild(fill);
    tdProg.appendChild(mini);
    tdProg.appendChild(document.createTextNode(r.concluidas + '/' + r.total_aulas + ' · ' + UNIV_ROTULO_STATUS[r.status]));
    tr.appendChild(tdProg);
    tr.appendChild(univEl('td', null, r.ultima_atividade ? formatDateBR(r.ultima_atividade) : '—'));
    tr.appendChild(univEl('td', null, r.certificado || '—'));
    body.appendChild(tr);
  });
}

// Exporta o recorte atual em CSV (abre no Excel; separador ";" e BOM para acentos).
function univExportarCsv() {
  var linhas = univLinhasFiltradas();
  var esc = function (v) { v = v == null ? '' : String(v); return '"' + v.replace(/"/g, '""') + '"'; };
  var csv = ['Colaborador;E-mail;Perfil;Curso;Aulas concluídas;Total de aulas;Situação;Última atividade;Certificado'];
  linhas.forEach(function (r) {
    csv.push([r.nome, r.email, r.role, r.curso, r.concluidas, r.total_aulas, UNIV_ROTULO_STATUS[r.status],
      r.ultima_atividade ? formatDateBR(r.ultima_atividade) : '', r.certificado || ''].map(esc).join(';'));
  });
  var blob = new Blob(['﻿' + csv.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'universidade-relatorio-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
