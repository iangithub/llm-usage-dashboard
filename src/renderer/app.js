'use strict';

// ---------- formatting helpers ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function usd(n) { return '$' + (n || 0).toFixed(2); }

// Human label for a Codex rate-limit window, derived from window_minutes rather
// than from the primary/secondary slot (Codex has swapped their meaning between
// CLI versions).
function windowLabel(min) {
  if (min == null) return '額度';
  if (min % 10080 === 0) {
    const w = min / 10080;
    return w === 1 ? '每週額度' : `每 ${w} 週額度`;
  }
  if (min % 1440 === 0) return `${min / 1440} 天額度`;
  if (min % 60 === 0) return `${min / 60} 小時額度`;
  return `${min} 分鐘額度`;
}

function durUntil(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return '已重置';
  const m = Math.floor(d / 60000);
  const h = Math.floor(m / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `${days}天${h % 24}小時後重置`;
  if (h >= 1) return `${h}小時${m % 60}分後重置`;
  return `${m}分後重置`;
}
function relTime(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s} 秒前更新`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前更新`;
  return new Date(ms).toLocaleString();
}
function lastActive(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return new Date(ms).toLocaleDateString();
}

// ---------- limit row ----------
function limitRow({ name, pct, resetMs, color, value }) {
  const hot = pct != null && pct >= 85 ? ' hot' : '';
  const right = pct != null ? `${Math.round(pct)}%` : (value || '');
  const reset = resetMs
    ? `<span class="l-reset" data-reset="${resetMs}">${esc(durUntil(resetMs))}</span>`
    : '<span class="l-reset"></span>';
  const bar = pct != null
    ? `<div class="bar ${color}${hot}"><span style="width:${Math.min(100, Math.max(0, pct))}%"></span></div>`
    : `<div class="bar ${color}"><span style="width:100%;opacity:.18"></span></div>`;
  return `<div class="limit">
    <div class="limit-top"><span class="l-name">${esc(name)}</span>${reset}<span class="l-pct">${esc(right)}</span></div>
    ${bar}
  </div>`;
}

// ---------- render ----------
let model = null;

function render(m) {
  model = m;
  const codex = m.providers.codex;
  const claude = m.providers.claude;

  // totals
  document.getElementById('t-cost').textContent = usd(m.totals.monthCost);
  document.getElementById('t-tokens').textContent = fmtTokens(m.totals.monthTokens);
  document.getElementById('t-all').textContent = usd(m.totals.allCost);
  document.getElementById('updated').textContent = relTime(m.generatedAt);
  document.getElementById('nextauto').textContent = nextAutoText();

  // ---- Codex card ----
  document.getElementById('codex-plan').textContent = codex.planType || 'codex';
  const cl = [];
  const windows = (codex.rate && codex.rate.windows) || [];
  for (const w of windows) {
    cl.push(limitRow({
      name: windowLabel(w.windowMinutes),
      pct: w.usedPercent,
      resetMs: w.resetsAtMs,
      color: 'codex',
    }));
  }
  if (!cl.length) cl.push('<div class="note">尚無 Codex 額度資料(找不到 token_count 事件)。</div>');
  document.getElementById('codex-limits').innerHTML = cl.join('');
  document.getElementById('codex-today').textContent = fmtTokens(codex.today.total);
  document.getElementById('codex-month').textContent = fmtTokens(codex.monthly.total);
  document.getElementById('codex-cost').textContent = usd(codex.monthly.cost);
  document.getElementById('codex-note').textContent =
    '額度 % 與重置時間為 Codex 官方記錄(精確),視窗長度依 Codex 回報的 window_minutes 標示。花費為依模型單價估算之參考值。';

  // ---- Claude card ----
  const sub = claude.subscription;
  document.getElementById('claude-plan').textContent =
    (sub && sub.subscriptionType) || 'claude';
  const cll = [];
  cll.push(limitRow({ name: '5 小時區塊用量', pct: null, resetMs: claude.block5hResetMs, color: 'claude', value: fmtTokens(claude.window5h.total) + ' tok' }));
  cll.push(limitRow({ name: '近 7 天用量', pct: null, resetMs: null, color: 'claude', value: fmtTokens(claude.weekly.total) + ' tok' }));
  document.getElementById('claude-limits').innerHTML = cll.join('');
  document.getElementById('claude-today').textContent = fmtTokens(claude.today.total);
  document.getElementById('claude-month').textContent = fmtTokens(claude.monthly.total);
  document.getElementById('claude-cost').textContent = usd(claude.monthly.cost);

  // ---- unpriced models warning ----
  const warn = document.getElementById('pricing-warn');
  const unpriced = m.unpricedModels || [];
  if (unpriced.length) {
    warn.textContent = `⚠ 下列模型無單價資料,花費以 $0 計入:${unpriced.join('、')}(可在 assets/pricing.json 補上)`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  // ---- chart (14 days, stacked) ----
  renderChart(codex.daily, claude.daily);

  // ---- projects ----
  renderProjects(m.projects);

  // ---- monthly report ----
  syncReport(m);
}

function renderChart(codexDaily, claudeDaily) {
  const el = document.getElementById('chart');
  const n = Math.max(codexDaily.length, claudeDaily.length);
  let max = 1;
  for (let i = 0; i < n; i++) {
    const t = (codexDaily[i]?.total || 0) + (claudeDaily[i]?.total || 0);
    if (t > max) max = t;
  }
  let html = '';
  for (let i = 0; i < n; i++) {
    const c = codexDaily[i]?.total || 0;
    const a = claudeDaily[i]?.total || 0;
    const label = codexDaily[i]?.label || claudeDaily[i]?.label || '';
    const ch = Math.round((c / max) * 140);
    const ah = Math.round((a / max) * 140);
    const tip = `${label}\nCodex ${fmtTokens(c)} / Claude ${fmtTokens(a)}`;
    html += `<div class="col" title="${esc(tip)}">
      <div class="stack">
        <div class="seg-codex" style="height:${ch}px"></div>
        <div class="seg-claude" style="height:${ah}px"></div>
      </div>
      <div class="x">${esc(label.slice(3))}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function renderProjects(projects) {
  const body = document.getElementById('proj-body');
  document.getElementById('proj-count').textContent = `${projects.length} 個專案`;
  if (!projects.length) { body.innerHTML = '<tr><td colspan="6" class="note">尚無資料</td></tr>'; return; }
  body.innerHTML = projects.map((p) => {
    const tags = Object.keys(p.byProvider).map((k) => `<span class="src-tag src-${esc(k)}">${esc(k)}</span>`).join('');
    return `<tr>
      <td title="${esc(p.project)}">${esc(p.label)}</td>
      <td>${tags}</td>
      <td class="num">${fmtTokens(p.all.total)}</td>
      <td class="num">${fmtTokens(p.month.total)}</td>
      <td class="num">${usd(p.month.cost)}</td>
      <td>${esc(lastActive(p.lastTs))}</td>
    </tr>`;
  }).join('');
}

// ---------- monthly report ----------
const rp = {
  month: null,      // 'YYYY-MM'; null = follow the newest month with data
  metric: 'tokens', // 'tokens' | 'cost'
  provider: 'all',  // 'all' | 'codex' | 'claude'
  months: [],       // available months, newest first
  data: null,
  loading: false,
};

function rpCellValue(cell) { return rp.metric === 'cost' ? cell.cost : cell.total; }
function rpFormat(v) {
  if (!v) return '';
  return rp.metric === 'cost' ? (v < 0.01 ? '<0.01' : v.toFixed(2)) : fmtTokens(v);
}

let rpMonthOptionsKey = '';
function renderMonthOptions() {
  const sel = document.getElementById('rp-month');
  // only rebuild when the set of months actually changed, so a background
  // refresh does not close the dropdown while the user is picking a month
  const key = rp.months.map((m) => m.key).join(',');
  if (key !== rpMonthOptionsKey) {
    rpMonthOptionsKey = key;
    sel.innerHTML = rp.months.map((m) => `<option value="${esc(m.key)}">${esc(m.key)}</option>`).join('');
  }
  if (rp.month) sel.value = rp.month;
  const idx = rp.months.findIndex((m) => m.key === rp.month);
  // months are newest-first, so "previous month" moves further down the list
  document.getElementById('rp-prev').disabled = idx < 0 || idx >= rp.months.length - 1;
  document.getElementById('rp-next').disabled = idx <= 0;
}

function renderReport() {
  const table = document.getElementById('rp-table');
  const summary = document.getElementById('rp-summary');
  const note = document.getElementById('rp-note');
  const d = rp.data;
  if (!d) { table.innerHTML = ''; summary.innerHTML = ''; return; }

  const isCost = rp.metric === 'cost';
  const unit = isCost ? 'USD(估)' : 'tokens';
  summary.innerHTML = [
    `${esc(d.month)} 總用量 <b>${esc(fmtTokens(d.totals.total))}</b>`,
    `預估花費 <b>${esc(usd(d.totals.cost))}</b>`,
    `有活動天數 <b>${d.activeDays}/${d.days.length}</b>`,
    `專案 <b>${d.projects.length}</b>`,
  ].map((s) => `<span>${s}</span>`).join('');

  if (!d.projects.length) {
    table.innerHTML = `<tbody><tr><td class="rp-empty">${esc(d.month)} 沒有${rp.provider === 'all' ? '' : esc(rp.provider) + ' 的'}使用紀錄</td></tr></tbody>`;
    note.textContent = '';
    return;
  }

  const max = isCost ? d.maxCellCost : d.maxCellTotal;
  const cell = (c, i) => {
    const v = rpCellValue(c);
    const cls = ['rp-day'];
    if (i === d.todayIndex) cls.push('rp-today');
    if (!v) cls.push('rp-zero');
    // heat scales with the square root so small-but-real days stay visible
    const heat = v > 0 && max > 0 ? Math.min(1, Math.sqrt(v / max)) : 0;
    const bg = heat ? ` style="background:rgba(96,165,250,${(heat * 0.42).toFixed(3)})"` : '';
    const title = v
      ? `${d.month}-${String(i + 1).padStart(2, '0')} · ${fmtTokens(c.total)} tok · ${usd(c.cost)} · ${c.count} 次`
      : '';
    return `<td class="${cls.join(' ')}"${bg}${title ? ` title="${esc(title)}"` : ''}>${esc(rpFormat(v)) || '·'}</td>`;
  };

  const head = `<thead><tr>
    <th class="rp-name">專案</th>
    ${d.days.map((day, i) => {
      const cls = ['rp-day'];
      if (day.weekday === 0 || day.weekday === 6) cls.push('rp-weekend');
      if (i === d.todayIndex) cls.push('rp-today');
      return `<th class="${cls.join(' ')}">${day.day}</th>`;
    }).join('')}
    <th class="rp-sum">合計</th>
  </tr></thead>`;

  const body = `<tbody>${d.projects.map((p) => {
    const tags = p.providers.map((k) => `<span class="src-tag src-${esc(k)}">${esc(k)}</span>`).join('');
    return `<tr>
      <td class="rp-name" title="${esc(p.project)}">${tags}${esc(p.label)}</td>
      ${p.days.map(cell).join('')}
      <td class="rp-sum">${esc(rpFormat(rpCellValue(p.total))) || '·'}</td>
    </tr>`;
  }).join('')}</tbody>`;

  const foot = `<tfoot><tr>
    <td class="rp-name">每日合計</td>
    ${d.dayTotals.map((c, i) => {
      const v = rpCellValue(c);
      const cls = 'rp-day' + (i === d.todayIndex ? ' rp-today' : '') + (v ? '' : ' rp-zero');
      return `<td class="${cls}">${esc(rpFormat(v)) || '·'}</td>`;
    }).join('')}
    <td class="rp-sum">${esc(rpFormat(rpCellValue(d.totals))) || '·'}</td>
  </tr></tfoot>`;

  // a file-watch refresh re-renders this table; keep the user where they were
  const scroller = table.parentElement;
  const left = scroller.scrollLeft;
  const top = scroller.scrollTop;
  table.innerHTML = head + body + foot;
  scroller.scrollLeft = left;
  scroller.scrollTop = top;

  note.textContent = `數字單位:${unit}。格子顏色深淺代表當日用量相對強度,滑過可看 tokens / 花費 / 請求次數。花費為依模型單價估算之參考值。`;
}

async function loadReport() {
  if (rp.loading || !rp.month) return;
  rp.loading = true;
  try {
    rp.data = await window.api.getReport(rp.month, rp.provider);
    renderMonthOptions();
    renderReport();
  } catch (e) {
    console.error('[report]', e);
  } finally {
    rp.loading = false;
  }
}

// Called on every model update: keeps the picker in sync and reloads the matrix
// so a running dashboard shows today's activity as it accumulates.
function syncReport(m) {
  rp.months = m.months || [];
  if (!rp.months.length) { rp.month = null; rp.data = null; renderMonthOptions(); renderReport(); return; }
  // default to the current month when it has data, otherwise the newest month
  if (!rp.month || !rp.months.some((x) => x.key === rp.month)) {
    rp.month = rp.months.some((x) => x.key === m.currentMonth) ? m.currentMonth : rp.months[0].key;
  }
  loadReport();
}

function stepMonth(delta) {
  const idx = rp.months.findIndex((x) => x.key === rp.month);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= rp.months.length) return;
  rp.month = rp.months[next].key;
  loadReport();
}

function wireSeg(id, apply) {
  const root = document.getElementById(id);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn || btn.classList.contains('on')) return;
    root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    apply(btn.dataset.v);
  });
}

document.getElementById('rp-prev').addEventListener('click', () => stepMonth(1));  // older
document.getElementById('rp-next').addEventListener('click', () => stepMonth(-1)); // newer
document.getElementById('rp-month').addEventListener('change', (e) => {
  rp.month = e.target.value;
  loadReport();
});
wireSeg('rp-metric', (v) => { rp.metric = v; renderReport(); });
wireSeg('rp-provider', (v) => { rp.provider = v; loadReport(); });

const csvBtn = document.getElementById('rp-csv');
csvBtn.addEventListener('click', async () => {
  if (!rp.month) return;
  csvBtn.disabled = true;
  const label = csvBtn.textContent;
  csvBtn.textContent = '匯出中…';
  try {
    const res = await window.api.exportReport(rp.month, rp.provider, rp.metric);
    csvBtn.textContent = res && res.ok ? '已匯出 ✓' : label;
    if (res && res.ok) setTimeout(() => { csvBtn.textContent = label; }, 2000);
  } catch (e) {
    console.error('[report] export', e);
    csvBtn.textContent = label;
  } finally {
    csvBtn.disabled = false;
  }
});

// ---------- tickers ----------
function nextAutoText() {
  if (!model || !model.nextAutoRefreshAt) return '';
  const d = model.nextAutoRefreshAt - Date.now();
  if (d <= 0) return '· 自動更新中…';
  const m = Math.floor(d / 60000), s = Math.floor((d % 60000) / 1000);
  return `· 每 5 分自動更新(下次 ${m}:${String(s).padStart(2, '0')})`;
}

setInterval(() => {
  document.querySelectorAll('.l-reset[data-reset]').forEach((el) => {
    el.textContent = durUntil(Number(el.dataset.reset));
  });
  if (model) {
    document.getElementById('updated').textContent = relTime(model.generatedAt);
    document.getElementById('nextauto').textContent = nextAutoText();
  }
}, 1000);

// ---------- wire up ----------
const btn = document.getElementById('refresh');
btn.addEventListener('click', async () => {
  btn.disabled = true; btn.textContent = '更新中…';
  try { const m = await window.api.refresh(); if (m) render(m); }
  finally { btn.disabled = false; btn.textContent = '重新整理'; }
});

const auto = document.getElementById('autostart');
auto.addEventListener('change', async () => { auto.checked = await window.api.setAutostart(auto.checked); });
window.api.onAutostartChanged((on) => { auto.checked = on; });

window.api.onUpdate((m) => render(m));

(async () => {
  try {
    auto.checked = await window.api.getAutostart();
    const m = await window.api.get();
    if (m) render(m);
  } catch (e) { console.error(e); }
})();
