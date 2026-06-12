'use strict';
// Aggregation engine: turns normalized usage events + Codex rate snapshot into
// the dashboard data model (5h / weekly / monthly windows, per-project totals,
// cost estimates, and a daily time series).
const { costOf } = require('./pricing');
const { projectLabel } = require('./paths');

const FIVE_H = 5 * 3600 * 1000;
const SEVEN_D = 7 * 86400 * 1000;

function emptyAgg() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, count: 0 };
}

function addEvent(agg, ev) {
  agg.input += ev.tokens.input || 0;
  agg.output += ev.tokens.output || 0;
  agg.cacheWrite += ev.tokens.cacheWrite || 0;
  agg.cacheRead += ev.tokens.cacheRead || 0;
  agg.total += ev.tokens.total || 0;
  agg.cost += costOf(ev.model, ev.tokens);
  agg.count += 1;
}

function startOfMonth(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Reconstruct the current 5-hour activity block (ccusage-style) for events of
// one provider. Returns { startMs, resetMs, agg } for the block containing now,
// or null if no recent activity.
function currentBlock(events, now) {
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
  let blockStart = null;
  let lastTs = null;
  let blockAgg = emptyAgg();
  for (const ev of sorted) {
    const floored = startOfHour(ev.tsMs);
    if (
      blockStart === null ||
      ev.tsMs - blockStart >= FIVE_H ||
      (lastTs !== null && ev.tsMs - lastTs >= FIVE_H)
    ) {
      blockStart = floored;
      blockAgg = emptyAgg();
    }
    addEvent(blockAgg, ev);
    lastTs = ev.tsMs;
  }
  const resetMs = blockStart + FIVE_H;
  if (now >= resetMs) return null; // block already expired -> no active 5h usage
  return { startMs: blockStart, resetMs, agg: blockAgg };
}

function startOfHour(ms) {
  return Math.floor(ms / 3600000) * 3600000;
}

function windowAgg(events, fromMs, toMs) {
  const agg = emptyAgg();
  for (const ev of events) {
    if (ev.tsMs >= fromMs && (toMs == null || ev.tsMs < toMs)) addEvent(agg, ev);
  }
  return agg;
}

function dailySeries(events, now, days) {
  const buckets = [];
  const todayStart = startOfDay(now);
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = todayStart - i * 86400000;
    buckets.push({ dayStart, label: new Date(dayStart).toISOString().slice(5, 10), total: 0, cost: 0 });
  }
  const first = buckets[0].dayStart;
  for (const ev of events) {
    if (ev.tsMs < first) continue;
    const idx = Math.floor((startOfDay(ev.tsMs) - first) / 86400000);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].total += ev.tokens.total || 0;
      buckets[idx].cost += costOf(ev.model, ev.tokens);
    }
  }
  return buckets;
}

function buildProvider(events, now, opts = {}) {
  const monthStart = startOfMonth(now);
  const block = currentBlock(events, now);
  return {
    window5h: block ? block.agg : emptyAgg(),
    block5hResetMs: block ? block.resetMs : null,
    weekly: windowAgg(events, now - SEVEN_D, null),
    monthly: windowAgg(events, monthStart, null),
    today: windowAgg(events, startOfDay(now), null),
    allTime: windowAgg(events, 0, null),
    daily: dailySeries(events, now, 14),
    ...opts,
  };
}

function buildProjects(allEvents, now) {
  const monthStart = startOfMonth(now);
  const map = new Map();
  for (const ev of allEvents) {
    let p = map.get(ev.project);
    if (!p) {
      p = {
        project: ev.project,
        label: projectLabel(ev.project),
        all: emptyAgg(),
        month: emptyAgg(),
        byProvider: {},
        lastTs: 0,
      };
      map.set(ev.project, p);
    }
    addEvent(p.all, ev);
    if (ev.tsMs >= monthStart) addEvent(p.month, ev);
    if (!p.byProvider[ev.provider]) p.byProvider[ev.provider] = emptyAgg();
    addEvent(p.byProvider[ev.provider], ev);
    if (ev.tsMs > p.lastTs) p.lastTs = ev.tsMs;
  }
  return Array.from(map.values()).sort((a, b) => b.all.total - a.all.total);
}

// codexRate: { primary, secondary, plan_type } from collector (used_percent etc.)
function buildModel({ codex, claude, now = Date.now() }) {
  const codexEvents = codex.events || [];
  const claudeEvents = claude.events || [];
  const all = [...codexEvents, ...claudeEvents];

  const codexProvider = buildProvider(codexEvents, now, {
    rate: codex.rate || null, // official 5h(primary)/weekly(secondary) percentages
    planType: codex.planType || null,
    fileCount: codex.fileCount || 0,
  });
  const claudeProvider = buildProvider(claudeEvents, now, {
    subscription: claude.subscription || null,
    fileCount: claude.fileCount || 0,
  });

  return {
    generatedAt: now,
    providers: { codex: codexProvider, claude: claudeProvider },
    projects: buildProjects(all, now),
    totals: {
      monthCost: codexProvider.monthly.cost + claudeProvider.monthly.cost,
      monthTokens: codexProvider.monthly.total + claudeProvider.monthly.total,
      allCost: codexProvider.allTime.cost + claudeProvider.allTime.cost,
    },
  };
}

module.exports = { buildModel };
