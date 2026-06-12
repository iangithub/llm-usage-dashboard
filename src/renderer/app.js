'use strict';

// ---------- formatting helpers ----------
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function usd(n) { return '$' + (n || 0).toFixed(2); }

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
  const reset = resetMs ? `<span class="l-reset" data-reset="${resetMs}">${durUntil(resetMs)}</span>` : '<span class="l-reset"></span>';
  const bar = pct != null
    ? `<div class="bar ${color}${hot}"><span style="width:${Math.min(100, pct)}%"></span></div>`
    : `<div class="bar ${color}"><span style="width:100%;opacity:.18"></span></div>`;
  return `<div class="limit">
    <div class="limit-top"><span class="l-name">${name}</span>${reset}<span class="l-pct">${right}</span></div>
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
  if (codex.rate && codex.rate.primary) {
    cl.push(limitRow({ name: '5 小時額度', pct: codex.rate.primary.used_percent, resetMs: codex.rate.primary.resets_at * 1000, color: 'codex' }));
  }
  if (codex.rate && codex.rate.secondary) {
    cl.push(limitRow({ name: '每週額度', pct: codex.rate.secondary.used_percent, resetMs: codex.rate.secondary.resets_at * 1000, color: 'codex' }));
  }
  if (!cl.length) cl.push('<div class="note">尚無 Codex 額度資料(找不到 token_count 事件)。</div>');
  document.getElementById('codex-limits').innerHTML = cl.join('');
  document.getElementById('codex-today').textContent = fmtTokens(codex.today.total);
  document.getElementById('codex-month').textContent = fmtTokens(codex.monthly.total);
  document.getElementById('codex-cost').textContent = usd(codex.monthly.cost);
  document.getElementById('codex-note').textContent = '額度 % 與重置時間為 Codex 官方記錄(精確)。花費為依模型單價估算之參考值。';

  // ---- Claude card ----
  const sub = claude.subscription;
  document.getElementById('claude-plan').textContent = sub ? sub.subscriptionType : 'claude';
  const cll = [];
  cll.push(limitRow({ name: '5 小時區塊用量', pct: null, resetMs: claude.block5hResetMs, color: 'claude', value: fmtTokens(claude.window5h.total) + ' tok' }));
  cll.push(limitRow({ name: '近 7 天用量', pct: null, resetMs: null, color: 'claude', value: fmtTokens(claude.weekly.total) + ' tok' }));
  document.getElementById('claude-limits').innerHTML = cll.join('');
  document.getElementById('claude-today').textContent = fmtTokens(claude.today.total);
  document.getElementById('claude-month').textContent = fmtTokens(claude.monthly.total);
  document.getElementById('claude-cost').textContent = usd(claude.monthly.cost);

  // ---- chart (14 days, stacked) ----
  renderChart(codex.daily, claude.daily);

  // ---- projects ----
  renderProjects(m.projects);
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
    html += `<div class="col" title="${tip}">
      <div class="stack">
        <div class="seg-codex" style="height:${ch}px"></div>
        <div class="seg-claude" style="height:${ah}px"></div>
      </div>
      <div class="x">${label.slice(3)}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function renderProjects(projects) {
  const body = document.getElementById('proj-body');
  document.getElementById('proj-count').textContent = `${projects.length} 個專案`;
  if (!projects.length) { body.innerHTML = '<tr><td colspan="6" class="note">尚無資料</td></tr>'; return; }
  body.innerHTML = projects.map((p) => {
    const tags = Object.keys(p.byProvider).map((k) => `<span class="src-tag src-${k}">${k}</span>`).join('');
    return `<tr>
      <td title="${p.project}">${p.label}</td>
      <td>${tags}</td>
      <td class="num">${fmtTokens(p.all.total)}</td>
      <td class="num">${fmtTokens(p.month.total)}</td>
      <td class="num">${usd(p.month.cost)}</td>
      <td>${lastActive(p.lastTs)}</td>
    </tr>`;
  }).join('');
}

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
