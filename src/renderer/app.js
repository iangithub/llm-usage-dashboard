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

// Codex reports each limit's window length in minutes (5h, weekly, or 30 days
// on some plans) — name the row from the actual window instead of hardcoding.
function codexWindowName(windowMinutes, fallback) {
  if (!windowMinutes) return fallback;
  if (windowMinutes === 10080) return '每週額度';
  if (windowMinutes % 1440 === 0 && windowMinutes >= 2880) return `${windowMinutes / 1440} 天額度`;
  return `${Math.round(windowMinutes / 60)} 小時額度`;
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
  const antigravity = m.providers.antigravity;

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
    const w = codex.rate.primary;
    cl.push(limitRow({ name: codexWindowName(w.window_minutes, '5 小時額度'), pct: w.used_percent, resetMs: w.resets_at * 1000, color: 'codex' }));
  }
  if (codex.rate && codex.rate.secondary) {
    const w = codex.rate.secondary;
    cl.push(limitRow({ name: codexWindowName(w.window_minutes, '每週額度'), pct: w.used_percent, resetMs: w.resets_at * 1000, color: 'codex' }));
  }
  if (!cl.length) cl.push('<div class="note">尚無 Codex 額度資料(找不到 rate_limits 記錄)。</div>');
  document.getElementById('codex-limits').innerHTML = cl.join('');
  document.getElementById('codex-today').textContent = fmtTokens(codex.today.total);
  document.getElementById('codex-month').textContent = fmtTokens(codex.monthly.total);
  document.getElementById('codex-cost').textContent = usd(codex.monthly.cost);
  const snapAt = codex.rate && codex.rate.tsMs ? `額度快照：${new Date(codex.rate.tsMs).toLocaleString()}。` : '';
  document.getElementById('codex-note').textContent = `額度 % 與重置時間為 Codex 官方記錄(精確)。${snapAt}花費為依模型單價估算之參考值。`;

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

  // ---- Antigravity card ----
  const agLimits = [];
  if (antigravity && (antigravity.active || antigravity.stale)) {
    document.getElementById('antigravity-plan').textContent =
      (antigravity.planName || 'Hub') + (antigravity.stale ? '・快取' : '');
    document.getElementById('antigravity-plan-name').textContent = antigravity.planName || 'Hub';

    const pCredits = antigravity.promptCredits;
    const fCredits = antigravity.flowCredits;

    if (pCredits && pCredits.monthly) {
      document.getElementById('antigravity-available-credits').textContent = fmtTokens(pCredits.available);
      agLimits.push(limitRow({
        name: 'Prompts 點數額度',
        pct: pCredits.pct,
        resetMs: null,
        color: 'antigravity',
        value: `${fmtTokens(pCredits.available)} / ${fmtTokens(pCredits.monthly)}`
      }));
    } else {
      document.getElementById('antigravity-available-credits').textContent = '無限制';
    }

    if (fCredits && fCredits.monthly) {
      document.getElementById('antigravity-available-flows').textContent = fmtTokens(fCredits.available);
      agLimits.push(limitRow({
        name: 'Flows 點數額度',
        pct: fCredits.pct,
        resetMs: null,
        color: 'antigravity',
        value: `${fmtTokens(fCredits.available)} / ${fmtTokens(fCredits.monthly)}`
      }));
    } else {
      document.getElementById('antigravity-available-flows').textContent = '無限制';
    }

    if (antigravity.models && antigravity.models.length) {
      for (const mObj of antigravity.models) {
        agLimits.push(limitRow({
          name: mObj.label,
          pct: 100 - mObj.remaining_percentage,
          resetMs: antigravity.stale ? null : mObj.reset_time,
          color: 'antigravity'
        }));
      }
    }
    document.getElementById('antigravity-note').textContent = antigravity.stale
      ? `Antigravity 未執行 — 顯示 ${new Date(antigravity.cachedAt).toLocaleString()} 的快取資料。點「▶ 啟動」取得即時額度。`
      : '額度與模型配額為 Antigravity 官方伺服器實時數據。';
  } else {
    document.getElementById('antigravity-plan').textContent = 'OFFLINE';
    document.getElementById('antigravity-plan-name').textContent = '未啟用';
    document.getElementById('antigravity-available-credits').textContent = '—';
    document.getElementById('antigravity-available-flows').textContent = '—';
    const errMsg = (antigravity && antigravity.message) ? antigravity.message : '請啟動 Antigravity IDE。';
    agLimits.push(`<div class="note" style="color: var(--danger)">${errMsg}</div>`);
    document.getElementById('antigravity-note').textContent = '點「▶ 啟動」開啟 Antigravity 後即會自動更新額度。';
  }
  document.getElementById('antigravity-limits').innerHTML = agLimits.join('');

  // ---- chart (14 days, stacked) ----
  renderChart(codex.daily, claude.daily, antigravity ? antigravity.daily : null);

  // ---- projects ----
  renderProjects(m.projects);
}

function renderChart(codexDaily, claudeDaily, antigravityDaily) {
  const el = document.getElementById('chart');
  const n = Math.max(codexDaily.length, claudeDaily.length, antigravityDaily ? antigravityDaily.length : 0);
  let max = 1;
  for (let i = 0; i < n; i++) {
    const t = (codexDaily[i]?.total || 0) + (claudeDaily[i]?.total || 0) + (antigravityDaily?.[i]?.total || 0);
    if (t > max) max = t;
  }
  let html = '';
  for (let i = 0; i < n; i++) {
    const c = codexDaily[i]?.total || 0;
    const a = claudeDaily[i]?.total || 0;
    const ag = antigravityDaily?.[i]?.total || 0;
    const label = codexDaily[i]?.label || claudeDaily[i]?.label || antigravityDaily?.[i]?.label || '';
    const ch = Math.round((c / max) * 140);
    const ah = Math.round((a / max) * 140);
    const agh = Math.round((ag / max) * 140);
    const tip = `${label}\nCodex ${fmtTokens(c)} / Claude ${fmtTokens(a)} / Antigravity ${fmtTokens(ag)}`;
    html += `<div class="col" title="${tip}">
      <div class="stack">
        <div class="seg-codex" style="height:${ch}px"></div>
        <div class="seg-claude" style="height:${ah}px"></div>
        <div class="seg-antigravity" style="height:${agh}px"></div>
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

document.querySelectorAll('.launch').forEach((b) => {
  b.addEventListener('click', async () => {
    const orig = b.textContent;
    b.disabled = true; b.textContent = '啟動中…';
    let failMsg = null;
    try {
      const res = await window.api.launchTool(b.dataset.tool);
      if (res && !res.ok) failMsg = res.error || '啟動失敗';
    } catch { failMsg = '啟動失敗'; }
    if (failMsg) {
      b.textContent = failMsg;
      setTimeout(() => { b.textContent = orig; b.disabled = false; }, 3000);
    } else {
      b.textContent = orig;
      b.disabled = false;
    }
  });
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
