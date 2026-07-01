/* ==========================================================================
 * Controlador principal do painel.
 * Painel configuravel por empresa: o catalogo de widgets vive em widgets.js e
 * a config (visibilidade + ordem) e salva por empresa (servidor + cache local).
 * Cada "fonte de dados" (fetch) so roda se ha widget visivel que dependa dela.
 * ========================================================================== */
(function () {
  var api = LADBI.api, fmt = LADBI.fmt, charts = LADBI.charts, cfg = LADBI.config, W = LADBI.widgets;

  function el(id) { return document.getElementById(id); }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  // Cache dos dados renderizados (para re-render ao trocar tema, sem refetch)
  var cache = {};
  var state = { range: null, preset: 'mes', gen: 0, config: null, visibleSet: {} };

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
      ov.innerHTML = '<div class="state-ic">◍</div><span>' + (msg || 'Sem dados neste periodo.') + '</span>';
    } else {
      ov.innerHTML = '<div class="state-ic err">!</div><span>' + (msg || 'Erro ao carregar.') + '</span>' +
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
    return {
      idEmpresa: api.getEmpresaId(),
      dataInicio: fmt.apiStart(state.range.inicio),
      dataFim: fmt.apiEnd(state.range.fim)
    };
  }
  // Datas em yyyy-MM-dd (endpoints KDS usam esse formato).
  function currentParamsDate() {
    return {
      idEmpresa: api.getEmpresaId(),
      dataInicio: fmt.inputDate(state.range.inicio),
      dataFim: fmt.inputDate(state.range.fim)
    };
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
    if (!state.range) return;
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
  }

  function loadCaixa(gen) {
    var p = currentParams();
    api.caixaRelatorio({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: true })
      .then(function (data) {
        if (stale(gen)) return;
        var resumo = data.resumo_geral || {};
        if (visible('kpis')) renderKpiCaixa(resumo);
        var rc = data.ranking_consolidado;
        if (!rc && (resumo.totalComandas || 0) === 0) {
          CAIXA_CARDS.forEach(function (c) { if (visible(c.id)) setState(c.card, 'empty'); });
          return;
        }
        if (!rc) {
          return api.caixaRelatorio({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: false })
            .then(function (full) { if (stale(gen)) return; renderRanking(aggregateFromCaixas(full.caixas)); });
        }
        renderRanking(rc);
      })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        if (visible('kpis')) { setKpi('kpi-faturamento', '—'); setKpi('kpi-comandas', '—'); setKpi('kpi-ticket', '—'); }
        CAIXA_CARDS.forEach(function (c) { if (visible(c.id)) setState(c.card, 'error', e.message); });
      });
  }

  function loadCancel(gen) {
    var p = currentParams();
    api.cancelamentos({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: true })
      .then(function (data) {
        if (stale(gen)) return;
        var resumo = data.resumo || {};
        if (visible('kpis')) {
          setKpi('kpi-cancelado', fmt.money(resumo.valorCancelado));
          el('kpi-cancelado-sub').textContent = (resumo.percentualDoFaturamento != null)
            ? fmt.pct(resumo.percentualDoFaturamento) + ' do faturamento • ' + fmt.int(resumo.totalCancelamentos) + ' itens'
            : fmt.int(resumo.totalCancelamentos || 0) + ' itens';
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
    api.produtoVendedor({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .then(function (data) { if (stale(gen)) return; renderProdutoVendedor(data.vendedores || []); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-produto-vendedor', 'error', e.message); });
  }

  function loadContaCliente(gen) {
    var p = currentParams();
    api.contaCliente({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .then(function (data) { if (stale(gen)) return; renderContaCliente((data.saldosPorCliente) || []); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-conta-cliente', 'error', e.message); });
  }

  function loadDre(gen) {
    var p = currentParams();
    api.dre({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .then(function (data) { if (stale(gen)) return; renderDre(data); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-dre', 'error', e.message); });
  }

  function loadContasPagar(gen) {
    var p = currentParams();
    api.contasPagar({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .then(function (data) { if (stale(gen)) return; renderContasPagar(data); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-contas-pagar', 'error', e.message); });
  }

  function loadTaxaServico(gen) {
    var p = currentParams();
    api.taxaServico({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .then(function (data) { if (stale(gen)) return; renderTaxaServico(data); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-taxa-servico', 'error', e.message); });
  }

  function loadVendasCanal(gen) {
    var p = currentParamsDate();
    api.vendasCanal({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .then(function (data) { if (stale(gen)) return; renderVendasCanal(data); })
      .catch(function (e) { if (sessionGone() || stale(gen)) return; setState('card-vendas-canal', 'error', e.message); });
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

  /* ------------------------------------------------------------- exports CSV */
  function exportCSV(which) {
    var per = ' (' + fmt.inputDate(state.range.inicio) + '_a_' + fmt.inputDate(state.range.fim) + ')';
    if (which === 'vendedores' && cache.vendedores) {
      fmt.downloadCSV('garcons_vendas' + per + '.csv',
        ['Garcom', 'Vendas', 'Valor total', '% do total', 'Ticket medio'],
        cache.vendedores.map(function (v) {
          return [v.vendedor ? v.vendedor.nome : '', v.quantidadeVendas || 0, v.valorTotal || 0, v.percentual || 0, v.ticketMedio || 0];
        }));
    } else if (which === 'cancel' && cache.cancel) {
      fmt.downloadCSV('garcons_cancelamentos' + per + '.csv',
        ['Garcom', 'Itens cancelados', 'Quantidade', 'Valor cancelado', '% do total'],
        cache.cancel.map(function (v) { return [v.vendedor || '', v.totalCancelamentos || 0, v.quantidade || 0, v.valorTotal || 0, v.percentual || 0]; }));
    } else if (which === 'produto-vendedor' && cache.produtoVendedor) {
      fmt.downloadCSV('produto_por_garcom' + per + '.csv',
        ['Garcom', 'Produto mais vendido', 'Qtd', 'Valor do produto', 'Total do garcom'],
        cache.produtoVendedor.map(function (v) {
          var prods = (v.produtos || []).slice().sort(function (a, b) { return (b.valorTotal || 0) - (a.valorTotal || 0); });
          var t = prods[0] || {};
          return [v.vendedorNome || '', t.produtoNome || '', t.quantidadeTotal || 0, t.valorTotal || 0, v.valorTotal || 0];
        }));
    } else if (which === 'conta-cliente' && cache.contaCliente) {
      fmt.downloadCSV('ticket_medio_cliente' + per + '.csv',
        ['Cliente', 'Ticket medio', 'Nº contas', 'Valor total', 'Saldo em aberto'],
        cache.contaCliente.map(function (c) { return [c.nomeCliente || '', c.ticketMedio || 0, c.totalContas || 0, c.valorTotal || 0, c.saldoAberto || 0]; }));
    }
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

  /* ------------------------------------------------------------- empresa */
  function populateEmpresas(lista) {
    var sel = el('empresa-select');
    sel.innerHTML = '';
    lista.forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.idEmpresa;
      o.textContent = (e.fantasia || ('Empresa ' + e.idEmpresa));
      sel.appendChild(o);
    });
    var saved = api.getEmpresaId();
    var ids = lista.map(function (e) { return e.idEmpresa; });
    var chosen = (saved && ids.indexOf(saved) >= 0) ? saved
      : (ids.indexOf(cfg.empresaPadrao) >= 0 ? cfg.empresaPadrao : (ids[0] || null));
    sel.value = chosen;
    var emp = lista.filter(function (e) { return e.idEmpresa === chosen; })[0] || lista[0];
    api.setEmpresa(emp);
    updateEmpresaMeta(emp);
  }
  function updateEmpresaMeta(emp) {
    el('empresa-meta').textContent = emp && emp.cnpj ? ('CNPJ ' + emp.cnpj) : '';
  }
  function onEmpresaChange() {
    var sel = el('empresa-select');
    var id = Number(sel.value);
    var lista = cache.empresas || [];
    var emp = lista.filter(function (e) { return e.idEmpresa === id; })[0];
    if (emp) { api.setEmpresa(emp); updateEmpresaMeta(emp); loadConfigThenDashboard(); }
  }

  /* ------------------------------------------------------------- views */
  function showLogin(msg) {
    hide(el('view-app')); show(el('view-login'));
    el('login-error').textContent = msg || '';
    el('login-error').hidden = !msg;
    el('login-api').textContent = cfg.apiBase;
    el('login-email').focus();
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
      el('brand-empresa').textContent = (api.getSession().empresa.fantasia || '');
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
    api.login(email, senha).then(function () {
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
    closeConfig();
    showLogin();
  }

  /* ------------------------------------------------------------- bind */
  function bindUI() {
    el('login-form').addEventListener('submit', onLoginSubmit);
    el('btn-logout').addEventListener('click', doLogout);
    el('btn-refresh').addEventListener('click', function () { loadDashboard(); });
    el('theme-toggle').addEventListener('click', toggleTheme);
    el('empresa-select').addEventListener('change', onEmpresaChange);
    el('btn-aplicar').addEventListener('click', applyCustom);

    // painel de configuracao
    el('btn-config').addEventListener('click', openConfig);
    el('config-close').addEventListener('click', closeConfig);
    el('config-cancel').addEventListener('click', closeConfig);
    el('config-save').addEventListener('click', saveConfig);
    el('config-list').addEventListener('click', onConfigListClick);
    document.querySelectorAll('[data-config-close]').forEach(function (b) { b.addEventListener('click', closeConfig); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !el('config-modal').hidden) closeConfig();
    });

    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(b.getAttribute('data-range')); });
    });
    document.querySelectorAll('[data-export]').forEach(function (b) {
      b.addEventListener('click', function () { exportCSV(b.getAttribute('data-export')); });
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
