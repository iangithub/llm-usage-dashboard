'use strict';
// CSV rendering for the monthly report. Kept out of main.js so it can be
// exercised without Electron.

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// One row per project, one column per day, plus a per-day total row.
// `metric` picks whether the cells hold token counts or estimated USD.
function reportToCsv(report, metric) {
  const isCost = metric === 'cost';
  const val = (cell) => (isCost ? cell.cost.toFixed(4) : String(cell.total));
  const header = [
    '專案', '來源',
    ...report.days.map((d) => `${report.month}-${String(d.day).padStart(2, '0')}`),
    '合計',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const p of report.projects) {
    lines.push([p.project, p.providers.join('+'), ...p.days.map(val), val(p.total)]
      .map(csvCell).join(','));
  }
  lines.push(['每日合計', '', ...report.dayTotals.map(val), val(report.totals)]
    .map(csvCell).join(','));
  // BOM so Excel reads the Chinese headers as UTF-8 instead of mojibake
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { reportToCsv, csvCell };
