// =====================================================================
// DEPARTAMENTO PESSOAL — EVENTOS MENSAIS E RELATÓRIO DE FECHAMENTO
// ---------------------------------------------------------------------
// Módulo carregado pelo index.html depois do script principal. Usa as
// variáveis globais do portal: supabase, appState, hasPermission,
// navigate, formatDateBR, pad2.
//
// O que ele faz:
//   1. O DP escolhe a competência (mês) e, para cada colaborador, registra
//      OCORRÊNCIAS (falta, atraso, atestado, férias, licença, advertência,
//      admissão, desligamento...) e o RESULTADO DO MÊS (meta, realizado,
//      prêmio, outros valores).
//   2. Gera o RELATÓRIO DE FECHAMENTO no padrão de documentos da Facilita
//      (imprimir/salvar PDF) e exporta CSV para a contabilidade.
//   3. Fecha a competência: depois de fechada ninguém altera; só o
//      Administrador reabre (regra garantida também no banco).
//
// Banco: sql/dp_01_eventos_mensais.sql. Acesso: permissão 'dp.gerenciar'.
// =====================================================================

var DP = {
  competencia: null,     // 'YYYY-MM-01'
  status: 'aberta',      // status da competência no banco
  compInfo: null,        // linha de dp_competencias
  colaboradores: [],     // colaboradores exibidos no mês
  unidades: {},          // unidade_id -> nome
  lancamentos: {},       // colaborador_id -> linha de dp_lancamentos
  eventos: [],           // linhas de dp_eventos do mês
  aba: 'lancamentos',
  filtroLoja: '',
  busca: '',
  colabAberto: null,     // colaborador_id do modal aberto
  carregando: false
};

var DP_TIPOS = {
  falta_injustificada: { rotulo: 'Falta injustificada', cor: 'red', unidade: 'dias', grupo: 'falta' },
  falta_justificada:   { rotulo: 'Falta justificada / abonada', cor: 'orange', unidade: 'dias', grupo: 'falta' },
  atraso:              { rotulo: 'Atraso / saída antecipada', cor: 'orange', unidade: 'minutos', grupo: 'atraso' },
  atestado:            { rotulo: 'Atestado médico', cor: 'purple', unidade: 'dias', grupo: 'ausencia' },
  ferias:              { rotulo: 'Férias', cor: 'blue', unidade: 'dias', grupo: 'ferias' },
  licenca:             { rotulo: 'Licença (maternidade, paternidade, gala, nojo…)', cor: 'teal', unidade: 'dias', grupo: 'ausencia' },
  afastamento:         { rotulo: 'Afastamento (INSS / acidente)', cor: 'pink', unidade: 'dias', grupo: 'ausencia' },
  folga:               { rotulo: 'Folga / compensação de banco de horas', cor: 'gray', unidade: 'dias', grupo: 'ausencia' },
  advertencia:         { rotulo: 'Advertência', cor: 'red', unidade: null, grupo: 'disciplinar' },
  suspensao:           { rotulo: 'Suspensão', cor: 'red', unidade: 'dias', grupo: 'disciplinar' },
  admissao:            { rotulo: 'Admissão', cor: 'green', unidade: null, grupo: 'movimentacao' },
  desligamento:        { rotulo: 'Desligamento', cor: 'gray', unidade: null, grupo: 'movimentacao' },
  outro:               { rotulo: 'Outro evento', cor: 'gray', unidade: 'dias', grupo: 'outro' }
};

var DP_MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// ---------------------------------------------------------------------
// 0. Utilidades
// ---------------------------------------------------------------------
function dpEsc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function dpNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = String(v).trim().replace(/R\$\s?/i, '');
  // aceita "1.234,56", "1234,56" e "1234.56"
  if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
  var n = Number(s);
  return isFinite(n) ? n : null;
}
function dpMoeda(v, vazio) {
  var n = dpNum(v);
  if (n === null) return vazio === undefined ? '—' : vazio;
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function dpNumBR(v, casas) {
  var n = dpNum(v);
  if (n === null) return '';
  var s = n.toFixed(casas == null ? 2 : casas).replace('.', ',');
  return s.replace(/\B(?=(\d{3})+(?!\d),)/g, '.');
}
function dpQtd(n) {
  n = Number(n) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}
function dpPct(meta, realizado) {
  var m = dpNum(meta), r = dpNum(realizado);
  if (!m || r === null) return null;
  return r / m * 100;
}
function dpCompLabel(comp) {
  if (!comp) return '';
  var p = comp.split('-');
  return DP_MESES[Number(p[1]) - 1] + '/' + p[0];
}
function dpCompLabelCap(comp) {
  var s = dpCompLabel(comp);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function dpFimDoMes(comp) {
  var p = comp.split('-');
  var d = new Date(Number(p[0]), Number(p[1]), 0);
  return p[0] + '-' + p[1] + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate();
}
function dpCompAtual() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-01';
}
function dpCompDeslocar(comp, meses) {
  var p = comp.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1 + meses, 1);
  return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-01';
}
function dpDiasEntre(ini, fim) {
  if (!ini) return null;
  if (!fim) return 1;
  var a = new Date(ini + 'T12:00:00'), b = new Date(fim + 'T12:00:00');
  return Math.round((b - a) / 86400000) + 1;
}
function dpPeriodoTxt(ev) {
  if (!ev.data_fim || ev.data_fim === ev.data_inicio) return formatDateBR(ev.data_inicio);
  return formatDateBR(ev.data_inicio) + ' a ' + formatDateBR(ev.data_fim);
}
function dpMeuNome() {
  return (appState && appState.profile && (appState.profile.full_name || appState.profile.email)) || '';
}
function dpPodeEditar() {
  return DP.status !== 'fechada' || !!(appState.profile && appState.profile.is_admin);
}
function dpMsg(texto, tipo) {
  var el = document.getElementById('dpMsg');
  if (!el) return;
  if (!texto) { el.className = 'login-msg'; el.textContent = ''; return; }
  el.textContent = texto;
  el.className = 'login-msg show ' + (tipo || 'error');
  if (tipo === 'success') setTimeout(function () { if (el.textContent === texto) dpMsg(''); }, 3500);
}
function dpErro(e) {
  var m = (e && (e.message || e.error_description)) || String(e || '');
  if (/row-level security|permission denied|violates row-level/i.test(m)) {
    return DP.status === 'fechada'
      ? 'Competência fechada: só o Administrador pode alterar.'
      : 'Você não tem permissão para alterar o Departamento Pessoal.';
  }
  if (/does not exist|relation .* does not exist|schema cache/i.test(m)) {
    return 'O banco do DP ainda não foi instalado (sql/dp_01_eventos_mensais.sql).';
  }
  return m || 'Não foi possível concluir. Tente novamente.';
}
function dpLogoSrc() {
  var img = document.querySelector('.brand-logo-plate img, .login-logo-plate img');
  return img ? img.src : '';
}
function dpEhCaixaCompartilhada(c) {
  return /caixa compartilhada/i.test(c.cargo || '');
}

// ---------------------------------------------------------------------
// 1. Acesso (menu) e abertura da página
// ---------------------------------------------------------------------
function dpAtualizarAcesso() {
  var pode = !!(appState && appState.profile) && hasPermission('dp.gerenciar');
  document.querySelectorAll('[data-dp-acesso]').forEach(function (el) { el.style.display = pode ? '' : 'none'; });
  return pode;
}

async function dpAbrirPagina() {
  if (!dpAtualizarAcesso()) {
    document.getElementById('dpConteudo').style.display = 'none';
    document.getElementById('dpSemAcesso').style.display = '';
    return;
  }
  document.getElementById('dpConteudo').style.display = '';
  document.getElementById('dpSemAcesso').style.display = 'none';
  var input = document.getElementById('dpCompetencia');
  if (!DP.competencia) {
    // Até o dia 10, o DP normalmente ainda está fechando o mês anterior.
    var hoje = new Date();
    DP.competencia = hoje.getDate() <= 10 ? dpCompDeslocar(dpCompAtual(), -1) : dpCompAtual();
  }
  input.value = DP.competencia.slice(0, 7);
  await dpCarregar();
}

function dpTrocarCompetencia(valor) {
  if (!valor) return;
  DP.competencia = valor + '-01';
  dpCarregar();
}
function dpNavegarMes(delta) {
  DP.competencia = dpCompDeslocar(DP.competencia || dpCompAtual(), delta);
  document.getElementById('dpCompetencia').value = DP.competencia.slice(0, 7);
  dpCarregar();
}

function dpTrocarAba(aba) {
  DP.aba = aba;
  document.querySelectorAll('#dpTabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-dp-tab') === aba); });
  document.getElementById('dpAbaLancamentos').style.display = aba === 'lancamentos' ? '' : 'none';
  document.getElementById('dpAbaRelatorio').style.display = aba === 'relatorio' ? '' : 'none';
  if (aba === 'relatorio') dpRenderRelatorio();
}

// ---------------------------------------------------------------------
// 2. Carga de dados
// ---------------------------------------------------------------------
async function dpCarregar() {
  // Trocou de mês no meio de uma carga: recarrega assim que a atual terminar.
  if (DP.carregando) { DP.recarregar = true; return; }
  DP.carregando = true;
  DP.recarregar = false;
  dpMsg('');
  var comp = DP.competencia, fim = dpFimDoMes(comp);
  document.getElementById('dpTabelaBody').innerHTML = '<tr><td colspan="10" class="dp-vazio">Carregando…</td></tr>';
  try {
    var r = await Promise.all([
      supabase.from('dp_competencias').select('*').eq('competencia', comp).maybeSingle(),
      supabase.from('dp_lancamentos').select('*').eq('competencia', comp),
      supabase.from('dp_eventos').select('*').eq('competencia', comp).order('data_inicio', { ascending: true }),
      supabase.from('colaboradores').select('id, nome, cargo, status, unidade_id, desligado_em, created_at').order('nome'),
      supabase.from('unidades').select('id, name').order('name'),
      supabase.from('profiles').select('full_name, email, active, desativado_em')
    ]);
    for (var i = 0; i < r.length; i++) if (r[i].error) throw r[i].error;

    DP.compInfo = r[0].data || null;
    DP.status = DP.compInfo ? DP.compInfo.status : 'aberta';
    DP.lancamentos = {};
    (r[1].data || []).forEach(function (l) { DP.lancamentos[l.colaborador_id] = l; });
    DP.eventos = r[2].data || [];
    DP.unidades = {};
    (r[4].data || []).forEach(function (u) { DP.unidades[u.id] = u.name; });

    var comRegistro = {};
    Object.keys(DP.lancamentos).forEach(function (id) { comRegistro[id] = true; });
    DP.eventos.forEach(function (e) { comRegistro[e.colaborador_id] = true; });

    // Acesso ao portal desativado em Administração = saiu da empresa
    // (casamento por e-mail ou nome completo). Guarda a data da desativação.
    var inativos = {};
    (r[5].data || []).forEach(function (p) {
      if (p.active !== false) return;
      var info = { data: p.desativado_em ? p.desativado_em.slice(0, 10) : null };
      if (p.email) inativos['e:' + p.email.trim().toLowerCase()] = info;
      if (p.full_name) inativos['n:' + p.full_name.trim().toLowerCase()] = info;
    });
    DP.semDataSaida = [];

    // Regra: ativo aparece sempre; quem saiu (Lojas > Encerrar vínculo ou
    // acesso desativado) aparece ATÉ O FIM DO MÊS DA SAÍDA e depois some.
    // Saída sem data conhecida: some (e é avisado abaixo da tabela).
    // Quem já tem registro na competência aparece sempre.
    DP.colaboradores = (r[3].data || []).filter(function (c) {
      c._saida = null;
      var inat = (c.email && inativos['e:' + c.email.trim().toLowerCase()]) || inativos['n:' + (c.nome || '').trim().toLowerCase()];
      var saiu = c.status === 'desligado' || !!inat;
      if (saiu) c._saida = (c.desligado_em ? c.desligado_em.slice(0, 10) : null) || (inat && inat.data) || null;
      if (comRegistro[c.id]) return true;
      if (dpEhCaixaCompartilhada(c)) return false;
      if (c.created_at && c.created_at.slice(0, 10) > fim) return false;
      if (!saiu) return true;
      if (!c._saida) { DP.semDataSaida.push(c.nome); return false; }
      return c._saida >= comp;
    });

    dpPreencherFiltroLoja();
    dpRenderCabecalho();
    dpRenderTabela();
    if (DP.aba === 'relatorio') dpRenderRelatorio();
  } catch (e) {
    document.getElementById('dpTabelaBody').innerHTML = '<tr><td colspan="10" class="dp-vazio">' + dpEsc(dpErro(e)) + '</td></tr>';
  } finally {
    DP.carregando = false;
    if (DP.recarregar) dpCarregar();
  }
}

function dpPreencherFiltroLoja() {
  var sel = document.getElementById('dpFiltroLoja');
  var atual = DP.filtroLoja;
  var ids = {};
  DP.colaboradores.forEach(function (c) { if (c.unidade_id) ids[c.unidade_id] = true; });
  sel.innerHTML = '<option value="">Todas as lojas</option>' + Object.keys(ids)
    .sort(function (a, b) { return (DP.unidades[a] || '').localeCompare(DP.unidades[b] || ''); })
    .map(function (id) { return '<option value="' + id + '"' + (id === atual ? ' selected' : '') + '>' + dpEsc(DP.unidades[id] || 'Sem loja') + '</option>'; })
    .join('');
}

// ---------------------------------------------------------------------
// 3. Consolidação por colaborador (usada na tela e no relatório)
// ---------------------------------------------------------------------
function dpResumoColab(c) {
  var evs = DP.eventos.filter(function (e) { return e.colaborador_id === c.id; });
  var l = DP.lancamentos[c.id] || {};
  var s = { faltasInj: 0, faltasJust: 0, atrasoMin: 0, ausencias: 0, ferias: 0, outros: [], eventos: evs };
  evs.forEach(function (e) {
    var dias = Number(e.dias) || 0;
    if (e.tipo === 'falta_injustificada') s.faltasInj += dias;
    else if (e.tipo === 'falta_justificada') s.faltasJust += dias;
    else if (e.tipo === 'atraso') s.atrasoMin += Number(e.minutos) || 0;
    else if (e.tipo === 'ferias') s.ferias += dias;
    else if (DP_TIPOS[e.tipo] && DP_TIPOS[e.tipo].grupo === 'ausencia') s.ausencias += dias;
    if (['falta_injustificada', 'falta_justificada', 'atraso'].indexOf(e.tipo) === -1) s.outros.push(e);
  });
  s.meta = l.meta; s.realizado = l.realizado;
  s.premio = dpNum(l.premio_valor) || 0;
  s.outrosValores = dpNum(l.outros_valores) || 0;
  s.outrosDescricao = l.outros_descricao || '';
  s.observacao = l.observacao || '';
  s.pct = dpPct(l.meta, l.realizado);
  s.temResultado = !!DP.lancamentos[c.id];
  return s;
}

function dpColabsFiltrados() {
  var busca = (DP.busca || '').toLowerCase();
  return DP.colaboradores.filter(function (c) {
    if (DP.filtroLoja && c.unidade_id !== DP.filtroLoja) return false;
    if (busca && (c.nome || '').toLowerCase().indexOf(busca) === -1) return false;
    return true;
  }).sort(function (a, b) {
    var la = DP.unidades[a.unidade_id] || 'zz', lb = DP.unidades[b.unidade_id] || 'zz';
    return la.localeCompare(lb) || (a.nome || '').localeCompare(b.nome || '');
  });
}

// ---------------------------------------------------------------------
// 4. Tela de lançamentos
// ---------------------------------------------------------------------
function dpRenderCabecalho() {
  var fechada = DP.status === 'fechada';
  var isAdmin = !!(appState.profile && appState.profile.is_admin);
  var badge = document.getElementById('dpStatusBadge');
  badge.className = 'badge ' + (fechada ? 'badge-gray' : 'badge-green');
  badge.textContent = fechada ? 'Fechada' : 'Aberta';
  var info = document.getElementById('dpStatusInfo');
  info.textContent = fechada && DP.compInfo && DP.compInfo.fechada_em
    ? 'Fechada em ' + formatDateBR(DP.compInfo.fechada_em) + ' — alterações bloqueadas' + (isAdmin ? ' (você é Administrador e pode reabrir).' : '.')
    : 'Registre as ocorrências durante o mês e feche a competência depois de conferir o relatório.';
  document.getElementById('dpBtnFechar').style.display = fechada ? 'none' : '';
  document.getElementById('dpBtnReabrir').style.display = fechada && isAdmin ? '' : 'none';
  document.getElementById('dpBtnCopiarMetas').style.display = dpPodeEditar() ? '' : 'none';

  // KPIs
  var tot = { colab: 0, faltas: 0, ausencias: 0, ferias: 0, premio: 0, pendentes: 0 };
  DP.colaboradores.forEach(function (c) {
    var s = dpResumoColab(c);
    tot.colab++;
    tot.faltas += s.faltasInj;
    tot.ausencias += s.ausencias + s.faltasJust;
    if (s.ferias > 0) tot.ferias++;
    tot.premio += s.premio;
    if (!s.temResultado) tot.pendentes++;
  });
  document.getElementById('dpKpis').innerHTML =
    dpKpi(tot.colab, 'Colaboradores no mês') +
    dpKpi(dpQtd(tot.faltas), 'Dias de falta injustificada') +
    dpKpi(dpQtd(tot.ausencias), 'Dias de ausência justificada') +
    dpKpi(tot.ferias, 'Colaboradores com férias') +
    dpKpi(dpMoeda(tot.premio, 'R$ 0,00'), 'Total de prêmios') +
    dpKpi(tot.pendentes, 'Sem resultado lançado', tot.pendentes > 0 ? 'dp-kpi-alerta' : '');
}
function dpKpi(valor, rotulo, cls) {
  return '<div class="univ-kpi ' + (cls || '') + '"><b>' + dpEsc(valor) + '</b><span>' + dpEsc(rotulo) + '</span></div>';
}

function dpRenderTabela() {
  var body = document.getElementById('dpTabelaBody');
  var lista = dpColabsFiltrados();
  var nota = document.getElementById('dpNotaOcultos');
  if (nota) nota.textContent = DP.semDataSaida.length
    ? 'Fora da lista por estarem desligados sem data de saída registrada: ' + DP.semDataSaida.join(', ') + '. Para aparecerem no mês da saída, registre a data em Lojas.'
    : '';
  if (!lista.length) {
    body.innerHTML = '<tr><td colspan="10" class="dp-vazio">Nenhum colaborador para os filtros escolhidos. Confira o cadastro em Lojas.</td></tr>';
    return;
  }
  body.innerHTML = lista.map(function (c) {
    var s = dpResumoColab(c);
    var outros = s.outros.map(function (e) {
      var t = DP_TIPOS[e.tipo] || DP_TIPOS.outro;
      var q = t.unidade === 'dias' && e.dias ? ' ' + dpQtd(e.dias) + 'd' : '';
      return '<span class="badge badge-' + t.cor + '" title="' + dpEsc(t.rotulo + ' — ' + dpPeriodoTxt(e) + (e.observacao ? ' — ' + e.observacao : '')) + '">' + dpEsc(t.rotulo.split(' (')[0].split(' /')[0]) + q + '</span>';
    }).join(' ');
    var pct = s.pct === null ? '—' : dpNumBR(s.pct, 0) + '%';
    var pctCls = s.pct === null ? '' : (s.pct >= 100 ? 'dp-ok' : (s.pct >= 80 ? 'dp-medio' : 'dp-baixo'));
    return '<tr class="dp-linha" title="' + (dpPodeEditar() ? 'Clique para lançar' : 'Clique para ver') + '" onclick="dpAbrirColab(\'' + c.id + '\')">' +
      '<td><b>' + dpEsc(c.nome) + '</b><small>' + dpEsc(DP.unidades[c.unidade_id] || 'Sem loja') + (c._saida ? ' · <span class="dp-alerta">desligado em ' + formatDateBR(c._saida) + '</span>' : (c.status && c.status !== 'ativo' ? ' · desligado' : '')) + '</small></td>' +
      '<td class="dp-num">' + (s.faltasInj ? '<span class="dp-alerta">' + dpQtd(s.faltasInj) + '</span>' : '—') + '</td>' +
      '<td class="dp-num">' + (s.faltasJust ? dpQtd(s.faltasJust) : '—') + '</td>' +
      '<td class="dp-num">' + (s.atrasoMin ? s.atrasoMin + ' min' : '—') + '</td>' +
      '<td class="dp-num">' + (s.ferias ? dpQtd(s.ferias) + ' d' : '—') + '</td>' +
      '<td class="dp-eventos-cel">' + (outros || '<span class="dp-muted">—</span>') + '</td>' +
      '<td class="dp-num">' + dpMoeda(s.meta) + '</td>' +
      '<td class="dp-num">' + dpMoeda(s.realizado) + '</td>' +
      '<td class="dp-num ' + pctCls + '">' + pct + '</td>' +
      '<td class="dp-num">' + (s.premio ? dpMoeda(s.premio) : '—') + '</td>' +
      '</tr>';
  }).join('');
}

// ---------------------------------------------------------------------
// 5. Modal do colaborador (resultado do mês + ocorrências)
// ---------------------------------------------------------------------
function dpAbrirColab(id) {
  var c = DP.colaboradores.find(function (x) { return x.id === id; });
  if (!c) return;
  DP.colabAberto = id;
  var l = DP.lancamentos[id] || {};
  var editar = dpPodeEditar();
  document.getElementById('dpColabTitulo').textContent = c.nome;
  document.getElementById('dpColabSub').textContent = (DP.unidades[c.unidade_id] || 'Sem loja') + ' · ' + (c.cargo || '') + ' · Competência ' + dpCompLabel(DP.competencia);
  document.getElementById('dpColabMsg').className = 'login-msg';

  document.getElementById('dpResMeta').value = l.meta != null ? dpNumBR(l.meta) : '';
  document.getElementById('dpResRealizado').value = l.realizado != null ? dpNumBR(l.realizado) : '';
  document.getElementById('dpResPremio').value = l.premio_valor ? dpNumBR(l.premio_valor) : '';
  document.getElementById('dpResOutros').value = l.outros_valores ? dpNumBR(l.outros_valores) : '';
  document.getElementById('dpResOutrosDesc').value = l.outros_descricao || '';
  document.getElementById('dpResObs').value = l.observacao || '';
  dpAtualizarPctModal();

  var hoje = new Date().toISOString().slice(0, 10);
  var padrao = (hoje >= DP.competencia && hoje <= dpFimDoMes(DP.competencia)) ? hoje : DP.competencia;
  document.getElementById('dpEvTipo').value = 'falta_injustificada';
  document.getElementById('dpEvInicio').value = padrao;
  document.getElementById('dpEvFim').value = '';
  document.getElementById('dpEvDias').value = '1';
  document.getElementById('dpEvMinutos').value = '';
  document.getElementById('dpEvObs').value = '';
  dpAjustarCamposEvento();

  document.querySelectorAll('#dpColabModal [data-dp-edicao]').forEach(function (el) { el.style.display = editar ? '' : 'none'; });
  document.querySelectorAll('#dpColabModal input, #dpColabModal select, #dpColabModal textarea').forEach(function (el) { el.disabled = !editar; });
  dpRenderEventosModal();
  document.getElementById('dpColabModal').classList.remove('hidden');
}
function dpFecharColab() {
  document.getElementById('dpColabModal').classList.add('hidden');
  DP.colabAberto = null;
}
function dpColabMsg(texto, tipo) {
  var el = document.getElementById('dpColabMsg');
  el.textContent = texto;
  el.className = 'login-msg show ' + (tipo || 'error');
  if (tipo === 'success') setTimeout(function () { if (el.textContent === texto) el.className = 'login-msg'; }, 2500);
}
function dpAtualizarPctModal() {
  var p = dpPct(document.getElementById('dpResMeta').value, document.getElementById('dpResRealizado').value);
  document.getElementById('dpResPct').textContent = p === null ? 'Atingimento: —' : 'Atingimento: ' + dpNumBR(p, 1) + '%';
}

function dpAjustarCamposEvento() {
  var tipo = document.getElementById('dpEvTipo').value;
  var t = DP_TIPOS[tipo] || DP_TIPOS.outro;
  document.getElementById('dpEvCampoDias').style.display = t.unidade === 'dias' ? '' : 'none';
  document.getElementById('dpEvCampoMinutos').style.display = t.unidade === 'minutos' ? '' : 'none';
  document.getElementById('dpEvCampoFim').style.display = t.unidade === 'dias' ? '' : 'none';
  dpRecalcularDias();
}
function dpRecalcularDias() {
  var ini = document.getElementById('dpEvInicio').value, fim = document.getElementById('dpEvFim').value;
  if (ini && fim && fim >= ini) document.getElementById('dpEvDias').value = dpDiasEntre(ini, fim);
}

function dpRenderEventosModal() {
  var lista = DP.eventos.filter(function (e) { return e.colaborador_id === DP.colabAberto; });
  var el = document.getElementById('dpEvLista');
  if (!lista.length) { el.innerHTML = '<div class="dp-muted" style="padding:8px 2px;">Nenhuma ocorrência registrada neste mês.</div>'; return; }
  var editar = dpPodeEditar();
  el.innerHTML = lista.map(function (e) {
    var t = DP_TIPOS[e.tipo] || DP_TIPOS.outro;
    var qtd = t.unidade === 'minutos' ? (e.minutos || 0) + ' min' : (t.unidade === 'dias' && e.dias ? dpQtd(e.dias) + (Number(e.dias) === 1 ? ' dia' : ' dias') : '');
    return '<div class="dp-ev-item"><span class="badge badge-' + t.cor + '">' + dpEsc(t.rotulo) + '</span>' +
      '<div class="dp-ev-txt"><b>' + dpEsc(dpPeriodoTxt(e)) + (qtd ? ' · ' + qtd : '') + '</b>' + (e.observacao ? '<small>' + dpEsc(e.observacao) + '</small>' : '') + '</div>' +
      (editar ? '<button type="button" class="dp-btn-x" title="Excluir ocorrência" onclick="dpExcluirEvento(\'' + e.id + '\')">&times;</button>' : '') + '</div>';
  }).join('');
}

async function dpGarantirCompetencia() {
  if (DP.compInfo) return;
  var res = await supabase.from('dp_competencias').upsert({ competencia: DP.competencia }, { onConflict: 'competencia', ignoreDuplicates: true });
  if (res.error) throw res.error;
  var r2 = await supabase.from('dp_competencias').select('*').eq('competencia', DP.competencia).maybeSingle();
  if (r2.error) throw r2.error;
  DP.compInfo = r2.data;
}

async function dpSalvarResultado() {
  var c = DP.colaboradores.find(function (x) { return x.id === DP.colabAberto; });
  if (!c) return;
  var meta = dpNum(document.getElementById('dpResMeta').value);
  var realizado = dpNum(document.getElementById('dpResRealizado').value);
  var premio = dpNum(document.getElementById('dpResPremio').value) || 0;
  var outros = dpNum(document.getElementById('dpResOutros').value) || 0;
  var outrosDesc = document.getElementById('dpResOutrosDesc').value.trim();
  if (outros && !outrosDesc) { dpColabMsg('Descreva o que é o valor em "Outros valores" (ex.: ajuda de custo, desconto de adiantamento).'); return; }
  if ([meta, realizado, premio].some(function (v) { return v !== null && v < 0; })) {
    dpColabMsg('Meta, realizado e prêmio não podem ser negativos.'); return;
  }
  var btn = document.getElementById('dpBtnSalvarRes');
  btn.disabled = true;
  try {
    await dpGarantirCompetencia();
    var linha = {
      competencia: DP.competencia, colaborador_id: c.id, unidade_id: c.unidade_id || null,
      meta: meta, realizado: realizado, premio_valor: premio, outros_valores: outros,
      outros_descricao: outrosDesc || null, observacao: document.getElementById('dpResObs').value.trim() || null
    };
    var res = await supabase.from('dp_lancamentos').upsert(linha, { onConflict: 'competencia,colaborador_id' }).select().single();
    if (res.error) throw res.error;
    DP.lancamentos[c.id] = res.data;
    dpColabMsg('Resultado do mês salvo.', 'success');
    dpRenderCabecalho();
    dpRenderTabela();
  } catch (e) {
    dpColabMsg(dpErro(e));
  } finally {
    btn.disabled = false;
  }
}

async function dpAdicionarEvento() {
  var c = DP.colaboradores.find(function (x) { return x.id === DP.colabAberto; });
  if (!c) return;
  var tipo = document.getElementById('dpEvTipo').value;
  var t = DP_TIPOS[tipo] || DP_TIPOS.outro;
  var ini = document.getElementById('dpEvInicio').value;
  var fim = t.unidade === 'dias' ? (document.getElementById('dpEvFim').value || null) : null;
  var dias = t.unidade === 'dias' ? dpNum(document.getElementById('dpEvDias').value) : null;
  var minutos = t.unidade === 'minutos' ? parseInt(document.getElementById('dpEvMinutos').value, 10) : null;
  var obs = document.getElementById('dpEvObs').value.trim();

  if (!ini) { dpColabMsg('Informe a data da ocorrência.'); return; }
  if (fim && fim < ini) { dpColabMsg('A data final não pode ser antes da data inicial.'); return; }
  if (ini > dpFimDoMes(DP.competencia) || (fim || ini) < DP.competencia) {
    if (!confirm('A data informada está fora de ' + dpCompLabel(DP.competencia) + '. Registrar mesmo assim nesta competência?')) return;
  }
  if (t.unidade === 'dias' && (!dias || dias <= 0)) { dpColabMsg('Informe a quantidade de dias (pode ser 0,5 para meio período).'); return; }
  if (t.unidade === 'minutos' && (!minutos || minutos <= 0)) { dpColabMsg('Informe os minutos de atraso.'); return; }
  if (['falta_justificada', 'atestado', 'advertencia', 'suspensao', 'outro'].indexOf(tipo) !== -1 && !obs) {
    dpColabMsg('Para ' + t.rotulo.toLowerCase() + ', descreva o motivo na observação (ex.: CID não é necessário; informe "atestado entregue em 05/11").'); return;
  }
  var btn = document.getElementById('dpBtnAddEv');
  btn.disabled = true;
  try {
    await dpGarantirCompetencia();
    var res = await supabase.from('dp_eventos').insert({
      competencia: DP.competencia, colaborador_id: c.id, tipo: tipo,
      data_inicio: ini, data_fim: fim, dias: dias, minutos: isNaN(minutos) ? null : minutos, observacao: obs || null
    }).select().single();
    if (res.error) throw res.error;
    DP.eventos.push(res.data);
    DP.eventos.sort(function (a, b) { return a.data_inicio.localeCompare(b.data_inicio); });
    document.getElementById('dpEvObs').value = '';
    document.getElementById('dpEvFim').value = '';
    document.getElementById('dpEvDias').value = '1';
    document.getElementById('dpEvMinutos').value = '';
    dpRenderEventosModal();
    dpRenderCabecalho();
    dpRenderTabela();
    dpColabMsg('Ocorrência registrada.', 'success');
  } catch (e) {
    dpColabMsg(dpErro(e));
  } finally {
    btn.disabled = false;
  }
}

async function dpExcluirEvento(id) {
  if (!confirm('Excluir esta ocorrência?')) return;
  try {
    var res = await supabase.from('dp_eventos').delete().eq('id', id);
    if (res.error) throw res.error;
    DP.eventos = DP.eventos.filter(function (e) { return e.id !== id; });
    dpRenderEventosModal();
    dpRenderCabecalho();
    dpRenderTabela();
  } catch (e) {
    dpColabMsg(dpErro(e));
  }
}

// ---------------------------------------------------------------------
// 6. Ações da competência
// ---------------------------------------------------------------------
async function dpCopiarMetas() {
  var anterior = dpCompDeslocar(DP.competencia, -1);
  if (!confirm('Copiar as metas de ' + dpCompLabel(anterior) + ' para quem ainda está sem meta em ' + dpCompLabel(DP.competencia) + '?\n\nRealizado e prêmio NÃO são copiados.')) return;
  try {
    var res = await supabase.from('dp_lancamentos').select('colaborador_id, meta').eq('competencia', anterior).not('meta', 'is', null);
    if (res.error) throw res.error;
    var ids = {};
    DP.colaboradores.forEach(function (c) { ids[c.id] = c; });
    var novos = (res.data || []).filter(function (l) {
      var atual = DP.lancamentos[l.colaborador_id];
      return ids[l.colaborador_id] && (!atual || atual.meta == null);
    });
    if (!novos.length) { dpMsg('Não há metas do mês anterior para copiar (ou todos já têm meta).', 'info'); return; }
    await dpGarantirCompetencia();
    var linhas = novos.map(function (l) {
      var atual = DP.lancamentos[l.colaborador_id] || {};
      return {
        competencia: DP.competencia, colaborador_id: l.colaborador_id, unidade_id: ids[l.colaborador_id].unidade_id || null,
        meta: l.meta, realizado: atual.realizado != null ? atual.realizado : null,
        premio_valor: atual.premio_valor || 0, outros_valores: atual.outros_valores || 0,
        outros_descricao: atual.outros_descricao || null, observacao: atual.observacao || null
      };
    });
    var up = await supabase.from('dp_lancamentos').upsert(linhas, { onConflict: 'competencia,colaborador_id' });
    if (up.error) throw up.error;
    dpMsg(novos.length + ' meta(s) copiada(s) de ' + dpCompLabel(anterior) + '.', 'success');
    await dpCarregar();
  } catch (e) {
    dpMsg(dpErro(e));
  }
}

function dpPendencias() {
  var p = [];
  DP.colaboradores.forEach(function (c) {
    var s = dpResumoColab(c);
    if (!s.temResultado) p.push(c.nome + ': resultado do mês não lançado');
    else if (s.meta == null && s.realizado == null && !s.premio) p.push(c.nome + ': sem meta, realizado e prêmio');
  });
  return p;
}

async function dpFecharCompetencia() {
  var pend = dpPendencias();
  var aviso = 'Fechar a competência ' + dpCompLabel(DP.competencia) + '?\n\nDepois de fechada, ninguém altera mais (só o Administrador reabre).';
  if (pend.length) aviso += '\n\nATENÇÃO — ' + pend.length + ' pendência(s):\n• ' + pend.slice(0, 8).join('\n• ') + (pend.length > 8 ? '\n• …' : '');
  if (!confirm(aviso)) return;
  try {
    await dpGarantirCompetencia();
    var res = await supabase.from('dp_competencias').update({ status: 'fechada' }).eq('competencia', DP.competencia).select().single();
    if (res.error) throw res.error;
    dpMsg('Competência fechada. Gere o relatório e envie à contabilidade.', 'success');
    await dpCarregar();
  } catch (e) { dpMsg(dpErro(e)); }
}

async function dpReabrirCompetencia() {
  if (!confirm('Reabrir ' + dpCompLabel(DP.competencia) + ' para alterações?\n\nSe o relatório já foi enviado à contabilidade, avise-a das mudanças.')) return;
  try {
    var res = await supabase.from('dp_competencias').update({ status: 'aberta' }).eq('competencia', DP.competencia).select().single();
    if (res.error) throw res.error;
    dpMsg('Competência reaberta.', 'success');
    await dpCarregar();
  } catch (e) { dpMsg(dpErro(e)); }
}

// ---------------------------------------------------------------------
// 7. Relatório de fechamento
// ---------------------------------------------------------------------
function dpDadosRelatorio() {
  var lista = dpColabsFiltrados();
  var linhas = lista.map(function (c) { return { c: c, s: dpResumoColab(c) }; });
  var porLoja = {};
  linhas.forEach(function (x) {
    var loja = DP.unidades[x.c.unidade_id] || 'Sem loja';
    if (!porLoja[loja]) porLoja[loja] = { loja: loja, colab: 0, faltasInj: 0, faltasJust: 0, ausencias: 0, ferias: 0, meta: 0, realizado: 0, premio: 0, outros: 0 };
    var t = porLoja[loja];
    t.colab++; t.faltasInj += x.s.faltasInj; t.faltasJust += x.s.faltasJust; t.ausencias += x.s.ausencias;
    t.ferias += x.s.ferias; t.meta += dpNum(x.s.meta) || 0; t.realizado += dpNum(x.s.realizado) || 0;
    t.premio += x.s.premio; t.outros += x.s.outrosValores;
  });
  var lojas = Object.keys(porLoja).sort().map(function (k) { return porLoja[k]; });
  var total = lojas.reduce(function (a, t) {
    Object.keys(t).forEach(function (k) { if (typeof t[k] === 'number') a[k] = (a[k] || 0) + t[k]; });
    return a;
  }, { loja: 'Total' });
  return { linhas: linhas, lojas: lojas, total: total, pendencias: dpPendencias() };
}

function dpRenderRelatorio() {
  var d = dpDadosRelatorio();
  var el = document.getElementById('dpRelatorioPreview');
  if (!d.linhas.length) { el.innerHTML = '<div class="docs-empty">Nada para relatar neste mês.</div>'; return; }
  el.innerHTML = dpHtmlRelatorio(d, false);
}

function dpHtmlRelatorio(d, paraImpressao) {
  var comp = DP.competencia;
  var fechada = DP.status === 'fechada';
  var hoje = new Date();
  var dataDoc = (hoje.getDate() < 10 ? '0' : '') + hoje.getDate() + '/' + (hoje.getMonth() < 9 ? '0' : '') + (hoje.getMonth() + 1) + '/' + hoje.getFullYear();
  var filtro = DP.filtroLoja ? ' — ' + (DP.unidades[DP.filtroLoja] || '') : '';
  var comOcorrencia = d.linhas.filter(function (x) { return x.s.eventos.length; }).length;

  var h = '';
  h += '<div class="dpr-doc">';
  h += '<div class="dpr-cab"><img src="' + dpEsc(dpLogoSrc()) + '" alt="Facilita"><div><b>Relatório de Eventos Mensais — DP</b><span>DP-REL-001</span></div></div>';
  h += '<h1 class="dpr-titulo">Fechamento do Departamento Pessoal — ' + dpEsc(dpCompLabelCap(comp)) + dpEsc(filtro) + '</h1>';
  h += '<table class="dpr-quadro"><tr><th>Código</th><th>Versão</th><th>Data</th><th>Área</th><th>Situação</th></tr>' +
       '<tr><td>DP-REL-001</td><td>01</td><td>' + dataDoc + '</td><td>Departamento Pessoal</td><td>' + (fechada ? 'Competência fechada' : 'PRÉVIA — competência aberta') + '</td></tr></table>';
  h += '<div class="dpr-resumo"><b>Resumo:</b> ' + d.total.colab + ' colaborador(es); ' + comOcorrencia + ' com ocorrência no mês; ' +
       dpQtd(d.total.faltasInj) + ' dia(s) de falta injustificada; ' + dpQtd(d.total.faltasJust + d.total.ausencias) + ' dia(s) de ausência justificada; ' +
       dpQtd(d.total.ferias) + ' dia(s) de férias; prêmios a pagar: <b>' + dpMoeda(d.total.premio, 'R$ 0,00') + '</b>' +
       (d.total.outros ? '; outros valores: ' + dpMoeda(d.total.outros) : '') + '.</div>';

  if (d.pendencias.length) {
    h += '<div class="dpr-atencao"><b>Atenção — pendências antes de enviar à contabilidade:</b><ul>' +
         d.pendencias.map(function (p) { return '<li>' + dpEsc(p) + '</li>'; }).join('') + '</ul></div>';
  }

  // 1. Por loja
  h += '<h2 class="dpr-sec">1. Consolidado por loja</h2>';
  h += '<table class="dpr-tab"><thead><tr><th>Loja</th><th>Colab.</th><th>Faltas inj. (d)</th><th>Ausências just. (d)</th><th>Férias (d)</th><th>Meta</th><th>Realizado</th><th>% Ating.</th><th>Prêmios</th></tr></thead><tbody>';
  d.lojas.concat([d.total]).forEach(function (t, i, arr) {
    var p = dpPct(t.meta, t.realizado);
    h += '<tr' + (i === arr.length - 1 ? ' class="dpr-total"' : '') + '><td>' + dpEsc(t.loja) + '</td><td class="n">' + t.colab + '</td><td class="n">' + dpQtd(t.faltasInj) + '</td><td class="n">' +
         dpQtd(t.faltasJust + t.ausencias) + '</td><td class="n">' + dpQtd(t.ferias) + '</td><td class="n">' + dpMoeda(t.meta || null) + '</td><td class="n">' +
         dpMoeda(t.realizado || null) + '</td><td class="n">' + (p === null ? '—' : dpNumBR(p, 1) + '%') + '</td><td class="n">' + dpMoeda(t.premio, 'R$ 0,00') + '</td></tr>';
  });
  h += '</tbody></table>';

  // 2. Por colaborador
  h += '<h2 class="dpr-sec">2. Quadro por colaborador</h2>';
  h += '<table class="dpr-tab"><thead><tr><th>Colaborador</th><th>Loja</th><th>Faltas inj.</th><th>Faltas just.</th><th>Atrasos</th><th>Atest./Lic.</th><th>Férias</th><th>Meta</th><th>Realizado</th><th>%</th><th>Prêmio</th><th>Outros</th></tr></thead><tbody>';
  d.linhas.forEach(function (x) {
    var s = x.s;
    h += '<tr><td>' + dpEsc(x.c.nome) + (x.c._saida ? '<br><i>desligado em ' + formatDateBR(x.c._saida) + '</i>' : '') + '</td><td>' + dpEsc(DP.unidades[x.c.unidade_id] || '—') + '</td>' +
         '<td class="n">' + (s.faltasInj ? dpQtd(s.faltasInj) : '—') + '</td><td class="n">' + (s.faltasJust ? dpQtd(s.faltasJust) : '—') + '</td>' +
         '<td class="n">' + (s.atrasoMin ? s.atrasoMin + ' min' : '—') + '</td><td class="n">' + (s.ausencias ? dpQtd(s.ausencias) : '—') + '</td>' +
         '<td class="n">' + (s.ferias ? dpQtd(s.ferias) : '—') + '</td><td class="n">' + dpMoeda(s.meta) + '</td><td class="n">' + dpMoeda(s.realizado) + '</td>' +
         '<td class="n">' + (s.pct === null ? '—' : dpNumBR(s.pct, 0) + '%') + '</td><td class="n">' + (s.premio ? dpMoeda(s.premio) : '—') + '</td>' +
         '<td class="n">' + (s.outrosValores ? dpMoeda(s.outrosValores) + '<br><i>' + dpEsc(s.outrosDescricao) + '</i>' : '—') + '</td></tr>';
  });
  h += '</tbody></table>';

  // 3. Ocorrências detalhadas
  h += '<h2 class="dpr-sec">3. Ocorrências detalhadas (datas para a folha)</h2>';
  var algum = false;
  h += '<table class="dpr-tab"><thead><tr><th>Colaborador</th><th>Ocorrência</th><th>Período</th><th>Qtd.</th><th>Observação</th></tr></thead><tbody>';
  d.linhas.forEach(function (x) {
    x.s.eventos.forEach(function (e) {
      algum = true;
      var t = DP_TIPOS[e.tipo] || DP_TIPOS.outro;
      var q = t.unidade === 'minutos' ? (e.minutos || 0) + ' min' : (t.unidade === 'dias' && e.dias ? dpQtd(e.dias) + ' d' : '—');
      h += '<tr><td>' + dpEsc(x.c.nome) + '</td><td>' + dpEsc(t.rotulo) + '</td><td>' + dpEsc(dpPeriodoTxt(e)) + '</td><td class="n">' + q + '</td><td><i>' + dpEsc(e.observacao || '') + '</i></td></tr>';
    });
  });
  if (!algum) h += '<tr><td colspan="5"><i>Nenhuma ocorrência registrada no mês.</i></td></tr>';
  h += '</tbody></table>';

  // 4. Observações por colaborador
  var obs = d.linhas.filter(function (x) { return x.s.observacao; });
  if (obs.length) {
    h += '<h2 class="dpr-sec">4. Observações para a contabilidade</h2><ul class="dpr-obs">';
    obs.forEach(function (x) { h += '<li><b>' + dpEsc(x.c.nome) + ':</b> ' + dpEsc(x.s.observacao) + '</li>'; });
    h += '</ul>';
  }

  h += '<div class="dpr-atencao dpr-lembrete"><b>Conferência obrigatória antes de enviar:</b> quem tirou férias no mês deve ter o salário do mês proporcional aos dias trabalhados (os dias de férias já são pagos no recibo de férias). Faltas injustificadas descontam o dia e o DSR da semana.</div>';

  h += '<h2 class="dpr-sec">' + (obs.length ? '5' : '4') + '. Aprovação</h2>';
  h += '<table class="dpr-aprov"><tr><th>Elaborado por</th><th>Aprovado por</th></tr><tr><td>' + dpEsc(dpMeuNome()) + '<div class="dpr-assin">Assinatura / data</div></td><td>&nbsp;<div class="dpr-assin">Assinatura / data</div></td></tr></table>';
  if (!paraImpressao) h += '<div class="dpr-rodape-tela">Facilita Empréstimo · Uso interno &nbsp;|&nbsp; Versão 01 · ' + dataDoc + '</div>';
  h += '</div>';
  return h;
}

function dpImprimirRelatorio() {
  var d = dpDadosRelatorio();
  if (!d.linhas.length) { dpMsg('Nada para imprimir neste mês.', 'info'); return; }
  var hoje = new Date();
  var dataDoc = (hoje.getDate() < 10 ? '0' : '') + hoje.getDate() + '/' + (hoje.getMonth() < 9 ? '0' : '') + (hoje.getMonth() + 1) + '/' + hoje.getFullYear();
  var w = window.open('', '_blank');
  if (!w) { dpMsg('O navegador bloqueou a janela do relatório. Libere pop-ups para o portal e tente de novo.'); return; }
  var titulo = 'DP-REL-001 Eventos ' + dpCompLabel(DP.competencia);
  w.document.open();
  w.document.write('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + dpEsc(titulo) + '</title><style>' + DP_CSS_RELATORIO +
    '@page{size:A4 landscape;margin:14mm 12mm 16mm;' +
    '@bottom-left{content:"Facilita Empréstimo · Uso interno";font:9px Arial,sans-serif;color:#6B7280;}' +
    '@bottom-center{content:"Versão 01 · ' + dataDoc + '";font:9px Arial,sans-serif;color:#6B7280;}' +
    '@bottom-right{content:"Página " counter(page) " de " counter(pages);font:9px Arial,sans-serif;color:#6B7280;}}' +
    '</style></head><body>' + dpHtmlRelatorio(d, true) + '</body></html>');
  w.document.close();
  w.onload = function () { setTimeout(function () { w.focus(); w.print(); }, 300); };
}

function dpExportarCsv() {
  var d = dpDadosRelatorio();
  var esc = function (v) { v = v == null ? '' : String(v); return '"' + v.replace(/"/g, '""') + '"'; };
  var num = function (v) { var n = dpNum(v); return n === null ? '' : n.toFixed(2).replace('.', ','); };
  var csv = ['Competência;Colaborador;Loja;Cargo;Faltas injustificadas (dias);Faltas justificadas (dias);Atrasos (min);Atestados/licenças/afastamentos (dias);Férias (dias);Outros eventos;Meta;Realizado;% Atingimento;Prêmio;Outros valores;Descrição outros valores;Observação'];
  d.linhas.forEach(function (x) {
    var s = x.s;
    var outros = s.outros.filter(function (e) { return e.tipo !== 'ferias'; }).map(function (e) { return (DP_TIPOS[e.tipo] || DP_TIPOS.outro).rotulo + ' ' + dpPeriodoTxt(e); }).join(' | ');
    csv.push([dpCompLabel(DP.competencia), x.c.nome, DP.unidades[x.c.unidade_id] || '', x.c.cargo || '',
      dpQtd(s.faltasInj), dpQtd(s.faltasJust), s.atrasoMin, dpQtd(s.ausencias), dpQtd(s.ferias), outros,
      num(s.meta), num(s.realizado), s.pct === null ? '' : s.pct.toFixed(1).replace('.', ','), num(s.premio), num(s.outrosValores),
      s.outrosDescricao, s.observacao].map(esc).join(';'));
  });
  csv.push('');
  csv.push('Ocorrências detalhadas');
  csv.push('Colaborador;Ocorrência;Início;Fim;Dias;Minutos;Observação');
  d.linhas.forEach(function (x) {
    x.s.eventos.forEach(function (e) {
      csv.push([x.c.nome, (DP_TIPOS[e.tipo] || DP_TIPOS.outro).rotulo, formatDateBR(e.data_inicio), e.data_fim ? formatDateBR(e.data_fim) : '',
        e.dias != null ? dpQtd(e.dias) : '', e.minutos != null ? e.minutos : '', e.observacao || ''].map(esc).join(';'));
    });
  });
  var blob = new Blob(['﻿' + csv.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dp-eventos-' + DP.competencia.slice(0, 7) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Estilo do relatório (padrão oficial de documentos da Facilita):
// cabeçalho com logo à esquerda + nome/código à direita, título azul-escuro,
// quadro Código·Versão·Data·Área, resumo em destaque, seções com linha laranja,
// tabelas com cabeçalho azul-escuro, quadros de atenção com borda laranja e aprovação.
var DP_CSS_RELATORIO =
  '.dpr-doc{font-family:Arial,Helvetica,sans-serif;color:#1F2937;font-size:11px;line-height:1.45;}' +
  '.dpr-cab{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #023047;padding-bottom:8px;margin-bottom:14px;}' +
  '.dpr-cab img{height:34px;width:auto;}' +
  '.dpr-cab div{text-align:right;}.dpr-cab b{display:block;color:#023047;font-size:12px;}.dpr-cab span{color:#6B7280;font-size:10px;}' +
  '.dpr-titulo{color:#023047;font-size:18px;margin:4px 0 10px;}' +
  '.dpr-quadro{border-collapse:collapse;margin-bottom:12px;font-size:10px;}' +
  '.dpr-quadro th{background:#023047;color:#fff;padding:4px 10px;text-align:left;font-weight:600;}' +
  '.dpr-quadro td{border:1px solid #D1D5DB;padding:4px 10px;}' +
  '.dpr-resumo{background:#EEF4F8;border-left:4px solid #023047;padding:8px 12px;margin-bottom:12px;border-radius:4px;}' +
  '.dpr-sec{color:#023047;font-size:13px;margin:18px 0 8px;padding-bottom:4px;border-bottom:2px solid #FB8500;}' +
  '.dpr-tab{width:100%;border-collapse:collapse;font-size:10px;page-break-inside:auto;}' +
  '.dpr-tab tr{page-break-inside:avoid;}' +
  '.dpr-tab th{background:#023047;color:#fff;padding:5px 6px;text-align:left;font-weight:600;}' +
  '.dpr-tab td{border-bottom:1px solid #E5E7EB;padding:4px 6px;vertical-align:top;}' +
  '.dpr-tab td.n{text-align:right;white-space:nowrap;}' +
  '.dpr-tab tr.dpr-total td{font-weight:700;background:#F3F4F6;border-top:2px solid #023047;}' +
  '.dpr-atencao{border:2px solid #FB8500;background:#FFF7ED;border-radius:6px;padding:8px 12px;margin:12px 0;}' +
  '.dpr-atencao ul{margin:4px 0 0 18px;padding:0;}' +
  '.dpr-obs{margin:0 0 0 18px;padding:0;}' +
  '.dpr-aprov{width:100%;border-collapse:collapse;margin-top:6px;page-break-inside:avoid;}' +
  '.dpr-aprov th{background:#023047;color:#fff;padding:5px 8px;text-align:left;width:50%;}' +
  '.dpr-aprov td{border:1px solid #D1D5DB;padding:8px;height:54px;vertical-align:top;}' +
  '.dpr-assin{margin-top:26px;border-top:1px solid #9CA3AF;padding-top:2px;font-size:9px;color:#6B7280;}' +
  '.dpr-rodape-tela{margin-top:16px;padding-top:6px;border-top:1px solid #E5E7EB;font-size:9.5px;color:#6B7280;}';

// Aplica o mesmo estilo na prévia dentro do portal.
(function () {
  var st = document.createElement('style');
  st.textContent = DP_CSS_RELATORIO;
  document.head.appendChild(st);
})();
