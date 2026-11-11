/* Check rodavel da consolidacao multiloja e do xlsx: `node test/merge.test.js`.
 * Com um caminho no 1o argumento, grava o xlsx de exemplo nele (para abrir no Excel). */
var assert = require('assert');
global.window = global;
require('../assets/js/merge.js');
require('../assets/js/exporter.js');
var M = LADBI.merge;

function prod(id, codigo, nome, qtd, valor) {
  return { produto: { id: id, codigo: codigo, nome: nome }, quantidade: qtd, valorTotal: valor };
}
function loja(id, faturado, comandas, mais, menos) {
  return {
    empresa: { idEmpresa: id },
    data: {
      resumo: { totalFaturado: faturado, totalComandas: comandas },
      rc: {
        produtos_mais_vendidos: mais, produtos_menos_vendidos: menos,
        vendedores_ranking: [{ vendedor: { id: id, nome: id === 1 ? 'Ana  Souza' : 'ANA SOUZA' }, quantidadeVendas: 10, valorTotal: 100 }],
        recebimentos_por_forma: [{ forma: { nome: id === 1 ? 'Crédito' : 'CREDITO' }, quantidade: 5, valor: 50 }]
      }
    }
  };
}

// Mesmo produto com id diferente em cada loja: nome igual (com acento/caixa diferente) e,
// num caso, mesmo codigo com nome diferente.
var partes = [
  loja(1, 1000, 10,
    [prod(11, 100, 'Combinado 60 Peças', 4, 400), prod(12, 200, 'Poke Salmão', 3, 90)],
    [prod(13, 300, 'Água', 0, 0), prod(12, 200, 'Poke Salmão', 3, 90)]),
  loja(2, 3000, 30,
    [prod(21, 100, 'COMBINADO 60 PECAS', 6, 600), prod(22, 200, 'Poke de Salmão', 5, 150)],
    [prod(23, 300, 'agua', 1, 5)])
];

var porNome = M.caixa(partes, { produtoPor: 'nome' });
assert.strictEqual(porNome.resumo_geral.totalFaturado, 4000);
assert.strictEqual(porNome.resumo_geral.ticketMedio, 100);
var top = porNome.ranking_consolidado.produtos_mais_vendidos;
assert.strictEqual(top[0].valorTotal, 1000, 'combinado soma as duas lojas pelo nome');
assert.strictEqual(top[0].quantidade, 10);
assert.strictEqual(top[0].percentual, 25);
assert.strictEqual(top.length, 4, 'poke fica separado por nome: os nomes diferem');
assert.strictEqual(top.filter(function (p) { return /poke/i.test(p.produto.nome); })[0].valorTotal, 150,
  'produto repetido em mais e menos vendidos da mesma loja conta uma vez');

var porCodigo = M.caixa(partes, { produtoPor: 'codigo' });
var topCod = porCodigo.ranking_consolidado.produtos_mais_vendidos;
assert.strictEqual(topCod.length, 3, 'por codigo o poke das duas lojas vira um');
assert.strictEqual(topCod[1].valorTotal, 240);
var menos = porCodigo.ranking_consolidado.produtos_menos_vendidos;
assert.strictEqual(menos[0].produto.nome, 'Água');
assert.strictEqual(menos[0].valorTotal, 5);
assert.ok(menos.every(function (p) { return p.produto.codigo !== 100; }), 'so entra em menos vendidos quem veio do cadastro');
assert.strictEqual(porCodigo.ranking_consolidado.vendedores_ranking.length, 1, 'garcom agrupa pelo nome');
assert.strictEqual(porCodigo.ranking_consolidado.vendedores_ranking[0].ticketMedio, 10);
assert.strictEqual(porCodigo.ranking_consolidado.recebimentos_por_forma[0].valor, 100);

// loja sem movimento (rc null) nao quebra a soma
assert.strictEqual(M.caixa(partes.concat([{ empresa: {}, data: { resumo: {}, rc: null } }])).resumo_geral.totalFaturado, 4000);

// sazonalidade: celula = soma das medias; null so se nenhuma loja tem o dia; turnos pela chave
function grade(seg, ter) { return [{ semanaDoMes: 1, diasDoMes: '1 a 7', seg: seg, ter: ter, quantidade: 10, mediaPorDia: 2 }]; }
function saz(nome, codigo, seg, ter, dias) {
  return {
    data: {
      diasComVenda: dias, diasNaAmostra: [{ semanaDoMes: 1, diasDoMes: '1 a 7', seg: dias, ter: 0, dias: dias }],
      pedidos: { quantidade: 50, mediaPorDia: 5, grade: grade(5, null) },
      turnos: [{ chave: 'noite', label: 'Noite', diasComVenda: dias, diasNaAmostra: [{ semanaDoMes: 1, seg: dias, dias: dias }] }],
      produtos: [{ produto: nome, codigo: codigo, quantidade: 10, mediaPorDia: 2, grade: grade(seg, ter),
        porTurno: [{ chave: 'noite', label: 'Noite', quantidade: 6, mediaPorDia: 1.5, grade: grade(seg, null) }] }]
    }
  };
}
var s = M.sazonalidade([saz('Poke', 7, 3, null, 3), saz('poke', 7, 4, null, 4)], { produtoPor: 'nome' });
assert.strictEqual(s.produtos.length, 1);
assert.strictEqual(s.produtos[0].grade[0].seg, 7);
assert.strictEqual(s.produtos[0].grade[0].ter, null);
assert.strictEqual(s.produtos[0].mediaPorDia, 4);
assert.strictEqual(s.produtos[0].porTurno[0].quantidade, 12);
assert.strictEqual(s.diasNaAmostra[0].seg, 4);
assert.strictEqual(s.turnos[0].diasNaAmostra[0].seg, 4);
assert.strictEqual(s.pedidos.grade[0].seg, 10);

// demais fontes: derivado e recalculado, nao somado
var tx = M.taxaServico([
  { data: { resumo: { total_taxa_servico: 100, total_comandas: 10, percentual_medio: 10 }, por_funcionario: [] } },
  { data: { resumo: { total_taxa_servico: 300, total_comandas: 30, percentual_medio: 12 }, por_funcionario: [] } }]);
assert.strictEqual(tx.resumo.ticket_medio_taxa, 10);
// 100 a 10% (base 1000) + 300 a 12% (base 2500) = 400 sobre 3500
assert.ok(Math.abs(tx.resumo.percentual_medio - 400 / 35) < 1e-9, String(tx.resumo.percentual_medio));
var dre = M.dre([{ data: { resumo: { receitaLiquida: 100, totalDespesas: 60, resultadoLiquido: 40, margemLiquida: 40 } } },
  { data: { resumo: { receitaLiquida: 100, totalDespesas: 100, resultadoLiquido: 0, margemLiquida: 0 } } }]);
assert.strictEqual(dre.resumo.margemLiquida, 20);

// xlsx: zip valido com as 6 partes e numero gravado como numero
var def = {
  titulo: 'Produtos mais vendidos', subtitulo: 'Lojas: A + B',
  colunas: [{ h: 'Produto', t: 'text' }, { h: 'Qtd', t: 'qty' }, { h: 'Valor', t: 'money' }],
  linhas: [['Poke <Salmão> & cia', 3.5, 1234.56], ['Água', null, 0]]
};
var files = LADBI.exporter.xlsxFiles(def);
var sheet = files[files.length - 1].text;
assert.ok(sheet.indexOf('<c r="C5" s="2"><v>1234.56</v></c>') > 0, sheet);
assert.ok(sheet.indexOf('Poke &lt;Salmão&gt; &amp; cia') > 0);
var bytes = Buffer.concat(LADBI.exporter.zipParts(files).map(function (p) { return Buffer.from(p); }));
assert.strictEqual(bytes.readUInt32LE(0), 0x04034b50);
assert.strictEqual(bytes.readUInt16LE(bytes.length - 22 + 10), 6, 'entradas no diretorio central');
if (process.argv[2]) require('fs').writeFileSync(process.argv[2], bytes);

console.log('ok');
