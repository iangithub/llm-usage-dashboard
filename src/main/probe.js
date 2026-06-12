'use strict';
// Standalone sanity check (no Electron). Run: npm run probe
// Verifies the collectors + aggregation against real local data.
const { collectCodex } = require('./collectors/codex');
const { collectClaude } = require('./collectors/claude');
const { buildModel } = require('./aggregate');

function fmt(n) { return Number(n).toLocaleString('en-US'); }
function usd(n) { return '$' + Number(n).toFixed(2); }
function when(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }

(async () => {
  const t0 = Date.now();
  const [codex, claude] = await Promise.all([collectCodex(), collectClaude()]);
  const model = buildModel({ codex, claude });
  const c = model.providers.codex;
  const cl = model.providers.claude;

  console.log('=== Codex (files: %d, plan: %s) ===', c.fileCount, c.planType || '?');
  if (c.rate) {
    const p = c.rate.primary, s = c.rate.secondary;
    if (p) console.log('  5h  : %s%% used, resets %s', p.used_percent, when(p.resets_at * 1000));
    if (s) console.log('  week: %s%% used, resets %s', s.used_percent, when(s.resets_at * 1000));
  }
  console.log('  5h tokens: %s | month tokens: %s | month cost: %s',
    fmt(c.window5h.total), fmt(c.monthly.total), usd(c.monthly.cost));

  console.log('=== Claude Code (files: %d, sub: %s) ===', cl.fileCount,
    cl.subscription ? cl.subscription.subscriptionType : '?');
  console.log('  5h block tokens: %s (resets %s)', fmt(cl.window5h.total), when(cl.block5hResetMs));
  console.log('  week tokens: %s | month tokens: %s | month cost: %s',
    fmt(cl.weekly.total), fmt(cl.monthly.total), usd(cl.monthly.cost));

  console.log('=== Top projects (by all-time tokens) ===');
  for (const p of model.projects.slice(0, 10)) {
    console.log('  %s  tokens=%s  monthCost=%s  providers=%s',
      p.label.padEnd(18), fmt(p.all.total), usd(p.month.cost),
      Object.keys(p.byProvider).join('+'));
  }
  console.log('=== Totals: month cost %s | month tokens %s ===',
    usd(model.totals.monthCost), fmt(model.totals.monthTokens));
  console.log('(probe done in %dms, events: codex=%d claude=%d)',
    Date.now() - t0, codex.events.length, claude.events.length);
})().catch((e) => { console.error(e); process.exit(1); });
