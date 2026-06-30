/* ==========================================================================
 * Camada de graficos sobre o Chart.js (carregado via CDN no index.html).
 * Mantem um registro para destruir/recriar ao trocar de periodo.
 * ========================================================================== */
window.LADBI = window.LADBI || {};

(function () {
  var fmt = LADBI.fmt;
  var registry = {};

  var PALETTE = [
    '#1a1fa0', '#f1591c', '#16a34a', '#0ea5e9', '#a855f7',
    '#0891b2', '#ea580c', '#4f46e5', '#15803d', '#db2777',
    '#2563eb', '#f59e0b', '#7c3aed', '#0d9488', '#e11d48'
  ];

  function ready() { return typeof window.Chart !== 'undefined'; }

  function applyDefaults() {
    if (!ready()) return;
    var css = getComputedStyle(document.body);
    var text = css.getPropertyValue('--text-soft').trim() || '#475569';
    var grid = css.getPropertyValue('--grid-line').trim() || 'rgba(148,163,184,.18)';
    Chart.defaults.font.family = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.color = text;
    Chart.defaults.borderColor = grid;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 8;
    Chart.defaults.plugins.legend.labels.boxHeight = 8;
  }

  function destroy(id) {
    if (registry[id]) { try { registry[id].destroy(); } catch (e) {} delete registry[id]; }
  }
  function destroyAll() { Object.keys(registry).forEach(destroy); }

  function colorsFor(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(PALETTE[i % PALETTE.length]);
    return out;
  }

  // Barra horizontal (ranking). valueFmt: 'money' | 'int'
  function horizontalBar(id, labels, values, opts) {
    opts = opts || {};
    destroy(id);
    var ctx = document.getElementById(id);
    if (!ctx || !ready()) return;
    var single = opts.color || '#1a1fa0';
    registry[id] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: opts.label || 'Valor',
          data: values,
          backgroundColor: opts.multicolor ? colorsFor(values.length) : single,
          borderRadius: 6,
          maxBarThickness: 26
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) {
                var v = c.parsed.x;
                var base = (opts.valueFmt === 'int') ? fmt.int(v) : fmt.money(v);
                if (opts.extra && opts.extra[c.dataIndex] != null) {
                  base += ' • ' + opts.extra[c.dataIndex];
                }
                return base;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { callback: function (v) { return opts.valueFmt === 'int' ? fmt.int(v) : fmt.moneyShort(v); } },
            grid: { display: true }
          },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // Rosca (formas de pagamento, distribuicoes)
  function doughnut(id, labels, values, opts) {
    opts = opts || {};
    destroy(id);
    var ctx = document.getElementById(id);
    if (!ctx || !ready()) return;
    registry[id] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colorsFor(values.length),
          borderWidth: 2,
          borderColor: getComputedStyle(document.body).getPropertyValue('--card-bg').trim() || '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              label: function (c) {
                var total = c.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                var pct = total ? (c.parsed / total * 100) : 0;
                return ' ' + c.label + ': ' + fmt.money(c.parsed) + ' (' + fmt.pct(pct) + ')';
              }
            }
          }
        }
      }
    });
  }

  LADBI.charts = {
    applyDefaults: applyDefaults,
    horizontalBar: horizontalBar,
    doughnut: doughnut,
    destroy: destroy,
    destroyAll: destroyAll,
    ready: ready,
    palette: PALETTE
  };
})();
