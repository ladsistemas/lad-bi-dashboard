/* ==========================================================================
 * Formatadores e utilitarios (moeda, datas, CSV).
 * ========================================================================== */
window.LADBI = window.LADBI || {};

(function () {
  var brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var intFmt = new Intl.NumberFormat('pt-BR');
  var dec1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function pad(n) { return String(n).padStart(2, '0'); }

  var fmt = {
    money: function (v) { return brl.format(num(v)); },
    int: function (v) { return intFmt.format(Math.round(num(v))); },
    qty: function (v) {
      var n = num(v);
      return Number.isInteger(n) ? intFmt.format(n) : dec1.format(n);
    },
    pct: function (v) { return dec1.format(num(v)) + '%'; },

    // Moeda abreviada para eixos/labels de grafico (ex.: R$ 1,2 mi)
    moneyShort: function (v) {
      var n = num(v);
      var abs = Math.abs(n);
      if (abs >= 1e6) return 'R$ ' + dec1.format(n / 1e6) + ' mi';
      if (abs >= 1e3) return 'R$ ' + dec1.format(n / 1e3) + ' mil';
      return brl.format(n);
    },

    // Trunca nomes longos para caber em labels
    truncate: function (s, max) {
      s = String(s == null ? '' : s);
      max = max || 22;
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    },

    // ISO yyyy-MM-dd'T'HH:mm:ss -> dd/MM/yyyy
    dateBR: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    },

    // Constroi string de data para a API (sem timezone): inicio do dia
    apiStart: function (date) {
      var d = (date instanceof Date) ? date : new Date(date);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T00:00:00';
    },
    // ... fim do dia
    apiEnd: function (date) {
      var d = (date instanceof Date) ? date : new Date(date);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T23:59:59';
    },
    // yyyy-MM-dd para inputs <input type="date">
    inputDate: function (date) {
      var d = (date instanceof Date) ? date : new Date(date);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    },

    // Exporta linhas (array de arrays) como CSV e dispara download
    downloadCSV: function (filename, headers, rows) {
      var sep = ';'; // Excel pt-BR usa ; como separador
      function esc(cell) {
        var s = (cell == null ? '' : String(cell));
        if (s.indexOf('"') >= 0 || s.indexOf(sep) >= 0 || s.indexOf('\n') >= 0) {
          s = '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }
      var lines = [];
      if (headers && headers.length) lines.push(headers.map(esc).join(sep));
      (rows || []).forEach(function (r) { lines.push(r.map(esc).join(sep)); });
      var csv = '﻿' + lines.join('\r\n'); // BOM p/ acentuacao no Excel
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  };

  LADBI.fmt = fmt;
})();
