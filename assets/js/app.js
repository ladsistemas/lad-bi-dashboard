/* ==========================================================================
 * Controlador principal do painel.
 * Painel personalizado com 5 visoes:
 *  1. Quanto cada garcom vende
 *  2. Produtos mais e menos vendidos
 *  3. Garcom que mais cancela
 *  4. Qual produto cada garcom mais vende
 *  5. Ticket medio por cliente (fiado)
 * ========================================================================== */
(function () {
  var api = LADBI.api, fmt = LADBI.fmt, charts = LADBI.charts, cfg = LADBI.config;

  function el(id) { return document.getElementById(id); }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }

  // Cache dos dados renderizados (para re-render ao trocar tema, sem refetch)
  var cache = {};
  var state = { range: null, preset: 'mes' };

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
    // botoes
    var btns = document.querySelectorAll('[data-range]');
    btns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-range') === state.preset); });
    // inputs
    el('date-inicio').value = fmt.inputDate(state.range.inicio);
    el('date-fim').value = fmt.inputDate(state.range.fim);
    // label
    el('periodo-label').textContent = fmt.dateBR(state.range.inicio) + ' – ' + fmt.dateBR(state.range.fim);
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
    // Recalcula o percentual de cada item sobre o total agregado (o ranking_consolidado
    // ja vem com esse campo; no fallback precisamos derivar para nao mostrar 0,0%).
    function comPercentual(list, key) {
      var total = list.reduce(function (s, it) { return s + (Number(it[key]) || 0); }, 0);
      list.forEach(function (it) { it.percentual = total ? (Number(it[key]) || 0) / total * 100 : 0; });
      return list;
    }
    var produtos = comPercentual(arr(prod, 'valorTotal'), 'valorTotal');
    var vendedores = comPercentual(arr(vend, 'valorTotal'), 'valorTotal');
    vendedores.forEach(function (v) { v.ticketMedio = v.quantidadeVendas ? v.valorTotal / v.quantidadeVendas : 0; });
    var formas = comPercentual(arr(forma, 'valor'), 'valor');
    // "menos vendidos" = cauda ascendente, sem repetir os que ja aparecem no top exibido
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

  // Token de geracao: ignora respostas de uma carga ja superada (troca rapida de periodo/empresa).
  function stale(gen) { return gen !== state.gen; }

  // Sessao morta (refresh esgotado limpou o token): volta ao login em vez de travar em erro.
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
    setKpi('kpi-faturamento', '…'); setKpi('kpi-comandas', '…');
    setKpi('kpi-ticket', '…'); setKpi('kpi-cancelado', '…');
    el('kpi-cancelado-sub').textContent = '';
    ['card-vendedores', 'card-formas', 'card-produtos-top', 'card-produtos-bottom',
      'card-cancel', 'card-produto-vendedor', 'card-conta-cliente'].forEach(function (c) { setState(c, 'loading'); });

    loadCaixa(gen);
    loadCancel(gen);
    loadProdutoVendedor(gen);
    loadContaCliente(gen);
  }

  function loadCaixa(gen) {
    var p = currentParams();
    api.caixaRelatorio({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: true })
      .then(function (data) {
        if (stale(gen)) return;
        var resumo = data.resumo_geral || {};
        renderKpiCaixa(resumo);
        var rc = data.ranking_consolidado;
        if (!rc && (resumo.totalComandas || 0) === 0) {
          // periodo vazio
          ['card-vendedores', 'card-formas', 'card-produtos-top', 'card-produtos-bottom']
            .forEach(function (c) { setState(c, 'empty'); });
          return;
        }
        if (!rc) {
          // 1 unico caixa: refetch detalhado e agrega
          return api.caixaRelatorio({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: false })
            .then(function (full) { if (stale(gen)) return; renderRanking(aggregateFromCaixas(full.caixas)); });
        }
        renderRanking(rc);
      })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        setKpi('kpi-faturamento', '—'); setKpi('kpi-comandas', '—'); setKpi('kpi-ticket', '—');
        ['card-vendedores', 'card-formas', 'card-produtos-top', 'card-produtos-bottom']
          .forEach(function (c) { setState(c, 'error', e.message); });
      });
  }

  function loadCancel(gen) {
    var p = currentParams();
    api.cancelamentos({ idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim, resumido: true })
      .then(function (data) {
        if (stale(gen)) return;
        var resumo = data.resumo || {};
        setKpi('kpi-cancelado', fmt.money(resumo.valorCancelado));
        el('kpi-cancelado-sub').textContent = (resumo.percentualDoFaturamento != null)
          ? fmt.pct(resumo.percentualDoFaturamento) + ' do faturamento • ' + fmt.int(resumo.totalCancelamentos) + ' itens'
          : fmt.int(resumo.totalCancelamentos || 0) + ' itens';
        renderCancelVendedores(data.cancelamentosPorVendedor || []);
      })
      .catch(function (e) {
        if (sessionGone() || stale(gen)) return;
        setKpi('kpi-cancelado', '—');
        setState('card-cancel', 'error', e.message);
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

  /* ------------------------------------------------------------- render */
  function setKpi(id, value) { var n = el(id); if (n) n.textContent = value; }

  function renderKpiCaixa(resumo) {
    setKpi('kpi-faturamento', fmt.money(resumo.totalFaturado));
    setKpi('kpi-comandas', fmt.int(resumo.totalComandas));
    setKpi('kpi-ticket', fmt.money(resumo.ticketMedio));
  }

  function renderRanking(rc) {
    cache.rc = rc;
    renderVendedores(rc.vendedores_ranking || []);
    renderProdutosTop(rc.produtos_mais_vendidos || []);
    renderProdutosBottom(rc.produtos_menos_vendidos || []);
    renderFormas(rc.recebimentos_por_forma || []);
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

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
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
    // re-render graficos com as novas cores (sem refetch)
    if (cache.rc) renderRanking(cache.rc);
    if (cache.cancel) renderCancelVendedores(cache.cancel);
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
    // escolher empresa: sessao salva > padrao(924) > primeira
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
    if (emp) { api.setEmpresa(emp); updateEmpresaMeta(emp); loadDashboard(); }
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
      // periodo inicial: mes atual
      applyPreset('mes');
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

    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(b.getAttribute('data-range')); });
    });
    document.querySelectorAll('[data-export]').forEach(function (b) {
      b.addEventListener('click', function () { exportCSV(b.getAttribute('data-export')); });
    });
    // retry dentro dos overlays
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
