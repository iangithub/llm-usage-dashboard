'use strict';
// Standalone sanity check (no Electron). Run: npm run probe
// Verifies the collectors + aggregation against real local data.
const { collectCodex } = require('./collectors/codex');
const { collectClaude } = require('./collectors/claude');
const { buildModel } = require('./aggregate');

function fmt(n) { return Number(n).toLocaleString('en-US'); }
function usd(n) { return '$' + Number(n).toFixed(2); }
function when(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }
function windowName(min) {
  if (min == null) return 'window';
  if (min % 10080 === 0) return `${min / 10080}w`;
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

(async () => {
  const t0 = Date.now();
  const [codex, claude] = await Promise.all([collectCodex(), collectClaude()]);
  const model = buildModel({ codex, claude });
  const c = model.providers.codex;
  const cl = model.providers.claude;

  console.log('=== Codex (files: %d, plan: %s) ===', c.fileCount, c.planType || '?');
  if (c.rate) {
    for (const w of c.rate.windows) {
      console.log('  ' + windowName(w.windowMinutes).padEnd(5) + ': ' + w.usedPercent + '% used, resets ' + when(w.resetsAtMs));
    }
  }
  console.log('  5h tokens: %s | month tokens: %s | month cost: %s',
    fmt(c.window5h.total), fmt(c.monthly.total), usd(c.monthly.cost));

  console.log('=== Claude Code (files: %d, sub: %s) ===', cl.fileCount,
    cl.subscription ? cl.subscription.subscriptionType : '?');
  console.log('  5h block tokens: %s (resets %s)', fmt(cl.window5h.total), when(cl.block5hResetMs));
  console.log('  week tokens: %s | month tokens: %s | month cost: %s',
    fmt(cl.weekly.total), fmt(cl.monthly.total), usd(cl.monthly.cost));
  console.log('  month cache writes: 5m %s / 1h %s | cache reads %s',
    fmt(cl.monthly.cacheWrite5m), fmt(cl.monthly.cacheWrite1h), fmt(cl.monthly.cacheRead));

  console.log('=== Top projects (by all-time tokens) ===');
  for (const p of model.projects.slice(0, 10)) {
    console.log('  %s  tokens=%s  monthCost=%s  providers=%s',
      p.label.padEnd(18), fmt(p.all.total), usd(p.month.cost),
      Object.keys(p.byProvider).join('+'));
  }
  console.log('=== Totals: month cost %s | month tokens %s ===',
    usd(model.totals.monthCost), fmt(model.totals.monthTokens));
  if (model.unpricedModels.length) {
    console.log('!!! models with no price entry (counted as $0): %s',
      model.unpricedModels.join(', '));
  }
  console.log('(probe done in %dms, events: codex=%d claude=%d, files parsed: codex=%d claude=%d)',
    Date.now() - t0, codex.events.length, claude.events.length,
    codex.parsedFiles, claude.parsedFiles);
})().catch((e) => { console.error(e); process.exit(1); });
