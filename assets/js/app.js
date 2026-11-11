/* ==========================================================================
 * Controlador principal do painel.
 * Painel configuravel por empresa: o catalogo de widgets vive em widgets.js e
 * a config (visibilidade + ordem) e salva por empresa (servidor + cache local).
 * Cada "fonte de dados" (fetch) so roda se ha widget visivel que dependa dela.
 *
 * Multiloja: com 2+ lojas marcadas cada fonte e buscada em cada loja e
 * consolidada por merge.js; os renders recebem o mesmo formato de sempre.
 * A config do painel e a da 1a loja selecionada.
 * ========================================================================== */
(function () {
  var api = LADBI.api, fmt = LADBI.fmt, charts = LADBI.charts, cfg = LADBI.config, W = LADBI.widgets;
  var merge = LADBI.merge, exporter = LADBI.exporter;

  // ponytail: cada loja marcada multiplica as chamadas (ate ~10 por loja). Acima disso o caminho
  // e consolidar no servidor (endpoint com idsEmpresas), nao aumentar o teto.
  var MAX_LOJAS = 12;

  function el(id) { return document.getElementById(id); }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  // Cache dos dados renderizados (para re-render ao trocar tema, sem refetch)
  var cache = {};
  // Sazonalidade nao depende do periodo do filtro: fica fora do cache limpo a cada carga.
  var sazCache = {};
  var state = { range: null, preset: 'mes', gen: 0, config: null, visibleSet: {}, empresas: [], produtoPor: 'nome' };

  // Cards alimentados pela fonte "caixa" (ranking consolidado).
  var CAIXA_CARDS = [
    { id: 'vendedores', card: 'card-vendedores' },
    { id: 'formas', card: 'card-formas' },
    { id: 'produtos-top', card: 'card-produtos-top' },
    { id: 'produtos-bottom', card: 'card-produtos-bottom' }
  ];

  /* ---------------------------------------------------------------- estados */
  function setState(cardId, type, msg) {
    var c = el(cardId);
    if (!c) return;
    var ov = c.querySelector('.card-overlay');
    c.classList.toggle('is-loading', type === 'loading');
    if (type === 'ready') {
      if (ov) ov.hidden = true;
      c.classList.remove('has-state');
      return;
    }
    c.classList.add('has-state');
    if (!ov) return;
    ov.hidden = false;
    if (type === 'loading') {
      ov.innerHTML = '<div class="spinner"></div><span>Carregando…</span>';
    } else if (type === 'empty') {
      ov.innerHTML = '<div class="state-ic">◍</div><span>' + escapeHtml(msg || 'Sem dados neste periodo.') + '</span>';
    } else {
      ov.innerHTML = '<div class="state-ic err">!</div><span>' + escapeHtml(msg || 'Erro ao carregar.') + '</span>' +
        '<button class="btn-ghost sm" data-retry="1">Tentar de novo</button>';
    }
  }

  /* --------------------------------------------------------------- periodos */
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseInput(v) { var p = String(v).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

  function computeRange(preset) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (preset) {
      case 'hoje': return { inicio: today, fim: today };
      case 'ontem': var y = addDays(today, -1); return { inicio: y, fim: y };
      case '7d': return { inicio: addDays(today, -6), fim: today };
      case '30d': return { inicio: addDays(today, -29), fim: today };
      case 'mes': return { inicio: startOfMonth(today), fim: today };
      case 'mes-1':
        var pm = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        return { inicio: startOfMonth(pm), fim: endOfMonth(pm) };
      default: return { inicio: startOfMonth(today), fim: today };
    }
  }

  function applyPreset(preset) {
    state.preset = preset;
    state.range = computeRange(preset);
    syncFilterUI();
    loadDashboard();
  }

  function applyCustom() {
    var di = el('date-inicio').value, df = el('date-fim').value;
    if (!di || !df) return;
    var inicio = parseInput(di), fim = parseInput(df);
    if (fim < inicio) { var t = inicio; inicio = fim; fim = t; }
    state.preset = 'custom';
    state.range = { inicio: inicio, fim: fim };
    syncFilterUI();
    loadDashboard();
  }

  function syncFilterUI() {
    var btns = document.querySelectorAll('[data-range]');
    btns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-range') === state.preset); });
    el('date-inicio').value = fmt.inputDate(state.range.inicio);
    el('date-fim').value = fmt.inputDate(state.range.fim);
    el('periodo-label').textContent = fmt.dateBR(state.range.inicio) + ' – ' + fmt.dateBR(state.range.fim);
  }

  /* --------------------------------------------------------- config (widgets) */
  function visible(id) { return !!state.visibleSet[id]; }

  function setConfig(rawCfg) {
    var norm = W.normalize(rawCfg);
    state.config = norm;
    state.visibleSet = {};
    norm.widgets.forEach(function (w) { state.visibleSet[w.id] = w.visible; });
    applyConfigToDom();
  }

  // Mostra/oculta e ordena os cards conforme a config aplicada.
  function applyConfigToDom() {
    var order = 0;
    state.config.widgets.forEach(function (w) {
      var meta = W.get(w.id);
      if (!meta) return;
      var node = el(meta.cardId);
      if (!node) return;
      node.hidden = !w.visible;
      // kpi-row fica fora do grid (sempre no topo); demais respeitam a ordem salva.
      if (meta.cardId !== 'kpi-row') { node.style.order = order++; }
    });
  }

  // Uniao das fontes exigidas pelos widgets visiveis.
  function neededSources() {
    var need = {};
    W.list.forEach(function (w) {
      if (!visible(w.id)) return;
      (w.sources || []).forEach(function (s) { need[s] = true; });
    });
    return need;
  }

  // Cache local da config, por empresa (dentro de prefs).
  function loadConfigCache(idEmpresa) {
    var p = loadPrefs();
    return (p.configByEmpresa && p.configByEmpresa[idEmpresa]) || null;
  }
  function saveConfigCache(idEmpresa, c) {
    var p = loadPrefs();
    p.configByEmpresa = p.configByEmpresa || {};
    p.configByEmpresa[idEmpresa] = c;
    savePrefs(p);
  }

  // Carrega a config da empresa (cache local imediato -> confirma no servidor) e recarrega o painel.
  function loadConfigThenDashboard() {
    var idEmpresa = api.getEmpresaId();
    // Zera o cache de dados renderizados (preserva a lista de empresas) para que
    // export CSV / re-render de tema nao usem dados da empresa anterior na janela de troca.
    cache = { empresas: cache.empresas };
    setConfig(loadConfigCache(idEmpresa) || W.defaultConfig());
    api.dashboardConfigGet(idEmpresa).then(function (resp) {
      if (resp && resp.config) {
        saveConfigCache(idEmpresa, resp.config);
        setConfig(resp.config);
      }
    }).catch(function () {
      // servidor indisponivel: mantem cache/default (o painel continua funcionando)
    }).finally(function () {
      loadDashboard();
    });
  }

  /* ----------------------------------------------------------- agregacao caixa */
  // Fallback quando ranking_consolidado nao vem (periodo com 1 unico caixa).
  function aggregateFromCaixas(caixas) {
    var prod = {}, vend = {}, forma = {};
    (caixas || []).forEach(function (cx) {
      (cx.produtos_mais_vendidos || []).forEach(function (p) {
        var nome = p.produto ? p.produto.nome : 'Produto';
        var o = prod[nome] || (prod[nome] = { produto: p.produto || { nome: nome }, quantidade: 0, valorTotal: 0 });
        o.quantidade += Number(p.quantidade) || 0; o.valorTotal += Number(p.valorTotal) || 0;
      });
      (cx.vendedores_ranking || []).forEach(function (v) {
        var nome = v.vendedor ? v.vendedor.nome : 'Vendedor';
        var o = vend[nome] || (vend[nome] = { vendedor: v.vendedor || { nome: nome }, quantidadeVendas: 0, valorTotal: 0 });
        o.quantidadeVendas += Number(v.quantidadeVendas) || 0; o.valorTotal += Number(v.valorTotal) || 0;
      });
      (cx.recebimentos_por_forma || []).forEach(function (f) {
        var nome = f.forma ? f.forma.nome : 'Forma';
        var o = forma[nome] || (forma[nome] = { forma: f.forma || { nome: nome }, quantidade: 0, valor: 0 });
        o.quantidade += Number(f.quantidade) || 0; o.valor += Number(f.valor) || 0;
      });
    });
    function arr(map, key) {
      return Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return (b[key] || 0) - (a[key] || 0); });
    }
    function comPercentual(list, key) {
      var total = list.reduce(function (s, it) { return s + (Number(it[key]) || 0); }, 0);
      list.forEach(function (it) { it.percentual = total ? (Number(it[key]) || 0) / total * 100 : 0; });
      return list;
    }
    var produtos = comPercentual(arr(prod, 'valorTotal'), 'valorTotal');
    var vendedores = comPercentual(arr(vend, 'valorTotal'), 'valorTotal');
    vendedores.forEach(function (v) { v.ticketMedio = v.quantidadeVendas ? v.valorTotal / v.quantidadeVendas : 0; });
    var formas = comPercentual(arr(forma, 'valor'), 'valor');
    var topNomes = {};
    produtos.slice(0, 10).forEach(function (p) { topNomes[p.produto ? p.produto.nome : ''] = true; });
    var menos = produtos.slice().reverse().filter(function (p) { return !topNomes[p.produto ? p.produto.nome : '']; });
    return {
      produtos_mais_vendidos: produtos.slice(0, 20),
      produtos_menos_vendidos: menos.slice(0, 20),
      vendedores_ranking: vendedores.slice(0, 20),
      recebimentos_por_forma: formas
    };
  }

  /* ------------------------------------------------------------- loaders */
  function currentParams() {
    return { dataInicio: fmt.apiStart(state.range.inicio), dataFim: fmt.apiEnd(state.range.fim) };
  }
  // Datas em yyyy-MM-dd (endpoints KDS usam esse formato).
  function currentParamsDate() {
    return { dataInicio: fmt.inputDate(state.range.inicio), dataFim: fmt.inputDate(state.range.fim) };
  }

  function multi() { return state.empresas.length > 1; }
  function nomeLoja(e) { return e.fantasia || ('Empresa ' + e.idEmpresa); }

  // Busca a fonte em cada loja selecionada: [{ empresa, data }]. Com varias lojas o erro diz qual falhou.
  function porLoja(fetchFn) {
    var varias = multi();
    return Promise.all(state.empresas.map(function (e) {
      return fetchFn(e.idEmpresa).then(function (data) { return { empresa: e, data: data }; }, function (err) {
        if (varias && err && err.status !== 401) err.message = nomeLoja(e) + ': ' + err.message;
        throw err;
      });
    }));
  }
  // 1 loja: a resposta da API como veio. 2+: consolidada (merge.js).
  function consolidar(fonte, parts) {
    return parts.length === 1 ? parts[0].data : merge[fonte](parts, { produtoPor: state.produtoPor });
  }
  // Loader padrao: busca por loja, consolida e entrega ao render; erro vai para o(s) card(s).
  function carregar(gen, fonte, fetchFn, render, cards) {
    porLoja(fetchFn)
      .then(function (parts) { if (!stale(gen)) render(consolidar(fonte, parts)); })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        cards.forEach(function (c) { if (visible(c.id)) setState(c.card, 'error', e.message); });
      });
  }

  function stale(gen) { return gen !== state.gen; }

  function handleSessionExpired() {
    api.logout(); charts.destroyAll(); cache = {};
    showLogin('Sessão expirada. Entre novamente.');
  }
  function sessionGone() {
    if (!api.isLoggedIn()) { handleSessionExpired(); return true; }
    return false;
  }

  function loadDashboard() {
    if (!state.range || !state.empresas.length) return;
    var gen = (state.gen = (state.gen || 0) + 1);
    charts.destroyAll();
    // limpa os dados renderizados (preserva empresas) — evita stale no export/tema durante o load
    cache = { empresas: cache.empresas };

    if (visible('kpis')) {
      setKpi('kpi-faturamento', '…'); setKpi('kpi-comandas', '…');
      setKpi('kpi-ticket', '…'); setKpi('kpi-cancelado', '…');
      el('kpi-cancelado-sub').textContent = '';
    }
    // marca "carregando" apenas nos cards visiveis
    W.list.forEach(function (w) {
      if (w.id === 'kpis') return;
      if (visible(w.id)) setState(w.cardId, 'loading');
    });

    var need = neededSources();
    if (need.caixa) loadCaixa(gen);
    if (need.cancel) loadCancel(gen);
    if (need.produtoVendedor) loadProdutoVendedor(gen);
    if (need.contaCliente) loadContaCliente(gen);
    if (need.dre) loadDre(gen);
    if (need.contasPagar) loadContasPagar(gen);
    if (need.taxaServico) loadTaxaServico(gen);
    if (need.vendasCanal) loadVendasCanal(gen);
    if (need.tempoEntrega) loadTempoEntrega(gen);
    if (need.sazonalidade) loadSazonalidade(gen);
  }

  // Caixa de UMA loja -> { resumo, rc }. Periodo com 1 unico caixa nao traz ranking_consolidado:
  // monta a partir do detalhe do caixa.
  function caixaDaLoja(p, limiteRanking) {
    return function (idEmpresa) {
      var q = { idEmpresa: idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: true, limiteRanking: limiteRanking };
      return api.caixaRelatorio(q).then(function (data) {
        var resumo = data.resumo_geral || {}, rc = data.ranking_consolidado;
        if (rc || !num(resumo.totalComandas)) return { resumo: resumo, rc: rc || null };
        q.resumido = false;
        return api.caixaRelatorio(q).then(function (full) { return { resumo: resumo, rc: aggregateFromCaixas(full.caixas) }; });
      });
    };
  }

  function loadCaixa(gen) {
    // multiloja: pede a lista inteira de produtos de cada loja; somando so o top 20 de cada uma,
    // o produto que ficou em 21o numa delas sumiria da conta
    porLoja(caixaDaLoja(currentParams(), multi() ? 2000 : undefined))
      .then(function (parts) {
        if (stale(gen)) return;
        var c = parts.length === 1
          ? { resumo_geral: parts[0].data.resumo, ranking_consolidado: parts[0].data.rc }
          : merge.caixa(parts, { produtoPor: state.produtoPor });
        if (visible('kpis')) renderKpiCaixa(c.resumo_geral);
        if (parts.every(function (p) { return !p.data.rc; })) {
          CAIXA_CARDS.forEach(function (card) { if (visible(card.id)) setState(card.card, 'empty'); });
          return;
        }
        renderRanking(c.ranking_consolidado);
      })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        if (visible('kpis')) { setKpi('kpi-faturamento', '—'); setKpi('kpi-comandas', '—'); setKpi('kpi-ticket', '—'); }
        CAIXA_CARDS.forEach(function (c) { if (visible(c.id)) setState(c.card, 'error', e.message); });
      });
  }

  function loadCancel(gen) {
    var p = currentParams();
    porLoja(function (id) { return api.cancelamentos({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: true }); })
      .then(function (parts) {
        if (stale(gen)) return;
        var data = consolidar('cancel', parts);
        var resumo = data.resumo || {};
        cache.cancelKpi = { valor: num(resumo.valorCancelado), itens: resumo.totalCancelamentos || 0 };
        if (visible('kpis')) {
          setKpi('kpi-cancelado', fmt.money(resumo.valorCancelado));
          renderCancelSub();
        }
        if (visible('cancel')) renderCancelVendedores(data.cancelamentosPorVendedor || []);
        if (visible('cancel-produtos')) renderCancelProdutos(data.produtosCancelados || []);
      })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        if (visible('kpis')) setKpi('kpi-cancelado', '—');
        if (visible('cancel')) setState('card-cancel', 'error', e.message);
        if (visible('cancel-produtos')) setState('card-cancel-produtos', 'error', e.message);
      });
  }

  function loadProdutoVendedor(gen) {
    var p = currentParams();
    carregar(gen, 'produtoVendedor',
      function (id) { return api.produtoVendedor({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); },
      function (data) { renderProdutoVendedor(data.vendedores || []); },
      [{ id: 'produto-vendedor', card: 'card-produto-vendedor' }]);
  }

  function loadContaCliente(gen) {
    var p = currentParams();
    carregar(gen, 'contaCliente',
      function (id) { return api.contaCliente({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); },
      function (data) { renderContaCliente(data.saldosPorCliente || []); },
      [{ id: 'conta-cliente', card: 'card-conta-cliente' }]);
  }

  function loadDre(gen) {
    var p = currentParams();
    carregar(gen, 'dre',
      function (id) { return api.dre({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); },
      renderDre, [{ id: 'dre', card: 'card-dre' }]);
  }

  function loadContasPagar(gen) {
    var p = currentParams();
    carregar(gen, 'contasPagar',
      function (id) { return api.contasPagar({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); },
      renderContasPagar, [{ id: 'contas-pagar', card: 'card-contas-pagar' }]);
  }

  function loadTaxaServico(gen) {
    var p = currentParams();
    carregar(gen, 'taxaServico',
      function (id) { return api.taxaServico({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); },
      renderTaxaServico, [{ id: 'taxa-servico', card: 'card-taxa-servico' }]);
  }

  function loadVendasCanal(gen) {
    var p = currentParamsDate();
    carregar(gen, 'vendasCanal',
      function (id) { return api.vendasCanal({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); },
      renderVendasCanal, [{ id: 'vendas-canal', card: 'card-vendas-canal' }]);
  }

  // Mediana e p90 nao se somam entre lojas: o render recebe as partes e compara loja a loja.
  function loadTempoEntrega(gen) {
    var p = currentParams();
    porLoja(function (id) { return api.tempoEntrega({ idEmpresa: id, dataInicio: p.dataInicio, dataFim: p.dataFim }); })
      .then(function (parts) { if (!stale(gen)) renderTempoEntrega(parts); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-tempo-entrega', 'error', e.message); });
  }

  // Sempre os ultimos 90 dias (nao segue o filtro de periodo): so refaz ao trocar as lojas
  // ou quando o card por turno e ligado (porTurno pesa mais no servidor, so vai se precisa).
  function loadSazonalidade(gen) {
    var comTurno = visible('sazonalidade-turno') || visible('producao-7dias');
    var ids = state.empresas.map(function (e) { return e.idEmpresa; }).join(',');
    if (sazCache.parts && sazCache.ids === ids && (sazCache.comTurno || !comTurno)) { renderSazonalidade(sazCache.parts); return; }
    // multiloja: lista maior por loja, para o produto fora do top de uma delas nao ficar sem a parte dela
    porLoja(function (id) { return api.sazonalidadeProdutos({ idEmpresa: id, limite: multi() ? 200 : 40, porTurno: comTurno || undefined }); })
      .then(function (parts) {
        sazCache = { ids: ids, comTurno: comTurno, parts: parts };
        if (stale(gen)) return;
        renderSazonalidade(parts);
      })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        if (visible('sazonalidade')) setState('card-sazonalidade', 'error', e.message);
        if (visible('sazonalidade-turno')) setState('card-sazonalidade-turno', 'error', e.message);
        if (visible('producao-7dias')) setState('card-producao-7dias', 'error', e.message);
      });
  }

  /* ------------------------------------------------------------- render */
  function setKpi(id, value) { var n = el(id); if (n) n.textContent = value; }

  function miniStats(items) {
    return items.map(function (it) {
      var cls = it[2] ? (' ' + it[2]) : '';
      return '<div class="ms"><span class="ms-label">' + escapeHtml(it[0]) + '</span>' +
        '<span class="ms-value' + cls + '">' + it[1] + '</span></div>';
    }).join('');
  }

  function renderKpiCaixa(resumo) {
    setKpi('kpi-faturamento', fmt.money(resumo.totalFaturado));
    setKpi('kpi-comandas', fmt.int(resumo.totalComandas));
    setKpi('kpi-ticket', fmt.money(resumo.ticketMedio));
    cache.totalFaturado = num(resumo.totalFaturado);
    renderCancelSub();
  }

  // % do cancelado sobre o faturamento do periodo (#130568): a API devolvia percentualDoFaturamento
  // dividido pela soma das comandas canceladas, nao pelo faturamento. Calcula aqui com o totalFaturado
  // do caixa; enquanto o caixa nao chegou, mostra so a contagem de itens.
  function renderCancelSub() {
    var c = cache.cancelKpi;
    if (!c || !visible('kpis')) return;
    var itens = fmt.int(c.itens) + ' itens';
    var fat = num(cache.totalFaturado);
    el('kpi-cancelado-sub').textContent = fat > 0
      ? fmt.pct(c.valor / fat * 100) + ' do faturamento • ' + itens
      : itens;
  }

  function renderRanking(rc) {
    cache.rc = rc;
    if (visible('vendedores')) renderVendedores(rc.vendedores_ranking || []);
    if (visible('produtos-top')) renderProdutosTop(rc.produtos_mais_vendidos || []);
    if (visible('produtos-bottom')) renderProdutosBottom(rc.produtos_menos_vendidos || []);
    if (visible('formas')) renderFormas(rc.recebimentos_por_forma || []);
  }

  function renderVendedores(list) {
    cache.vendedores = list;
    if (!charts.ready()) return setState('card-vendedores', 'error', 'Biblioteca de graficos indisponivel.');
    if (!list.length) return setState('card-vendedores', 'empty');
    var top = list.slice(0, 15);
    charts.horizontalBar('chart-vendedores',
      top.map(function (v) { return fmt.truncate(v.vendedor ? v.vendedor.nome : '—', 24); }),
      top.map(function (v) { return Number(v.valorTotal) || 0; }),
      { color: '#1a1fa0', valueFmt: 'money', extra: top.map(function (v) { return fmt.pct(v.percentual || 0); }) });
    setState('card-vendedores', 'ready');
  }

  function renderProdutosTop(list) {
    cache.produtosTop = list;
    if (!charts.ready()) return setState('card-produtos-top', 'error', 'Biblioteca de graficos indisponivel.');
    if (!list.length) return setState('card-produtos-top', 'empty');
    var top = list.slice(0, 10);
    charts.horizontalBar('chart-produtos-top',
      top.map(function (p) { return fmt.truncate(p.produto ? p.produto.nome : '—', 24); }),
      top.map(function (p) { return Number(p.valorTotal) || 0; }),
      { color: '#22c55e', valueFmt: 'money', extra: top.map(function (p) { return fmt.qty(p.quantidade) + ' un'; }) });
    setState('card-produtos-top', 'ready');
  }

  function renderProdutosBottom(list) {
    cache.produtosBottom = list;
    if (!charts.ready()) return setState('card-produtos-bottom', 'error', 'Biblioteca de graficos indisponivel.');
    if (!list.length) return setState('card-produtos-bottom', 'empty');
    var bottom = list.slice(0, 10);
    charts.horizontalBar('chart-produtos-bottom',
      bottom.map(function (p) { return fmt.truncate(p.produto ? p.produto.nome : '—', 24); }),
      bottom.map(function (p) { return Number(p.valorTotal) || 0; }),
      { color: '#f59e0b', valueFmt: 'money', extra: bottom.map(function (p) { return fmt.qty(p.quantidade) + ' un'; }) });
    setState('card-produtos-bottom', 'ready');
  }

  function renderFormas(list) {
    cache.formas = list;
    if (!charts.ready()) return setState('card-formas', 'error', 'Biblioteca de graficos indisponivel.');
    if (!list.length) return setState('card-formas', 'empty');
    charts.doughnut('chart-formas',
      list.map(function (f) { return f.forma ? f.forma.nome : '—'; }),
      list.map(function (f) { return Number(f.valor) || 0; }));
    setState('card-formas', 'ready');
  }

  function renderCancelVendedores(list) {
    cache.cancel = list;
    if (!charts.ready()) return setState('card-cancel', 'error', 'Biblioteca de graficos indisponivel.');
    if (!list.length) return setState('card-cancel', 'empty', 'Nenhum cancelamento no periodo.');
    var top = list.slice(0, 15);
    charts.horizontalBar('chart-cancel',
      top.map(function (v) { return fmt.truncate(v.vendedor || '—', 24); }),
      top.map(function (v) { return Number(v.valorTotal) || 0; }),
      { color: '#ef4444', valueFmt: 'money', extra: top.map(function (v) { return fmt.pct(v.percentual || 0); }) });
    setState('card-cancel', 'ready');
  }

  function renderCancelProdutos(list) {
    cache.cancelProdutos = list;
    var tbody = el('tbl-cancel-produtos');
    if (!tbody) return;
    if (!list || !list.length) { tbody.innerHTML = ''; return setState('card-cancel-produtos', 'empty', 'Nenhum cancelamento no periodo.'); }
    var rows = list.slice().sort(function (a, b) { return num(b.valorTotal) - num(a.valorTotal); }).slice(0, 20);
    tbody.innerHTML = rows.map(function (p) {
      return '<tr>' +
        '<td>' + escapeHtml((p.produto && p.produto.nome) || '—') + '</td>' +
        '<td class="num">' + fmt.qty(p.quantidade) + '</td>' +
        '<td class="num strong">' + fmt.money(p.valorTotal) + '</td>' +
        '<td class="num">' + fmt.pct(num(p.percentual)) + '</td>' +
        '</tr>';
    }).join('');
    setState('card-cancel-produtos', 'ready');
  }

  function renderProdutoVendedor(vendedores) {
    cache.produtoVendedor = vendedores;
    var tbody = el('tbl-produto-vendedor');
    if (!vendedores.length) { tbody.innerHTML = ''; return setState('card-produto-vendedor', 'empty'); }
    var rows = vendedores.map(function (v) {
      var prods = (v.produtos || []).slice().sort(function (a, b) { return (b.valorTotal || 0) - (a.valorTotal || 0); });
      var top = prods[0] || {};
      return {
        garcom: v.vendedorNome || '—',
        produto: top.produtoNome || '—',
        qtd: top.quantidadeTotal || 0,
        valorProduto: top.valorTotal || 0,
        totalGarcom: v.valorTotal || 0
      };
    }).sort(function (a, b) { return b.totalGarcom - a.totalGarcom; });
    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td>' + escapeHtml(r.garcom) + '</td>' +
        '<td><span class="prod-pill">' + escapeHtml(r.produto) + '</span></td>' +
        '<td class="num">' + fmt.qty(r.qtd) + '</td>' +
        '<td class="num">' + fmt.money(r.valorProduto) + '</td>' +
        '<td class="num strong">' + fmt.money(r.totalGarcom) + '</td>' +
        '</tr>';
    }).join('');
    setState('card-produto-vendedor', 'ready');
  }

  function renderContaCliente(saldos) {
    cache.contaCliente = saldos;
    var tbody = el('tbl-conta-cliente');
    if (!saldos.length) { tbody.innerHTML = ''; return setState('card-conta-cliente', 'empty', 'Sem clientes no fiado neste periodo.'); }
    var rows = saldos.slice().sort(function (a, b) { return (b.ticketMedio || 0) - (a.ticketMedio || 0); });
    tbody.innerHTML = rows.map(function (c) {
      return '<tr>' +
        '<td>' + escapeHtml(c.nomeCliente || '—') + '</td>' +
        '<td class="num strong">' + fmt.money(c.ticketMedio) + '</td>' +
        '<td class="num">' + fmt.int(c.totalContas) + '</td>' +
        '<td class="num">' + fmt.money(c.valorTotal) + '</td>' +
        '<td class="num ' + ((c.saldoAberto || 0) > 0 ? 'danger' : '') + '">' + fmt.money(c.saldoAberto) + '</td>' +
        '</tr>';
    }).join('');
    setState('card-conta-cliente', 'ready');
  }

  function renderDre(data) {
    cache.dre = data;
    var r = (data && data.resumo) || {};
    var receita = (r.receitaLiquida != null ? r.receitaLiquida : r.receitaBruta);
    var hasData = r.receitaBruta != null || r.receitaLiquida != null || r.totalDespesas != null;
    el('dre-stats').innerHTML = miniStats([
      ['Receita líquida', fmt.money(receita)],
      ['Despesas', fmt.money(r.totalDespesas)],
      ['Resultado', fmt.money(r.resultadoLiquido), (num(r.resultadoLiquido) >= 0 ? 'pos' : 'neg')],
      ['Margem', fmt.pct(r.margemLiquida != null ? r.margemLiquida : r.margemOperacional)]
    ]);
    if (!charts.ready()) return setState('card-dre', 'error', 'Biblioteca de graficos indisponivel.');
    if (!hasData) { charts.destroy('chart-dre'); return setState('card-dre', 'empty'); }
    charts.horizontalBar('chart-dre',
      ['Receita líquida', 'Despesas', 'Resultado'],
      [num(receita), num(r.totalDespesas), num(r.resultadoLiquido)],
      { multicolor: true, valueFmt: 'money' });
    setState('card-dre', 'ready');
  }

  function renderContasPagar(data) {
    cache.contasPagar = data;
    var r = (data && data.resumo) || {};
    el('contas-pagar-stats').innerHTML = miniStats([
      ['Em aberto', fmt.money(r.totalAberto)],
      ['Pago', fmt.money(r.totalPago)],
      ['Total', fmt.money(r.valorTotal)],
      ['Parcelas vencidas', fmt.int(r.parcelasVencidas)]
    ]);
    var forn = (data && data.porFornecedor) || [];
    if (!charts.ready()) return setState('card-contas-pagar', 'error', 'Biblioteca de graficos indisponivel.');
    if (!forn.length) {
      charts.destroy('chart-contas-pagar');
      if (!r.valorTotal && !r.totalAberto) return setState('card-contas-pagar', 'empty', 'Sem contas a pagar no periodo.');
      return setState('card-contas-pagar', 'ready');
    }
    var top = forn.slice().sort(function (a, b) { return num(b.valorAberto) - num(a.valorAberto); }).slice(0, 10);
    charts.horizontalBar('chart-contas-pagar',
      top.map(function (f) { return fmt.truncate(f.nomeFantasia || '—', 22); }),
      top.map(function (f) { return num(f.valorAberto); }),
      { color: '#f59e0b', valueFmt: 'money', extra: top.map(function (f) { return fmt.money(f.valorTotal) + ' total'; }) });
    setState('card-contas-pagar', 'ready');
  }

  function renderTaxaServico(data) {
    cache.taxaServico = data;
    var r = (data && data.resumo) || {};
    el('taxa-servico-stats').innerHTML = miniStats([
      ['Total taxa', fmt.money(r.total_taxa_servico)],
      ['Ticket médio', fmt.money(r.ticket_medio_taxa)],
      ['% médio', fmt.pct(r.percentual_medio)]
    ]);
    var func = (data && data.por_funcionario) || [];
    if (!charts.ready()) return setState('card-taxa-servico', 'error', 'Biblioteca de graficos indisponivel.');
    if (!func.length) { charts.destroy('chart-taxa-servico'); return setState('card-taxa-servico', 'empty', 'Sem taxa de servico no periodo.'); }
    var top = func.slice(0, 15);
    charts.horizontalBar('chart-taxa-servico',
      top.map(function (f) { return fmt.truncate((f.funcionario && f.funcionario.nome) || '—', 22); }),
      top.map(function (f) { return num(f.total_taxa_servico); }),
      { color: '#1a1fa0', valueFmt: 'money', extra: top.map(function (f) { return fmt.pct(num(f.percentual_do_total)); }) });
    setState('card-taxa-servico', 'ready');
  }

  function renderVendasCanal(data) {
    cache.vendasCanal = data;
    var tg = (data && data.totaisGerais) || {};
    el('vendas-canal-stats').innerHTML = miniStats([
      ['Faturamento', fmt.money(tg.valor)],
      ['Pedidos', fmt.int(tg.quantidade)],
      ['Ticket médio', fmt.money(tg.ticketMedio)]
    ]);
    var g = (data && data.graficosFaturamentoPorCanal) || [];
    if (!charts.ready()) return setState('card-vendas-canal', 'error', 'Biblioteca de graficos indisponivel.');
    if (!g.length) { charts.destroy('chart-vendas-canal'); return setState('card-vendas-canal', 'empty', 'Sem vendas por canal no periodo.'); }
    charts.doughnut('chart-vendas-canal',
      g.map(function (c) { return c.canal || '—'; }),
      g.map(function (c) { return num(c.valor); }));
    setState('card-vendas-canal', 'ready');
  }

  /* ------------------------------------------- tempo de entrega (delivery) */
  function min(v) { return v == null ? '—' : fmt.int(v) + ' min'; }
  function med(bloco, chave) { return bloco && bloco[chave] ? bloco[chave].medianaMin : null; }
  function p90(bloco, chave) { return bloco && bloco[chave] ? bloco[chave].p90Min : null; }

  // Linha "rotulo | pedidos | preparo | espera | rota | total | prazo seguro" (dia da semana ou loja).
  function tempoLinha(rotulo, b) {
    return '<tr><td class="strong">' + escapeHtml(rotulo) + '</td>' +
      '<td class="num">' + fmt.int(b.pedidos) + '</td>' +
      '<td class="num">' + min(med(b, 'preparo')) + '</td>' +
      '<td class="num">' + min(med(b, 'esperaDespacho')) + '</td>' +
      '<td class="num">' + min(med(b, 'rota')) + '</td>' +
      '<td class="num strong">' + min(med(b, 'total')) + '</td>' +
      '<td class="num">' + min(p90(b, 'total')) + '</td></tr>';
  }

  function renderTempoEntrega(parts) {
    cache.tempoEntrega = parts;
    if (parts.length > 1) return renderTempoEntregaLojas(parts);
    var data = parts[0].data;
    var r = data && data.resumo;
    if (!r) return setState('card-tempo-entrega', 'empty', 'Sem pedidos de delivery no periodo.');
    el('tempo-entrega-stats').innerHTML = miniStats([
      ['Pedidos', fmt.int(r.pedidos)],
      ['Preparo', min(med(r, 'preparo'))],
      ['Espera p/ sair', min(med(r, 'esperaDespacho'))],
      ['Rota', min(med(r, 'rota'))],
      ['Total', min(med(r, 'total'))],
      ['Prazo seguro', min(p90(r, 'total'))],
      ['Prazo seg–qui', min(p90(data.segundaAQuinta, 'total'))],
      ['Prazo sex–dom', min(p90(data.sextaADomingo, 'total')), 'neg']
    ]);
    el('tempo-dia-col').textContent = 'Dia';
    el('tbl-tempo-dia').innerHTML = (data.porDiaSemana || []).map(function (d) { return tempoLinha(d.diaSemana, d); }).join('');

    var faixas = data.porDistancia || [];
    var porRaio = faixas.length > 0;
    var linhas = porRaio ? faixas : (data.porBairro || []);
    el('tempo-raio-head').innerHTML = '<tr><th>' + (porRaio ? 'Raio' : 'Bairro') + '</th><th class="num">Pedidos</th>' +
      '<th class="num">Rota</th><th class="num">Total</th>' +
      (porRaio ? '<th class="num">Prazo seg–qui</th><th class="num">Prazo sex–dom</th>' : '<th class="num">Prazo seguro</th>') + '</tr>';
    el('tbl-tempo-raio').innerHTML = linhas.map(function (f) {
      return '<tr><td class="strong">' + escapeHtml(porRaio ? f.faixaKm : f.bairro) + '</td>' +
        '<td class="num">' + fmt.int(f.pedidos) + '</td>' +
        '<td class="num">' + min(med(f, 'rota')) + '</td>' +
        '<td class="num strong">' + min(med(f, 'total')) + '</td>' +
        (porRaio
          ? '<td class="num">' + min(p90(f.segundaAQuinta, 'total')) + '</td><td class="num">' + min(p90(f.sextaADomingo, 'total')) + '</td>'
          : '<td class="num">' + min(p90(f, 'total')) + '</td>') + '</tr>';
    }).join('');
    var comRota = r.rota ? num(r.rota.pedidos) : 0;
    el('tempo-entrega-nota').textContent =
      (porRaio ? 'Raio em linha reta da loja ao cliente (o trajeto real é maior). '
        : 'Sem latitude/longitude da loja no cadastro da empresa: mostrando os bairros com mais pedidos no lugar do raio. ') +
      'Rota e total consideram os ' + fmt.int(comRota) + ' pedidos com horário de saída e de entrega registrados' +
      (num(r.pedidosComHorarioDoParceiro) ? ' (' + fmt.int(r.pedidosComHorarioDoParceiro) + ' com o horário do entregador parceiro).' : '.');
    setState('card-tempo-entrega', 'ready');
  }

  // Multiloja: uma linha por loja (comparativo), no lugar de dia da semana e raio.
  function renderTempoEntregaLojas(parts) {
    var lojas = parts.filter(function (p) { return p.data && p.data.resumo; });
    if (!lojas.length) return setState('card-tempo-entrega', 'empty', 'Sem pedidos de delivery no periodo.');
    el('tempo-entrega-stats').innerHTML = miniStats([
      ['Pedidos', fmt.int(lojas.reduce(function (s, p) { return s + num(p.data.resumo.pedidos); }, 0))],
      ['Lojas com delivery', fmt.int(lojas.length)]
    ]);
    el('tempo-dia-col').textContent = 'Loja';
    el('tbl-tempo-dia').innerHTML = lojas.map(function (p) { return tempoLinha(nomeLoja(p.empresa), p.data.resumo); }).join('');
    el('tempo-raio-head').innerHTML = '<tr><th>Loja</th><th class="num">Prazo seguro</th>' +
      '<th class="num">Prazo seg–qui</th><th class="num">Prazo sex–dom</th></tr>';
    el('tbl-tempo-raio').innerHTML = lojas.map(function (p) {
      return '<tr><td class="strong">' + escapeHtml(nomeLoja(p.empresa)) + '</td>' +
        '<td class="num strong">' + min(p90(p.data.resumo, 'total')) + '</td>' +
        '<td class="num">' + min(p90(p.data.segundaAQuinta, 'total')) + '</td>' +
        '<td class="num">' + min(p90(p.data.sextaADomingo, 'total')) + '</td></tr>';
    }).join('');
    el('tempo-entrega-nota').textContent = 'Tempo normal (mediana) e prazo seguro não se somam entre lojas: cada linha é uma loja. ' +
      'Para ver por dia da semana e por raio, selecione uma loja só.';
    setState('card-tempo-entrega', 'ready');
  }

  /* ---------------------------------------- programacao da producao (90 d) */
  var SAZ_DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
  var SAZ_HEAD = '<tr><th>Semana do mês</th><th class="num">Seg</th><th class="num">Ter</th><th class="num">Qua</th>' +
    '<th class="num">Qui</th><th class="num">Sex</th><th class="num">Sáb</th><th class="num">Dom</th><th class="num">Média/dia</th></tr>';

  function sazGrupos(data) { return (data && (data.produtos || data.categorias)) || []; }
  function sazNome(g) { return g.produto || g.categoria || '—'; }

  function sazPreencher(selId, data) {
    var sel = el(selId);
    var atual = sel.value;
    sel.innerHTML = '<option value="">Pedidos (todos os produtos)</option>' + sazGrupos(data).map(function (g, i) {
      return '<option value="' + i + '">' + escapeHtml(fmt.truncate(sazNome(g), 42)) + '</option>';
    }).join('');
    if (atual && sel.querySelector('option[value="' + atual + '"]')) sel.value = atual;
  }

  // Bloco escolhido no combo: '' = pedidos (todos os produtos); senao o indice do produto.
  function sazSelecionado(selId, data) {
    var v = el(selId).value;
    var g = v === '' ? null : sazGrupos(data)[Number(v)];
    return g ? { nome: sazNome(g), bloco: g, unidade: 'un' } : { nome: 'Pedidos', bloco: data.pedidos || {}, unidade: 'pedidos' };
  }

  // Linhas do mapa de calor. Cor relativa ao menor e ao maior valor da propria grade:
  // destaca os picos mesmo com valores proximos.
  function sazLinhas(grade, amostra) {
    var vals = [];
    grade.forEach(function (l) { SAZ_DIAS.forEach(function (d) { if (l[d] != null) vals.push(num(l[d])); }); });
    var lo = Math.min.apply(null, vals.concat(Infinity)), hi = Math.max.apply(null, vals.concat(0));
    return grade.map(function (l, i) {
      var dias = amostra[i] || {};
      if (!num(dias.dias)) return '';
      return '<tr><td class="strong">' + l.semanaDoMes + 'ª semana <span class="faint">(dias ' + escapeHtml(l.diasDoMes) + ')</span></td>' +
        SAZ_DIAS.map(function (d) {
          if (l[d] == null) return '<td class="num faint">—</td>';
          return '<td class="num heat" style="--heat:' + (hi > lo ? ((num(l[d]) - lo) / (hi - lo)).toFixed(2) : 0) + '" title="média de ' +
            num(dias[d]) + ' dia(s)">' + fmt.qty(l[d]) + '</td>';
        }).join('') +
        '<td class="num strong">' + fmt.qty(l.mediaPorDia) + '</td></tr>';
    }).join('');
  }
  function sazMaxDias(amostra) {
    return Math.max.apply(null, (amostra || []).map(function (a) {
      return Math.max.apply(null, SAZ_DIAS.map(function (d) { return num(a[d]); }));
    }).concat(0));
  }
  function sazNotaLojas() { return multi() ? 'Lojas somadas: cada célula é a soma da média de cada loja. ' : ''; }

  // parts = resposta de cada loja; consolida aqui para a troca nome/codigo nao exigir nova busca.
  function renderSazonalidade(parts) {
    var data = consolidar('sazonalidade', parts);
    if (parts.length > 1) ['produtos', 'categorias'].forEach(function (k) { if (data[k]) data[k] = data[k].slice(0, 40); });
    cache.sazonalidade = data;
    var vazio = !data || !num(data.diasComVenda);
    if (visible('sazonalidade')) {
      if (vazio) setState('card-sazonalidade', 'empty', 'Sem vendas nos ultimos 90 dias.');
      else { sazPreencher('saz-select', data); renderSazonalidadeGrade(); setState('card-sazonalidade', 'ready'); }
    }
    if (visible('sazonalidade-turno')) {
      if (vazio) setState('card-sazonalidade-turno', 'empty', 'Sem vendas nos ultimos 90 dias.');
      else if (!(data.turnos && data.turnos.length)) {
        setState('card-sazonalidade-turno', 'empty', 'A API ainda não separa por turno: disponível após a próxima atualização do LAD BI.');
      } else { sazPreencher('saz-turno-select', data); renderSazonalidadeTurnos(); setState('card-sazonalidade-turno', 'ready'); }
    }
    if (visible('producao-7dias')) {
      if (vazio) setState('card-producao-7dias', 'empty', 'Sem vendas nos ultimos 90 dias.');
      else { prod7PreencherTurnos(data); renderProducao7(); setState('card-producao-7dias', 'ready'); }
    }
  }

  function renderSazonalidadeGrade() {
    var data = cache.sazonalidade;
    if (!data) return;
    var s = sazSelecionado('saz-select', data);
    var amostra = data.diasNaAmostra || [];
    el('tbl-sazonalidade').innerHTML = sazLinhas(s.bloco.grade || [], amostra);
    el('saz-nota').textContent = s.nome + ': média de ' + s.unidade + ' por dia, todos os canais somados. ' + sazNotaLojas() +
      '1ª semana = dias 1 a 7 do mês (a 1ª segunda, a 1ª terça...). Cada célula é a média de até ' +
      sazMaxDias(amostra) + ' dias (passe o mouse para ver quantos).';
  }

  // Uma grade por turno (os mesmos turnos do dashboard KDS), para o produto escolhido.
  function renderSazonalidadeTurnos() {
    var data = cache.sazonalidade;
    if (!data || !data.turnos) return;
    var s = sazSelecionado('saz-turno-select', data);
    var porChave = {};
    (s.bloco.porTurno || []).forEach(function (t) { porChave[t.chave] = t; });
    el('saz-turno-tabelas').innerHTML = data.turnos.map(function (t) {
      var b = porChave[t.chave] || {};
      return '<div class="table-body"><h4 class="turno-title">' + escapeHtml(t.label) +
        ' <span class="faint">· ' + (b.mediaPorDia == null ? 'sem venda' : 'média de ' + fmt.qty(b.mediaPorDia) + ' ' + s.unidade + ' por dia') + '</span></h4>' +
        '<table class="data-table heat-table"><thead>' + SAZ_HEAD + '</thead><tbody>' +
        sazLinhas(b.grade || [], t.diasNaAmostra || []) + '</tbody></table></div>';
    }).join('');
    el('saz-turno-nota').textContent = s.nome + ': média de ' + s.unidade + ' por dia em cada turno, todos os canais somados. ' + sazNotaLojas() +
      'A venda depois da meia-noite conta no dia em que o turno começou. A cor compara os dias dentro do mesmo turno. ' +
      'Cada célula é a média de até ' + Math.max.apply(null, data.turnos.map(function (t) { return sazMaxDias(t.diasNaAmostra); }).concat(0)) +
      ' dias (passe o mouse para ver quantos).';
  }

  /* ------------------------------------------- producao dos proximos 7 dias */
  var PROD7_FOLGA = 0.15, PROD7_ITENS = 10;
  var PROD7_DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  // Os 7 dias a partir de amanha, cada um com a celula da grade (semana do mes x dia) que o representa.
  function prod7Dias() {
    var hoje = new Date(), out = [];
    for (var i = 1; i <= 7; i++) {
      var d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + i);
      out.push({
        rotulo: PROD7_DIAS[d.getDay()] + ' ' + ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2),
        semana: Math.floor((d.getDate() - 1) / 7),
        dia: SAZ_DIAS[(d.getDay() + 6) % 7]
      });
    }
    return out;
  }
  // media + folga, para cima (o epsilon evita 69,0000001 virar 70)
  function prod7Sugestao(media) { return Math.ceil(media * (1 + PROD7_FOLGA) - 1e-9) || 0; }

  function prod7PreencherTurnos(data) {
    var sel = el('prod7-turno'), atual = sel.value, turnos = data.turnos || [];
    sel.innerHTML = '<option value="">Dia inteiro</option>' + turnos.map(function (t) {
      return '<option value="' + escapeHtml(t.chave) + '">' + escapeHtml(t.label) + '</option>';
    }).join('');
    sel.hidden = !turnos.length;
    if (turnos.some(function (t) { return t.chave === atual; })) sel.value = atual;
  }

  // Linhas da tabela: pedidos (so a media) + os itens mais vendidos; celulas = media de cada dia ou null.
  function prod7Modelo(data) {
    var chave = el('prod7-turno').value, dias = prod7Dias();
    function celulas(b) {
      if (chave) b = (b.porTurno || []).filter(function (t) { return t.chave === chave; })[0] || {};
      return dias.map(function (d) { var l = (b.grade || [])[d.semana]; return l && l[d.dia] != null ? num(l[d.dia]) : null; });
    }
    return {
      dias: dias,
      linhas: [{ nome: 'Pedidos esperados (todos)', pedidos: true, celulas: celulas(data.pedidos || {}) }]
        .concat(sazGrupos(data).slice(0, PROD7_ITENS).map(function (g) {
          return { nome: sazNome(g), categoria: g.produto ? g.categoria : '', celulas: celulas(g) };
        }))
    };
  }

  function renderProducao7() {
    var data = cache.sazonalidade;
    if (!data) return;
    var m = prod7Modelo(data);
    el('prod7-head').innerHTML = '<tr><th>Item</th>' + m.dias.map(function (d) {
      return '<th class="num">' + d.rotulo + '<br><span class="faint">' + (d.semana + 1) + 'ª semana</span></th>';
    }).join('') + '</tr>';
    el('tbl-prod7').innerHTML = m.linhas.map(function (l) {
      return '<tr' + (l.pedidos ? ' class="prod7-total"' : '') + '><td class="strong">' + escapeHtml(l.nome) +
        (l.categoria ? ' <span class="faint">' + escapeHtml(l.categoria) + '</span>' : '') + '</td>' +
        l.celulas.map(function (v) {
          if (v == null) return '<td class="num faint">sem histórico</td>';
          if (l.pedidos) return '<td class="num strong">' + fmt.qty(v) + '</td>';
          return '<td class="num"><span class="faint">média ' + fmt.qty(v) + '</span>' +
            '<strong class="prod7-n">' + fmt.int(prod7Sugestao(v)) + '</strong></td>';
        }).join('') + '</tr>';
    }).join('');
    el('prod7-nota').textContent = 'Em cada casa: a média do histórico e, em destaque, quanto produzir (média + ' +
      Math.round(PROD7_FOLGA * 100) + '%). ' + sazNotaLojas() +
      'É uma sugestão: cada média vem de poucos dias parecidos; "sem histórico" = não houve venda num dia assim nos últimos 90 dias.';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Re-render (sem refetch) do que estiver em cache e visivel — usado ao trocar tema.
  function rerenderAll() {
    if (cache.rc) renderRanking(cache.rc);
    if (cache.cancel && visible('cancel')) renderCancelVendedores(cache.cancel);
    if (cache.cancelProdutos && visible('cancel-produtos')) renderCancelProdutos(cache.cancelProdutos);
    if (cache.produtoVendedor && visible('produto-vendedor')) renderProdutoVendedor(cache.produtoVendedor);
    if (cache.dre && visible('dre')) renderDre(cache.dre);
    if (cache.contasPagar && visible('contas-pagar')) renderContasPagar(cache.contasPagar);
    if (cache.taxaServico && visible('taxa-servico')) renderTaxaServico(cache.taxaServico);
    if (cache.vendasCanal && visible('vendas-canal')) renderVendasCanal(cache.vendasCanal);
  }

  /* ------------------------------------------------------------- painel de config */
  function openConfig() {
    if (!state.config) setConfig(W.defaultConfig());
    buildConfigList(state.config);
    el('config-sub').textContent = 'Escolha quais indicadores aparecem e em que ordem. A configuração vale para toda a empresa.' +
      (multi() ? ' Com várias lojas marcadas, vale (e é salva) a de ' + nomeLoja(state.empresas[0]) + '.' : '');
    el('config-status').textContent = '';
    el('config-save').disabled = false;
    el('config-modal').hidden = false;
  }
  function closeConfig() { el('config-modal').hidden = true; }

  function buildConfigList(c) {
    var ul = el('config-list');
    ul.innerHTML = '';
    c.widgets.forEach(function (w) {
      var meta = W.get(w.id);
      if (!meta) return;
      var li = document.createElement('li');
      li.className = 'cfg-row';
      li.setAttribute('data-id', w.id);
      li.innerHTML =
        '<span class="cfg-move">' +
          '<button type="button" class="cfg-up" title="Subir" aria-label="Subir">▲</button>' +
          '<button type="button" class="cfg-down" title="Descer" aria-label="Descer">▼</button>' +
        '</span>' +
        '<label class="switch"><input type="checkbox"' + (w.visible ? ' checked' : '') +
          ' aria-label="' + escapeHtml(meta.titulo) + '" /><span class="slider"></span></label>' +
        '<span class="cfg-title">' + escapeHtml(meta.titulo) + '</span>' +
        '<span class="cfg-cat">' + escapeHtml(meta.categoria) + '</span>';
      ul.appendChild(li);
    });
    refreshMoveButtons();
  }

  function refreshMoveButtons() {
    var rows = el('config-list').querySelectorAll('.cfg-row');
    rows.forEach(function (r, i) {
      var up = r.querySelector('.cfg-up'), dn = r.querySelector('.cfg-down');
      if (up) up.disabled = (i === 0);
      if (dn) dn.disabled = (i === rows.length - 1);
    });
  }

  function onConfigListClick(ev) {
    var t = ev.target;
    var btn = t && t.closest ? t.closest('.cfg-up, .cfg-down') : null;
    if (!btn) return;
    var row = btn.closest('.cfg-row');
    if (!row) return;
    if (btn.classList.contains('cfg-up') && row.previousElementSibling) {
      row.parentNode.insertBefore(row, row.previousElementSibling);
    } else if (btn.classList.contains('cfg-down') && row.nextElementSibling) {
      row.parentNode.insertBefore(row.nextElementSibling, row);
    }
    refreshMoveButtons();
  }

  function readConfigFromList() {
    var rows = el('config-list').querySelectorAll('.cfg-row');
    var widgets = [];
    rows.forEach(function (r) {
      var cb = r.querySelector('input[type=checkbox]');
      widgets.push({ id: r.getAttribute('data-id'), visible: !!(cb && cb.checked) });
    });
    return { version: 1, widgets: widgets };
  }

  function saveConfig() {
    var c = readConfigFromList();
    var idEmpresa = api.getEmpresaId();
    var btn = el('config-save');
    btn.disabled = true;
    el('config-status').textContent = 'Salvando…';
    // aplica local + cache imediatamente (UX responsiva); servidor e best-effort
    saveConfigCache(idEmpresa, c);
    setConfig(c);
    loadDashboard();
    api.dashboardConfigSave(idEmpresa, c).then(function () {
      el('config-status').textContent = 'Salvo ✓';
      setTimeout(closeConfig, 500);
    }).catch(function (e) {
      el('config-status').textContent = 'Salvo neste navegador. Servidor: ' + (e.message || 'falhou');
    }).finally(function () {
      btn.disabled = false;
    });
  }

  /* ------------------------------------------------- exportar (Excel, PDF, CSV) */
  function col(h, t) { return { h: h, t: t || 'text' }; }
  function colsProduto() {
    return [col('Produto'), col('Código'), col('Categoria'), col('Qtd', 'qty'), col('Valor', 'money'), col('% do faturamento', 'pct')];
  }
  function linhasProduto(lista) {
    return lista.map(function (p) {
      var pr = p.produto || {};
      return [pr.nome || '', pr.codigo == null ? '' : String(pr.codigo), pr.categoria || '', num(p.quantidade), num(p.valorTotal), num(p.percentual)];
    });
  }
  var SAZ_COLS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(function (d) { return col(d, 'qty'); }).concat([col('Média por dia', 'qty')]);
  function sazLinhaExport(l) { return SAZ_DIAS.map(function (d) { return l[d]; }).concat([l.mediaPorDia]); }
  function sazBlocos(sz) {
    return [{ nome: 'Pedidos (todos os produtos)', bloco: sz.pedidos || {} }]
      .concat(sazGrupos(sz).map(function (g) { return { nome: sazNome(g), bloco: g }; }));
  }

  // Dados de cada card em valores crus: { arquivo, titulo, colunas, linhas, semPeriodo? }.
  function exportDef(which) {
    switch (which) {
      case 'vendedores': return cache.vendedores && {
        arquivo: 'garcons_vendas', titulo: 'Quanto cada garçom vende',
        colunas: [col('Garçom'), col('Vendas', 'int'), col('Valor total', 'money'), col('% do total', 'pct'), col('Ticket médio', 'money')],
        linhas: cache.vendedores.map(function (v) {
          return [v.vendedor ? v.vendedor.nome : '', num(v.quantidadeVendas), num(v.valorTotal), num(v.percentual), num(v.ticketMedio)];
        })
      };
      case 'formas': return cache.formas && {
        arquivo: 'formas_pagamento', titulo: 'Formas de pagamento',
        colunas: [col('Forma'), col('Qtd', 'int'), col('Valor', 'money'), col('% do faturamento', 'pct')],
        linhas: cache.formas.map(function (f) { return [f.forma ? f.forma.nome : '', num(f.quantidade), num(f.valor), num(f.percentual)]; })
      };
      case 'produtos-top': return cache.produtosTop && {
        arquivo: 'produtos_mais_vendidos', titulo: 'Produtos mais vendidos', colunas: colsProduto(), linhas: linhasProduto(cache.produtosTop)
      };
      case 'produtos-bottom': return cache.produtosBottom && {
        arquivo: 'produtos_menos_vendidos', titulo: 'Produtos menos vendidos', colunas: colsProduto(), linhas: linhasProduto(cache.produtosBottom)
      };
      case 'cancel': return cache.cancel && {
        arquivo: 'garcons_cancelamentos', titulo: 'Garçom que mais cancela',
        colunas: [col('Garçom'), col('Itens cancelados', 'int'), col('Quantidade', 'qty'), col('Valor cancelado', 'money'), col('% do total', 'pct')],
        linhas: cache.cancel.map(function (v) { return [v.vendedor || '', num(v.totalCancelamentos), num(v.quantidade), num(v.valorTotal), num(v.percentual)]; })
      };
      case 'cancel-produtos': return cache.cancelProdutos && {
        arquivo: 'produtos_cancelados', titulo: 'Produtos e motivos mais cancelados',
        colunas: [col('Produto'), col('Qtd', 'qty'), col('Valor', 'money'), col('% do total', 'pct')],
        linhas: cache.cancelProdutos.slice().sort(function (a, b) { return num(b.valorTotal) - num(a.valorTotal); }).map(function (p) {
          return [(p.produto && p.produto.nome) || '', num(p.quantidade), num(p.valorTotal), num(p.percentual)];
        })
      };
      case 'produto-vendedor': return cache.produtoVendedor && {
        arquivo: 'produto_por_garcom', titulo: 'O produto que cada garçom mais vende',
        colunas: [col('Garçom'), col('Produto mais vendido'), col('Qtd', 'qty'), col('Valor do produto', 'money'), col('Total do garçom', 'money')],
        linhas: cache.produtoVendedor.map(function (v) {
          var prods = (v.produtos || []).slice().sort(function (a, b) { return (b.valorTotal || 0) - (a.valorTotal || 0); });
          var t = prods[0] || {};
          return [v.vendedorNome || '', t.produtoNome || '', num(t.quantidadeTotal), num(t.valorTotal), num(v.valorTotal)];
        })
      };
      case 'conta-cliente': return cache.contaCliente && {
        arquivo: 'ticket_medio_cliente', titulo: 'Ticket médio por cliente',
        colunas: [col('Cliente'), col('Ticket médio', 'money'), col('Nº contas', 'int'), col('Valor total', 'money'), col('Saldo em aberto', 'money')],
        linhas: cache.contaCliente.map(function (c) { return [c.nomeCliente || '', num(c.ticketMedio), num(c.totalContas), num(c.valorTotal), num(c.saldoAberto)]; })
      };
      case 'dre': {
        var dr = cache.dre && cache.dre.resumo;
        return dr && {
          arquivo: 'dre', titulo: 'DRE / Resultado do período',
          colunas: [col('Receita bruta', 'money'), col('Receita líquida', 'money'), col('Despesas', 'money'),
            col('Resultado líquido', 'money'), col('Margem', 'pct')],
          linhas: [[dr.receitaBruta, dr.receitaLiquida, dr.totalDespesas, dr.resultadoLiquido,
            dr.margemLiquida != null ? dr.margemLiquida : dr.margemOperacional]]
        };
      }
      case 'contas-pagar': return cache.contasPagar && {
        arquivo: 'contas_a_pagar', titulo: 'Contas a pagar por fornecedor',
        colunas: [col('Fornecedor'), col('Em aberto', 'money'), col('Total', 'money')],
        linhas: (cache.contasPagar.porFornecedor || []).map(function (f) { return [f.nomeFantasia || '', num(f.valorAberto), num(f.valorTotal)]; })
      };
      case 'taxa-servico': return cache.taxaServico && {
        arquivo: 'taxa_servico', titulo: 'Taxa de serviço por garçom',
        colunas: [col('Garçom'), col('Taxa de serviço', 'money'), col('Comandas', 'int'), col('% do total', 'pct')],
        linhas: (cache.taxaServico.por_funcionario || []).map(function (f) {
          return [(f.funcionario && f.funcionario.nome) || '', num(f.total_taxa_servico), num(f.total_comandas), num(f.percentual_do_total)];
        })
      };
      case 'vendas-canal': return cache.vendasCanal && {
        arquivo: 'vendas_por_canal', titulo: 'Vendas por canal',
        colunas: [col('Canal'), col('Faturamento', 'money')],
        linhas: (cache.vendasCanal.graficosFaturamentoPorCanal || []).map(function (c) { return [c.canal || '', num(c.valor)]; })
      };
      case 'tempo-entrega': {
        if (!cache.tempoEntrega) return null;
        var partes = cache.tempoEntrega, cortes;
        if (partes.length > 1) {
          cortes = [];
          partes.forEach(function (p) {
            if (!p.data || !p.data.resumo) return;
            cortes.push(['Loja', nomeLoja(p.empresa), p.data.resumo],
              ['Loja seg–qui', nomeLoja(p.empresa), p.data.segundaAQuinta || {}],
              ['Loja sex–dom', nomeLoja(p.empresa), p.data.sextaADomingo || {}]);
          });
        } else {
          var te = partes[0].data || {};
          cortes = (te.porDiaSemana || []).map(function (d) { return ['Dia', d.diaSemana, d]; })
            .concat((te.porDistancia || []).map(function (f) { return ['Raio', f.faixaKm, f]; }))
            .concat((te.porBairro || []).map(function (b) { return ['Bairro', b.bairro, b]; }));
        }
        return {
          arquivo: 'tempo_entrega', titulo: 'Tempo de preparo e entrega (delivery)',
          colunas: [col('Corte'), col('Faixa'), col('Pedidos', 'int'), col('Preparo (mediana)', 'min'), col('Espera (mediana)', 'min'),
            col('Rota (mediana)', 'min'), col('Total (mediana)', 'min'), col('Prazo seguro (p90)', 'min')],
          linhas: cortes.map(function (l) {
            var b = l[2];
            return [l[0], l[1], num(b.pedidos), med(b, 'preparo'), med(b, 'esperaDespacho'), med(b, 'rota'), med(b, 'total'), p90(b, 'total')];
          })
        };
      }
      case 'sazonalidade': {
        if (!cache.sazonalidade) return null;
        var linhasSaz = [];
        sazBlocos(cache.sazonalidade).forEach(function (b) {
          (b.bloco.grade || []).forEach(function (l) { linhasSaz.push([b.nome, l.semanaDoMes, l.diasDoMes].concat(sazLinhaExport(l))); });
        });
        return {
          arquivo: 'producao_semana_do_mes_x_dia', titulo: 'Programação da produção', semPeriodo: true,
          colunas: [col('Produto'), col('Semana do mês', 'int'), col('Dias do mês')].concat(SAZ_COLS), linhas: linhasSaz
        };
      }
      case 'producao-7dias': {
        if (!cache.sazonalidade) return null;
        var m7 = prod7Modelo(cache.sazonalidade);
        var cols7 = [col('Item'), col('Categoria')];
        m7.dias.forEach(function (d) { cols7.push(col(d.rotulo + ' média', 'qty'), col(d.rotulo + ' produzir', 'int')); });
        return {
          arquivo: 'producao_proximos_7_dias', titulo: 'Produção dos próximos 7 dias', semPeriodo: true, colunas: cols7,
          linhas: m7.linhas.map(function (l) {
            var linha = [l.nome, l.categoria || ''];
            l.celulas.forEach(function (v) { linha.push(v, v == null || l.pedidos ? null : prod7Sugestao(v)); });
            return linha;
          })
        };
      }
      case 'sazonalidade-turno': {
        if (!cache.sazonalidade || !cache.sazonalidade.turnos) return null;
        var linhasTurno = [];
        sazBlocos(cache.sazonalidade).forEach(function (b) {
          (b.bloco.porTurno || []).forEach(function (t) {
            (t.grade || []).forEach(function (l) { linhasTurno.push([b.nome, t.label, l.semanaDoMes, l.diasDoMes].concat(sazLinhaExport(l))); });
          });
        });
        return {
          arquivo: 'producao_por_turno', titulo: 'Programação da produção por horário', semPeriodo: true,
          colunas: [col('Produto'), col('Turno'), col('Semana do mês', 'int'), col('Dias do mês')].concat(SAZ_COLS), linhas: linhasTurno
        };
      }
    }
    return null;
  }

  function exportar(which, formato) {
    var def = exportDef(which);
    if (!def || !def.linhas.length) return;
    var nome = def.arquivo + (def.semPeriodo ? ' (90 dias)'
      : ' (' + fmt.inputDate(state.range.inicio) + '_a_' + fmt.inputDate(state.range.fim) + ')');
    def.subtitulo = (multi() ? 'Lojas: ' : 'Loja: ') + state.empresas.map(nomeLoja).join(' + ') + ' · ' +
      (def.semPeriodo ? 'últimos 90 dias' : 'Período: ' + fmt.dateBR(state.range.inicio) + ' a ' + fmt.dateBR(state.range.fim));
    if (formato === 'csv') fmt.downloadCSV(nome + '.csv', def.colunas.map(function (c) { return c.h; }), def.linhas);
    else if (formato === 'xlsx') exporter.xlsx(nome + '.xlsx', def);
    else exporter.pdf(def);
  }

  function buildExportMenus() {
    document.querySelectorAll('details.export-menu').forEach(function (d) {
      d.innerHTML = '<summary class="btn-ghost sm">Exportar</summary><div class="export-pop">' +
        '<button type="button" data-fmt="xlsx">Excel</button>' +
        '<button type="button" data-fmt="pdf">PDF</button>' +
        '<button type="button" data-fmt="csv">CSV</button></div>';
    });
  }

  /* ------------------------------------------------------------- tema */
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(cfg.prefsKey)) || {}; } catch (e) { return {}; } }
  function savePrefs(p) { localStorage.setItem(cfg.prefsKey, JSON.stringify(p)); }

  function applyTheme(theme) {
    document.body.classList.toggle('dark', theme === 'dark');
    var btn = el('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
    charts.applyDefaults();
  }
  function toggleTheme() {
    var p = loadPrefs();
    p.theme = (document.body.classList.contains('dark')) ? 'light' : 'dark';
    savePrefs(p);
    applyTheme(p.theme);
    rerenderAll();
  }

  /* ------------------------------------------------------- lojas (multiloja) */
  function populateEmpresas(lista) {
    var ids = lista.map(function (e) { return e.idEmpresa; });
    var prefs = loadPrefs();
    var sel = (prefs.empresasSel || []).filter(function (id) { return ids.indexOf(id) >= 0; });
    if (!sel.length) {
      var saved = api.getEmpresaId();
      sel = [(saved && ids.indexOf(saved) >= 0) ? saved : (ids.indexOf(cfg.empresaPadrao) >= 0 ? cfg.empresaPadrao : ids[0])];
    }
    state.produtoPor = prefs.produtoPor === 'codigo' ? 'codigo' : 'nome';
    el('empresa-list').innerHTML = lista.map(function (e) {
      return '<li data-nome="' + escapeHtml(merge.normNome(nomeLoja(e))) + '">' +
        '<label><input type="checkbox" value="' + e.idEmpresa + '" /><span>' + escapeHtml(nomeLoja(e)) + '</span></label>' +
        '<button type="button" class="multi-only" data-only="' + e.idEmpresa + '">só esta</button></li>';
    }).join('');
    el('empresa-busca').hidden = lista.length < 8;
    setEmpresas(sel);
  }

  // A 1a loja selecionada (ordem da lista) e a "principal": dona da configuracao do painel.
  function setEmpresas(ids) {
    var lista = cache.empresas || [];
    state.empresas = lista.filter(function (e) { return ids.indexOf(e.idEmpresa) >= 0; }).slice(0, MAX_LOJAS);
    if (!state.empresas.length) state.empresas = lista.slice(0, 1);
    api.setEmpresa(state.empresas[0]);
    var p = loadPrefs();
    p.empresasSel = state.empresas.map(function (e) { return e.idEmpresa; });
    p.produtoPor = state.produtoPor;
    savePrefs(p);
    var n = state.empresas.length, e0 = state.empresas[0];
    var nomes = state.empresas.map(nomeLoja).join(' + ');
    el('empresa-summary').textContent = n === 1 ? nomeLoja(e0) : n + ' lojas';
    el('empresa-meta').textContent = n === 1 ? (e0.cnpj ? 'CNPJ ' + e0.cnpj : '') : 'dados somados';
    el('brand-empresa').textContent = nomes;
    el('brand-empresa').title = nomes;
    syncEmpresaChecks();
  }

  // Volta os checkboxes e o "somar por" ao que esta aplicado (descarta marcacao nao aplicada).
  function syncEmpresaChecks() {
    var ids = state.empresas.map(function (e) { return e.idEmpresa; });
    el('empresa-list').querySelectorAll('input').forEach(function (i) { i.checked = ids.indexOf(Number(i.value)) >= 0; });
    el('produto-por').value = state.produtoPor;
    el('empresa-busca').value = '';
    filtrarEmpresas();
    syncEmpresaCount();
  }
  function empresasMarcadas() {
    return Array.prototype.map.call(el('empresa-list').querySelectorAll('input:checked'), function (i) { return Number(i.value); });
  }
  function syncEmpresaCount() {
    var n = empresasMarcadas().length;
    el('empresa-count').textContent = n > MAX_LOJAS ? 'Máximo de ' + MAX_LOJAS + ' lojas por vez'
      : n + (n === 1 ? ' loja marcada' : ' lojas marcadas');
    el('empresa-aplicar').disabled = n < 1 || n > MAX_LOJAS;
    el('produto-por').parentNode.hidden = n < 2;
  }
  function filtrarEmpresas() {
    var q = merge.normNome(el('empresa-busca').value);
    el('empresa-list').querySelectorAll('li').forEach(function (li) {
      li.hidden = !!q && li.getAttribute('data-nome').indexOf(q) < 0;
    });
  }
  function aplicarEmpresas(ids) {
    state.produtoPor = el('produto-por').value === 'codigo' ? 'codigo' : 'nome';
    el('empresa-multi').open = false;
    setEmpresas(ids);
    loadConfigThenDashboard();
  }

  /* ------------------------------------------------------------- views */
  function showLogin(msg) {
    hide(el('view-app')); show(el('view-login'));
    el('login-error').textContent = msg || '';
    el('login-error').hidden = !msg;
    el('login-api').textContent = cfg.apiBase;
    // "Lembrar de mim": volta o e-mail (a senha fica por conta do navegador)
    var p = loadPrefs();
    el('login-lembrar').checked = p.lembrar !== false;
    if (!el('login-email').value && p.email) el('login-email').value = p.email;
    el(el('login-email').value ? 'login-senha' : 'login-email').focus();
  }

  function enterApp() {
    show(el('view-app')); hide(el('view-login'));
    el('brand-empresa').textContent = '…';
    return api.empresas().then(function (lista) {
      if (!lista || !lista.length) {
        showLogin('Seu usuario nao possui empresas vinculadas.');
        return;
      }
      cache.empresas = lista;
      populateEmpresas(lista);
      // periodo inicial: mes atual (sem carregar ainda; a config decide as fontes)
      state.preset = 'mes';
      state.range = computeRange('mes');
      syncFilterUI();
      loadConfigThenDashboard();
    }).catch(function (e) {
      api.logout();
      showLogin(e.status === 401 ? 'Sessao expirada. Entre novamente.' : ('Falha ao carregar empresas: ' + e.message));
    });
  }

  function onLoginSubmit(ev) {
    ev.preventDefault();
    var email = el('login-email').value.trim();
    var senha = el('login-senha').value;
    if (!email || !senha) { showLogin('Informe e-mail e senha.'); return; }
    var btn = el('login-submit');
    btn.disabled = true; btn.classList.add('loading');
    el('login-error').hidden = true;
    var lembrar = el('login-lembrar').checked;
    api.login(email, senha, lembrar).then(function () {
      var p = loadPrefs();
      p.lembrar = lembrar;
      if (lembrar) p.email = email; else delete p.email;
      savePrefs(p);
      el('login-senha').value = '';
      return enterApp();
    }).catch(function (e) {
      showLogin(e.message || 'Falha no login.');
    }).finally(function () {
      btn.disabled = false; btn.classList.remove('loading');
    });
  }

  function doLogout() {
    api.logout();
    charts.destroyAll();
    cache = {};
    sazCache = {};
    closeConfig();
    showLogin();
  }

  /* ------------------------------------------------------------- bind */
  function bindUI() {
    el('login-form').addEventListener('submit', onLoginSubmit);
    el('btn-logout').addEventListener('click', doLogout);
    el('btn-refresh').addEventListener('click', function () { loadDashboard(); });
    el('theme-toggle').addEventListener('click', toggleTheme);
    el('btn-aplicar').addEventListener('click', applyCustom);
    el('saz-select').addEventListener('change', renderSazonalidadeGrade);
    el('saz-turno-select').addEventListener('change', renderSazonalidadeTurnos);
    el('prod7-turno').addEventListener('change', renderProducao7);

    // seletor de lojas
    el('empresa-multi').addEventListener('toggle', function () {
      if (!el('empresa-multi').open) return;
      syncEmpresaChecks();
      if (!el('empresa-busca').hidden) el('empresa-busca').focus();
    });
    el('empresa-busca').addEventListener('input', filtrarEmpresas);
    el('empresa-list').addEventListener('change', syncEmpresaCount);
    el('empresa-list').addEventListener('click', function (ev) {
      var so = ev.target.getAttribute && ev.target.getAttribute('data-only');
      if (so) aplicarEmpresas([Number(so)]);
    });
    el('empresa-aplicar').addEventListener('click', function () { aplicarEmpresas(empresasMarcadas()); });

    // exportacao e fechamento dos menus (clique fora / Esc)
    buildExportMenus();
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-fmt]') : null;
      if (b) {
        var menu = b.closest('details.export-menu');
        exportar(menu.getAttribute('data-export'), b.getAttribute('data-fmt'));
        menu.open = false;
      }
      document.querySelectorAll('details.multi[open], details.export-menu[open]').forEach(function (d) {
        if (!d.contains(ev.target)) d.open = false;
      });
    });

    // painel de configuracao
    el('btn-config').addEventListener('click', openConfig);
    el('config-close').addEventListener('click', closeConfig);
    el('config-cancel').addEventListener('click', closeConfig);
    el('config-save').addEventListener('click', saveConfig);
    el('config-list').addEventListener('click', onConfigListClick);
    document.querySelectorAll('[data-config-close]').forEach(function (b) { b.addEventListener('click', closeConfig); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!el('config-modal').hidden) closeConfig();
      document.querySelectorAll('details.multi[open], details.export-menu[open]').forEach(function (d) { d.open = false; });
    });

    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(b.getAttribute('data-range')); });
    });
    document.addEventListener('click', function (ev) {
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-retry')) loadDashboard();
    });
  }

  function boot() {
    var prefs = loadPrefs();
    applyTheme(prefs.theme || 'light');
    bindUI();
    if (api.isLoggedIn()) enterApp(); else showLogin();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
