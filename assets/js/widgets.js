/* ==========================================================================
 * Catalogo unico de widgets do painel (fonte de verdade).
 * Alimenta: o painel de Configuracao, a ordem/visibilidade dos cards e o
 * mapeamento widget -> fonte(s) de dados (define quais fetches sao disparados).
 *
 * Para adicionar um widget novo: registre aqui + crie o card no index.html +
 * o loader/render no app.js. Configs ja salvas continuam funcionando (o novo
 * widget entra com defaultVisible via normalize()).
 * ========================================================================== */
window.LADBI = window.LADBI || {};

(function () {
  // sources = quais fetches o widget precisa. Um fetch so roda se ao menos um
  // widget visivel depende dele (evita chamada de API para card oculto).
  var WIDGETS = [
    { id: 'kpis',             titulo: 'Indicadores do topo (KPIs)',        categoria: 'Resumo',         cardId: 'kpi-row',            sources: ['caixa', 'cancel'], defaultVisible: true,  pinned: true },
    { id: 'vendedores',       titulo: 'Quanto cada garçom vende',          categoria: 'Vendas',         cardId: 'card-vendedores',    sources: ['caixa'],           defaultVisible: true },
    { id: 'produtos-top',     titulo: 'Produtos mais vendidos',            categoria: 'Vendas',         cardId: 'card-produtos-top',  sources: ['caixa'],           defaultVisible: true },
    { id: 'produtos-bottom',  titulo: 'Produtos menos vendidos',           categoria: 'Vendas',         cardId: 'card-produtos-bottom', sources: ['caixa'],         defaultVisible: true },
    { id: 'produto-vendedor', titulo: 'Produto campeão por garçom',        categoria: 'Vendas',         cardId: 'card-produto-vendedor', sources: ['produtoVendedor'], defaultVisible: true },
    { id: 'formas',           titulo: 'Formas de pagamento',               categoria: 'Vendas',         cardId: 'card-formas',        sources: ['caixa'],           defaultVisible: true },
    { id: 'cancel',           titulo: 'Garçom que mais cancela',           categoria: 'Cancelamentos',  cardId: 'card-cancel',        sources: ['cancel'],          defaultVisible: true },
    { id: 'cancel-produtos',  titulo: 'Produtos e motivos mais cancelados', categoria: 'Cancelamentos', cardId: 'card-cancel-produtos', sources: ['cancel'],        defaultVisible: false },
    { id: 'conta-cliente',    titulo: 'Ticket médio por cliente',          categoria: 'Financeiro',     cardId: 'card-conta-cliente', sources: ['contaCliente'],    defaultVisible: true },
    { id: 'dre',              titulo: 'DRE / Resultado do período',        categoria: 'Financeiro',     cardId: 'card-dre',           sources: ['dre'],             defaultVisible: false },
    { id: 'contas-pagar',     titulo: 'Contas a pagar (vencimentos)',      categoria: 'Financeiro',     cardId: 'card-contas-pagar',  sources: ['contasPagar'],     defaultVisible: false },
    { id: 'taxa-servico',     titulo: 'Taxa de serviço por garçom',        categoria: 'Financeiro',     cardId: 'card-taxa-servico',  sources: ['taxaServico'],     defaultVisible: false },
    { id: 'vendas-canal',     titulo: 'Vendas por canal',                  categoria: 'Operação',       cardId: 'card-vendas-canal',  sources: ['vendasCanal'],     defaultVisible: false }
  ];

  var byId = {};
  WIDGETS.forEach(function (w) { byId[w.id] = w; });

  LADBI.widgets = {
    list: WIDGETS,
    get: function (id) { return byId[id]; },

    // Config default (todos na ordem do catalogo, visibilidade padrao).
    defaultConfig: function () {
      return { version: 1, widgets: WIDGETS.map(function (w) { return { id: w.id, visible: w.defaultVisible }; }) };
    },

    // Reconcilia uma config (servidor/localStorage) com o catalogo atual:
    //  - descarta ids que nao existem mais;
    //  - mantem a ordem salva;
    //  - anexa widgets novos (ainda nao na config) com defaultVisible ao final.
    normalize: function (cfg) {
      var out = [];
      var seen = {};
      var arr = (cfg && cfg.widgets) ? cfg.widgets : [];
      arr.forEach(function (item) {
        if (!item) return;
        var w = byId[item.id];
        if (w && !seen[item.id]) {
          out.push({ id: item.id, visible: item.visible !== false });
          seen[item.id] = true;
        }
      });
      WIDGETS.forEach(function (w) {
        if (!seen[w.id]) { out.push({ id: w.id, visible: w.defaultVisible }); seen[w.id] = true; }
      });
      return { version: 1, widgets: out };
    }
  };
})();
