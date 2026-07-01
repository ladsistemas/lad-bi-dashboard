/* ==========================================================================
 * Cliente da API LAD BI: autenticacao (login/refresh), sessao e endpoints.
 * Usa apenas fetch nativo. Token guardado em localStorage.
 * ========================================================================== */
window.LADBI = window.LADBI || {};

(function () {
  var cfg = LADBI.config;
  var KEY = cfg.storageKey;

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; }
    catch (e) { return null; }
  }
  function saveSession(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(KEY); }

  var session = loadSession();
  var refreshing = null; // promessa em andamento (evita refresh concorrente)

  function isLoggedIn() { return !!(session && session.accessToken); }
  function getSession() { return session; }

  function setEmpresa(emp) {
    if (!session) return;
    session.empresa = emp; // objeto EmpresaAccessDTO ou {idEmpresa, fantasia,...}
    saveSession(session);
  }
  function getEmpresaId() {
    return session && session.empresa ? session.empresa.idEmpresa : null;
  }

  function parseError(res, fallback) {
    return res.text().then(function (txt) {
      var msg = fallback;
      try {
        var j = JSON.parse(txt);
        if (j) msg = j.mensagem || j.message || j.error || j.reason || msg;
      } catch (_) { /* corpo nao-JSON */ }
      var err = new Error(msg);
      err.status = res.status;
      return Promise.reject(err);
    });
  }

  function login(email, senha) {
    return fetch(cfg.apiBase + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, senha: senha })
    }).then(function (res) {
      if (!res.ok) {
        return parseError(res, res.status === 401 || res.status === 400
          ? 'E-mail ou senha invalidos.'
          : 'Nao foi possivel entrar (' + res.status + ').');
      }
      return res.json();
    }).then(function (data) {
      session = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
        empresa: (session && session.empresa) || null
      };
      saveSession(session);
      return session;
    });
  }

  function expiredErr() {
    var err = new Error('Sessao expirada. Entre novamente.');
    err.status = 401;
    return err;
  }

  function refresh() {
    if (refreshing) return refreshing;
    if (!session || !session.refreshToken) {
      return Promise.reject(expiredErr());
    }
    refreshing = fetch(cfg.apiBase + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken })
    }).then(function (res) {
      if (!res.ok) { clearSession(); session = null; throw expiredErr(); }
      return res.json();
    }).then(function (data) {
      if (!session) { throw expiredErr(); } // logout ocorreu durante o refresh
      session.accessToken = data.access_token;
      session.refreshToken = data.refresh_token || session.refreshToken;
      session.expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
      saveSession(session);
      return session;
    }).finally(function () { refreshing = null; });
    return refreshing;
  }

  function logout() { clearSession(); session = null; }

  // GET autenticado. Renova o token proativamente quando esta perto de expirar
  // e ainda mantem o retry em 401 como rede de seguranca.
  function authedGet(path) {
    if (!isLoggedIn()) return Promise.reject(new Error('Nao autenticado.'));
    function doFetch() {
      return fetch(cfg.apiBase + path, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + session.accessToken }
      });
    }
    var pre = (session.expiresAt && Date.now() > session.expiresAt - 30000)
      ? refresh() : Promise.resolve();
    return pre.then(doFetch).then(function (res) {
      if (res.status === 401) {
        return refresh().then(doFetch);
      }
      return res;
    }).then(function (res) {
      if (!res.ok) return parseError(res, 'Erro ' + res.status + ' ao consultar a API.');
      return res.json();
    });
  }

  // Envio autenticado com corpo JSON (PUT/POST). Mesma renovacao proativa do authedGet.
  function authedSend(path, method, body) {
    if (!isLoggedIn()) return Promise.reject(new Error('Nao autenticado.'));
    function doFetch() {
      return fetch(cfg.apiBase + path, {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + session.accessToken,
          'Content-Type': 'application/json'
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    }
    var pre = (session.expiresAt && Date.now() > session.expiresAt - 30000)
      ? refresh() : Promise.resolve();
    return pre.then(doFetch).then(function (res) {
      if (res.status === 401) return refresh().then(doFetch);
      return res;
    }).then(function (res) {
      if (!res.ok) return parseError(res, 'Erro ' + res.status + ' ao salvar.');
      return res.json();
    });
  }

  // Monta query string ignorando valores nulos/indefinidos.
  function qs(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  // -------- Endpoints --------
  function empresas() { return authedGet('/auth/empresas'); }

  function caixaRelatorio(p) {
    return authedGet('/api/v1/llm/caixa/relatorio' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim,
      resumido: (p.resumido === undefined ? true : p.resumido)
    }));
  }
  function cancelamentos(p) {
    return authedGet('/api/v1/llm/cancelamentos' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim,
      resumido: (p.resumido === undefined ? true : p.resumido)
    }));
  }
  function produtoVendedor(p) {
    return authedGet('/api/v1/llm/vendas/produto-vendedor' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim,
      nomeProduto: p.nomeProduto, nomeVendedor: p.nomeVendedor
    }));
  }
  function contaCliente(p) {
    return authedGet('/api/v1/llm/financeiro/conta-cliente' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim
    }));
  }
  function dre(p) {
    return authedGet('/api/v1/llm/financeiro/dre' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim
    }));
  }
  function contasPagar(p) {
    return authedGet('/api/v1/llm/financeiro/contas-pagar' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim
    }));
  }
  function taxaServico(p) {
    return authedGet('/api/v1/llm/financeiro/taxa-servico' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim
    }));
  }
  // KDS: datas em yyyy-MM-dd (formato diferente dos /financeiro/*).
  function vendasCanal(p) {
    return authedGet('/api/v1/llm/kds/vendas/analise-canal' + qs({
      idEmpresa: p.idEmpresa, dataInicio: p.dataInicio, dataFim: p.dataFim
    }));
  }

  // -------- Configuracao do painel (por empresa) --------
  function dashboardConfigGet(idEmpresa) {
    return authedGet('/api/v1/llm/dashboard/config' + qs({ idEmpresa: idEmpresa }));
  }
  function dashboardConfigSave(idEmpresa, config) {
    return authedSend('/api/v1/llm/dashboard/config' + qs({ idEmpresa: idEmpresa }), 'PUT', { config: config });
  }

  LADBI.api = {
    isLoggedIn: isLoggedIn,
    getSession: getSession,
    setEmpresa: setEmpresa,
    getEmpresaId: getEmpresaId,
    login: login,
    refresh: refresh,
    logout: logout,
    empresas: empresas,
    caixaRelatorio: caixaRelatorio,
    cancelamentos: cancelamentos,
    produtoVendedor: produtoVendedor,
    contaCliente: contaCliente,
    dre: dre,
    contasPagar: contasPagar,
    taxaServico: taxaServico,
    vendasCanal: vendasCanal,
    dashboardConfigGet: dashboardConfigGet,
    dashboardConfigSave: dashboardConfigSave
  };
})();
