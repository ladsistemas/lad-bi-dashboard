/* ==========================================================================
 * Exportacao das tabelas: Excel (.xlsx de verdade) e PDF.
 *
 * Excel: um xlsx e um zip de XMLs. Aqui vai um zip sem compressao (metodo
 * "stored") com 1 planilha, cabecalho em negrito e numeros como numeros.
 * PDF: pagina de impressao em um iframe oculto; o navegador salva como PDF
 * (destino "Salvar como PDF"). Sem biblioteca externa em nenhum dos dois.
 *
 * Coluna = { h: 'Titulo', t: 'text' | 'money' | 'int' | 'qty' | 'pct' | 'min' }.
 * Linhas = valores crus (numero como numero); null = celula vazia.
 * ========================================================================== */
window.LADBI = window.LADBI || {};

(function () {
  /* -------------------------------------------------------------------- zip */
  var CRC = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // files = [{ name, text }] -> array de partes binarias de um zip valido (UTF-8, sem compressao).
  function zipParts(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      var loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true);
      loc.setUint16(12, 33, true); // data DOS 01/01/1980
      loc.setUint32(14, crc, true); loc.setUint32(18, data.length, true); loc.setUint32(22, data.length, true);
      loc.setUint16(26, name.length, true);
      var cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true); cen.setUint16(14, 33, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      parts.push(new Uint8Array(loc.buffer), name, data);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cenSize = central.reduce(function (s, b) { return s + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return parts.concat(central, [new Uint8Array(end.buffer)]);
  }

  /* ------------------------------------------------------------------- xlsx */
  function xml(s) {
    return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '').replace(/[<>&"]/g, function (c) {
      return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c];
    });
  }
  function colRef(i) {
    var s = '';
    for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
  }
  // estilos: 0 normal, 1 negrito, 2 moeda (#,##0.00), 3 uma casa (0.0)
  var STYLE = { money: 2, pct: 3, qty: 3 };
  function cell(row, col, v, style) {
    if (v == null || v === '') return '';
    var ref = ' r="' + colRef(col) + row + '"' + (style ? ' s="' + style + '"' : '');
    if (typeof v === 'number' && isFinite(v)) return '<c' + ref + '><v>' + v + '</v></c>';
    return '<c' + ref + ' t="inlineStr"><is><t xml:space="preserve">' + xml(v) + '</t></is></c>';
  }

  var NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var PKG = 'http://schemas.openxmlformats.org/package/2006/';
  var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  // def = { titulo, subtitulo, colunas, linhas }
  function xlsxFiles(def) {
    var rows = [], r = 1;
    function push(cells) { rows.push('<row r="' + r + '">' + cells.join('') + '</row>'); r++; }
    push([cell(r, 0, def.titulo, 1)]);
    if (def.subtitulo) push([cell(r, 0, def.subtitulo, 0)]);
    r++; // linha em branco
    push(def.colunas.map(function (c, i) { return cell(r, i, c.h, 1); }));
    var largura = def.colunas.map(function (c) { return String(c.h).length; });
    def.linhas.forEach(function (l) {
      push(l.map(function (v, i) {
        var t = (def.colunas[i] || {}).t;
        if (t && t !== 'text' && v != null && v !== '' && isFinite(Number(v))) v = Number(v);
        largura[i] = Math.max(largura[i] || 0, String(v == null ? '' : v).length);
        return cell(r, i, v, typeof v === 'number' ? STYLE[t] : 0);
      }));
    });
    var cols = largura.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.min(60, Math.max(9, w + 3)) + '" customWidth="1"/>';
    }).join('');
    var nome = xml(String(def.titulo).replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31));
    return [
      { name: '[Content_Types].xml', text: HEAD + '<Types xmlns="' + PKG + 'content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>' },
      { name: '_rels/.rels', text: HEAD + '<Relationships xmlns="' + PKG + 'relationships">' +
        '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: HEAD + '<workbook xmlns="' + NS + '" xmlns:r="' + REL + '">' +
        '<sheets><sheet name="' + nome + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: HEAD + '<Relationships xmlns="' + PKG + 'relationships">' +
        '<Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="' + REL + '/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', text: HEAD + '<styleSheet xmlns="' + NS + '">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', text: HEAD + '<worksheet xmlns="' + NS + '"><cols>' + cols + '</cols>' +
        '<sheetData>' + rows.join('') + '</sheetData></worksheet>' }
    ];
  }

  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function xlsx(filename, def) {
    download(filename, new Blob(zipParts(xlsxFiles(def)),
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  /* -------------------------------------------------------------------- pdf */
  function html(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function exibir(v, t) {
    var fmt = LADBI.fmt;
    if (v == null || v === '') return t && t !== 'text' ? '—' : '';
    if (t === 'money') return fmt.money(v);
    if (t === 'pct') return fmt.pct(v);
    if (t === 'int') return fmt.int(v);
    if (t === 'qty') return fmt.qty(v);
    if (t === 'min') return fmt.int(v) + ' min';
    return v;
  }

  function pdf(def) {
    var num = function (c) { return c.t && c.t !== 'text'; };
    var doc = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + html(def.titulo) + '</title><style>' +
      '@page{size:A4 ' + (def.colunas.length > 6 ? 'landscape' : 'portrait') + ';margin:12mm}' +
      'body{font:11px/1.35 Inter,Segoe UI,Arial,sans-serif;color:#0f172a;margin:0}' +
      'h1{font-size:16px;margin:0 0 2px}p{margin:0 0 10px;color:#475569}' +
      'table{width:100%;border-collapse:collapse}th,td{padding:5px 7px;border-bottom:1px solid #e2e8f0;text-align:left}' +
      'th{font-size:10px;text-transform:uppercase;color:#475569;border-bottom:1.5px solid #94a3b8}' +
      '.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}tr{break-inside:avoid}' +
      'footer{margin-top:10px;font-size:9px;color:#94a3b8}' +
      '</style></head><body><h1>' + html(def.titulo) + '</h1><p>' + html(def.subtitulo || '') + '</p><table><thead><tr>' +
      def.colunas.map(function (c) { return '<th' + (num(c) ? ' class="n"' : '') + '>' + html(c.h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      def.linhas.map(function (l) {
        return '<tr>' + l.map(function (v, i) {
          var c = def.colunas[i] || {};
          return '<td' + (num(c) ? ' class="n"' : '') + '>' + html(exibir(v, c.t)) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table><footer>LAD BI · gerado em ' + html(new Date().toLocaleString('pt-BR')) + '</footer></body></html>';

    var fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    fr.onload = function () {
      // o nome sugerido do PDF vem do titulo da pagina que imprime
      var antes = document.title;
      document.title = def.titulo;
      var w = fr.contentWindow;
      var limpar = function () { document.title = antes; setTimeout(function () { fr.remove(); }, 1000); };
      w.onafterprint = limpar;
      w.focus(); w.print();
      setTimeout(limpar, 600000); // navegador que nao avisa o fim da impressao
    };
    fr.srcdoc = doc;
    document.body.appendChild(fr);
  }

  LADBI.exporter = { xlsx: xlsx, pdf: pdf, xlsxFiles: xlsxFiles, zipParts: zipParts };
})();
