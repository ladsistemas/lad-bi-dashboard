/* ==========================================================================
 * Consolidacao multiloja: recebe a resposta de cada loja selecionada e devolve
 * UMA resposta no mesmo formato da API, para os renders nao saberem a diferenca.
 *
 * Chaves de agrupamento (o id nunca serve: cada loja tem o seu cadastro):
 *   produto    -> nome (padrao) ou codigo, a escolha do usuario
 *   garcom, forma de pagamento, cliente, fornecedor, canal, categoria -> nome
 * Nome = sem acento, sem diferenca de caixa e sem espaco repetido.
 *
 * Soma o que e somavel e recalcula o que e derivado (ticket, %, margem).
 * Mediana e p90 (tempo de entrega) nao se somam: o painel compara as lojas.
 *
 * Sem DOM: roda no node (test/merge.test.js).
 * ========================================================================== */
window.LADBI = window.LADBI || {};

(function () {
  var DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  // tira o ruido de ponto flutuante das somas (0.1 + 0.2), sem mudar o valor
  function limpo(v) { return Math.round(v * 1e4) / 1e4; }

  function normNome(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Sem codigo na resposta (API antiga ou produto sem codigo) cai no nome.
  function produtoKey(nome, codigo, modo) {
    return (modo === 'codigo' && codigo != null && codigo !== '') ? 'c:' + codigo : 'n:' + normNome(nome);
  }

  // Agrupa pela chave somando os campos informados. A 1a linha de cada chave (copia rasa)
  // da os demais campos, como o nome exibido.
  function agrupar(linhas, keyFn, campos) {
    var mapa = {}, saida = [];
    linhas.forEach(function (l) {
      var k = keyFn(l), o = mapa[k];
      if (!o) {
        o = mapa[k] = Object.assign({}, l);
        campos.forEach(function (c) { o[c] = 0; });
        saida.push(o);
      }
      campos.forEach(function (c) { o[c] = limpo(o[c] + num(l[c])); });
    });
    return saida;
  }

  function juntar(parts, pick) {
    return parts.reduce(function (acc, p) { return acc.concat(pick(p.data || {}) || []); }, []);
  }
  function somaCampos(objs, campos) {
    var o = {};
    campos.forEach(function (c) { o[c] = limpo(objs.reduce(function (s, x) { return s + num(x && x[c]); }, 0)); });
    return o;
  }
  function soma(lista, campo) { return lista.reduce(function (s, x) { return s + num(x[campo]); }, 0); }
  function desc(campo) { return function (a, b) { return num(b[campo]) - num(a[campo]); }; }
  function comPercentual(lista, campo, total, destino) {
    lista.forEach(function (l) { l[destino || 'percentual'] = total ? num(l[campo]) / total * 100 : 0; });
    return lista;
  }
  function opt(opts) { return (opts && opts.produtoPor) || 'nome'; }

  var M = { normNome: normNome, produtoKey: produtoKey };

  /* ------------------------------------------------------------------ caixa */
  // parts[].data = { resumo, rc } (rc = ranking_consolidado da loja, ou null sem movimento).
  M.caixa = function (parts, opts) {
    var modo = opt(opts);
    var resumo = somaCampos(parts.map(function (p) { return p.data.resumo; }), ['totalFaturado', 'totalComandas']);
    resumo.ticketMedio = resumo.totalComandas ? resumo.totalFaturado / resumo.totalComandas : 0;

    // Por loja: une mais + menos vendidos sem repetir o produto (o id e unico dentro da loja).
    // "menos vendidos" parte do cadastro ativo, entao marca quem pode aparecer como menor giro.
    var produtos = [];
    parts.forEach(function (p) {
      var rc = p.data.rc || {}, visto = {};
      function add(x, doCadastro) {
        var pr = x.produto || {};
        var id = pr.id != null ? pr.id : 'n:' + pr.nome;
        if (visto[id]) { if (doCadastro) visto[id].ativo = 1; return; }
        produtos.push(visto[id] = { produto: pr, quantidade: x.quantidade, valorTotal: x.valorTotal, ativo: doCadastro ? 1 : 0 });
      }
      (rc.produtos_mais_vendidos || []).forEach(function (x) { add(x, false); });
      (rc.produtos_menos_vendidos || []).forEach(function (x) { add(x, true); });
    });
    var prods = comPercentual(
      agrupar(produtos, function (x) { return produtoKey(x.produto.nome, x.produto.codigo, modo); }, ['quantidade', 'valorTotal', 'ativo']),
      'valorTotal', resumo.totalFaturado);

    var vendedores = agrupar(juntar(parts, function (d) { return (d.rc || {}).vendedores_ranking; }),
      function (v) { return normNome(v.vendedor && v.vendedor.nome); }, ['quantidadeVendas', 'valorTotal']);
    vendedores.forEach(function (v) { v.ticketMedio = v.quantidadeVendas ? v.valorTotal / v.quantidadeVendas : 0; });
    comPercentual(vendedores, 'valorTotal', resumo.totalFaturado);

    var formas = comPercentual(
      agrupar(juntar(parts, function (d) { return (d.rc || {}).recebimentos_por_forma; }),
        function (f) { return normNome(f.forma && f.forma.nome); }, ['quantidade', 'valor']),
      'valor', resumo.totalFaturado);

    return {
      resumo_geral: resumo,
      ranking_consolidado: {
        produtos_mais_vendidos: prods.filter(function (p) { return p.valorTotal > 0 || p.quantidade > 0; })
          .sort(desc('valorTotal')).slice(0, 20),
        produtos_menos_vendidos: prods.filter(function (p) { return p.ativo > 0; })
          .sort(function (a, b) {
            return a.valorTotal - b.valorTotal || a.quantidade - b.quantidade ||
              String(a.produto.nome).localeCompare(String(b.produto.nome));
          }).slice(0, 20),
        vendedores_ranking: vendedores.sort(desc('valorTotal')),
        recebimentos_por_forma: formas.sort(desc('valor'))
      }
    };
  };

  /* ----------------------------------------------------------- cancelamentos */
  M.cancel = function (parts, opts) {
    var modo = opt(opts);
    var resumo = somaCampos(parts.map(function (p) { return (p.data || {}).resumo; }),
      ['totalCancelamentos', 'quantidadeCancelada', 'valorCancelado']);
    var vend = agrupar(juntar(parts, function (d) { return d.cancelamentosPorVendedor; }),
      function (v) { return normNome(v.vendedor); }, ['totalCancelamentos', 'quantidade', 'valorTotal']);
    var prods = agrupar(juntar(parts, function (d) { return d.produtosCancelados; }),
      function (p) { var pr = p.produto || {}; return produtoKey(pr.nome, pr.codigo, modo); }, ['quantidade', 'valorTotal']);
    return {
      resumo: resumo,
      cancelamentosPorVendedor: comPercentual(vend, 'valorTotal', soma(vend, 'valorTotal')).sort(desc('valorTotal')),
      produtosCancelados: comPercentual(prods, 'valorTotal', soma(prods, 'valorTotal')).sort(desc('valorTotal'))
    };
  };

  /* --------------------------------------------------- produto por vendedor */
  M.produtoVendedor = function (parts, opts) {
    var modo = opt(opts);
    var porVendedor = {}, ordem = [];
    juntar(parts, function (d) { return d.vendedores; }).forEach(function (v) {
      var k = normNome(v.vendedorNome), o = porVendedor[k];
      if (!o) { o = porVendedor[k] = { vendedorNome: v.vendedorNome, valorTotal: 0, produtos: [] }; ordem.push(o); }
      o.valorTotal += num(v.valorTotal);
      o.produtos = o.produtos.concat(v.produtos || []);
    });
    ordem.forEach(function (o) {
      o.produtos = agrupar(o.produtos, function (p) { return produtoKey(p.produtoNome, p.produtoCodigo, modo); },
        ['quantidadeTotal', 'valorTotal', 'qtdVendas']);
    });
    return { vendedores: ordem };
  };

  /* ---------------------------------------------------------- conta cliente */
  M.contaCliente = function (parts) {
    var saldos = agrupar(juntar(parts, function (d) { return d.saldosPorCliente; }),
      function (c) { return normNome(c.nomeCliente); }, ['totalContas', 'valorTotal', 'valorPago', 'saldoAberto']);
    saldos.forEach(function (c) { c.ticketMedio = c.totalContas ? c.valorTotal / c.totalContas : 0; });
    return { saldosPorCliente: saldos };
  };

  /* -------------------------------------------------------------------- dre */
  M.dre = function (parts) {
    var resumos = parts.map(function (p) { return (p.data || {}).resumo || {}; });
    var campos = {};
    resumos.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (typeof r[k] === 'number' && !/^margem/i.test(k)) campos[k] = true; });
    });
    var resumo = somaCampos(resumos, Object.keys(campos));
    // Loja sem movimento nao manda os campos: sem nenhum, o painel mostra "sem dados".
    if (!Object.keys(campos).length) return { resumo: {} };
    var base = resumo.receitaLiquida || resumo.receitaBruta || 0;
    resumo.margemLiquida = base ? num(resumo.resultadoLiquido) / base * 100 : 0;
    if (resumo.resultadoOperacional != null) resumo.margemOperacional = base ? resumo.resultadoOperacional / base * 100 : 0;
    return { resumo: resumo };
  };

  /* ---------------------------------------------------------- contas a pagar */
  M.contasPagar = function (parts) {
    return {
      resumo: somaCampos(parts.map(function (p) { return (p.data || {}).resumo; }),
        ['totalContas', 'totalParcelas', 'totalAberto', 'totalPago', 'valorTotal', 'parcelasVencidas']),
      porFornecedor: agrupar(juntar(parts, function (d) { return d.porFornecedor; }),
        function (f) { return normNome(f.nomeFantasia); }, ['valorAberto', 'valorTotal', 'valorPago'])
    };
  };

  /* --------------------------------------------------------- taxa de servico */
  M.taxaServico = function (parts) {
    var resumos = parts.map(function (p) { return (p.data || {}).resumo || {}; });
    var resumo = somaCampos(resumos, ['total_taxa_servico', 'total_comandas']);
    resumo.ticket_medio_taxa = resumo.total_comandas ? resumo.total_taxa_servico / resumo.total_comandas : 0;
    // % medio de cada loja ponderado pelas comandas dela
    resumo.percentual_medio = resumo.total_comandas
      ? resumos.reduce(function (s, r) { return s + num(r.percentual_medio) * num(r.total_comandas); }, 0) / resumo.total_comandas
      : 0;
    var func = agrupar(juntar(parts, function (d) { return d.por_funcionario; }),
      function (f) { return normNome(f.funcionario && f.funcionario.nome); }, ['total_taxa_servico', 'total_comandas']);
    func.forEach(function (f) { f.ticket_medio_taxa = f.total_comandas ? f.total_taxa_servico / f.total_comandas : 0; });
    return {
      resumo: resumo,
      por_funcionario: comPercentual(func, 'total_taxa_servico', resumo.total_taxa_servico, 'percentual_do_total')
        .sort(desc('total_taxa_servico'))
    };
  };

  /* -------------------------------------------------------- vendas por canal */
  M.vendasCanal = function (parts) {
    var tg = somaCampos(parts.map(function (p) { return (p.data || {}).totaisGerais; }), ['quantidade', 'valor']);
    tg.ticketMedio = tg.quantidade ? tg.valor / tg.quantidade : 0;
    var canais = agrupar(juntar(parts, function (d) { return d.graficosFaturamentoPorCanal; }),
      function (c) { return normNome(c.canal); }, ['valor']);
    return { totaisGerais: tg, graficosFaturamentoPorCanal: comPercentual(canais, 'valor', tg.valor).sort(desc('valor')) };
  };

  /* ------------------------------------------------------------ sazonalidade */
  // Cada celula da loja e a MEDIA por dia dela; a celula consolidada e a soma dessas medias
  // (quanto as lojas vendem juntas num dia daqueles). null so quando nenhuma loja tem o dia.
  function somaGrades(grades) {
    var out = [];
    grades.forEach(function (g) {
      (g || []).forEach(function (l, i) {
        var o = out[i];
        if (!o) {
          o = out[i] = { semanaDoMes: l.semanaDoMes, diasDoMes: l.diasDoMes, quantidade: 0, mediaPorDia: null };
          DIAS.forEach(function (d) { o[d] = null; });
        }
        DIAS.forEach(function (d) { if (l[d] != null) o[d] = limpo(num(o[d]) + num(l[d])); });
        o.quantidade = limpo(o.quantidade + num(l.quantidade));
        if (l.mediaPorDia != null) o.mediaPorDia = limpo(num(o.mediaPorDia) + num(l.mediaPorDia));
      });
    });
    return out;
  }

  // Dias que formam cada media: o maior entre as lojas (a loja com mais dias abertos).
  function maxAmostra(amostras) {
    var out = [];
    amostras.forEach(function (a) {
      (a || []).forEach(function (l, i) {
        var o = out[i] || (out[i] = { semanaDoMes: l.semanaDoMes, diasDoMes: l.diasDoMes, dias: 0 });
        DIAS.forEach(function (d) { o[d] = Math.max(num(o[d]), num(l[d])); });
        o.dias = Math.max(o.dias, num(l.dias));
      });
    });
    return out;
  }

  // Bloco = { quantidade, mediaPorDia, grade, porTurno? } (produto, categoria, pedidos ou um turno).
  function somaBlocos(blocos) {
    var o = { quantidade: 0, mediaPorDia: null };
    blocos.forEach(function (b) {
      o.quantidade = limpo(o.quantidade + num(b.quantidade));
      if (b.mediaPorDia != null) o.mediaPorDia = limpo(num(o.mediaPorDia) + num(b.mediaPorDia));
    });
    o.grade = somaGrades(blocos.map(function (b) { return b.grade; }));
    var porChave = {}, ordem = [];
    blocos.forEach(function (b) {
      (b.porTurno || []).forEach(function (t) {
        if (!porChave[t.chave]) { porChave[t.chave] = []; ordem.push(t); }
        porChave[t.chave].push(t);
      });
    });
    if (ordem.length) {
      o.porTurno = ordem.map(function (t) {
        return Object.assign({ chave: t.chave, label: t.label }, somaBlocos(porChave[t.chave]));
      });
    }
    return o;
  }

  M.sazonalidade = function (parts, opts) {
    var modo = opt(opts);
    var datas = parts.map(function (p) { return p.data || {}; });
    var campo = datas.some(function (d) { return d.categorias; }) ? 'categorias' : 'produtos';
    var grupos = {}, ordem = [];
    datas.forEach(function (d) {
      (d[campo] || []).forEach(function (g) {
        var k = campo === 'produtos' ? produtoKey(g.produto, g.codigo, modo) : 'n:' + normNome(g.categoria);
        if (!grupos[k]) { grupos[k] = { base: g, blocos: [] }; ordem.push(k); }
        grupos[k].blocos.push(g);
      });
    });
    var turnos = {}, ordemTurnos = [];
    datas.forEach(function (d) {
      (d.turnos || []).forEach(function (t) {
        var o = turnos[t.chave];
        if (!o) {
          o = turnos[t.chave] = { chave: t.chave, label: t.label, horaInicio: t.horaInicio, horaFim: t.horaFim, diasComVenda: 0, amostras: [] };
          ordemTurnos.push(o);
        }
        o.diasComVenda = Math.max(o.diasComVenda, num(t.diasComVenda));
        o.amostras.push(t.diasNaAmostra);
      });
    });
    var out = {
      diasComVenda: Math.max.apply(null, datas.map(function (d) { return num(d.diasComVenda); }).concat(0)),
      diasNaAmostra: maxAmostra(datas.map(function (d) { return d.diasNaAmostra; })),
      pedidos: somaBlocos(datas.map(function (d) { return d.pedidos || {}; }))
    };
    if (ordemTurnos.length) {
      out.turnos = ordemTurnos.map(function (t) {
        var o = Object.assign({}, t, { diasNaAmostra: maxAmostra(t.amostras) });
        delete o.amostras;
        return o;
      });
    }
    out[campo] = ordem.map(function (k) {
      var b = grupos[k].base;
      return Object.assign({ produto: b.produto, codigo: b.codigo, categoria: b.categoria }, somaBlocos(grupos[k].blocos));
    }).sort(desc('quantidade'));
    return out;
  };

  LADBI.merge = M;
})();
