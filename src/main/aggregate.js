'use strict';
// Aggregation engine: turns normalized usage events + Codex rate snapshot into
// the dashboard data model (5h / weekly / monthly windows, per-project totals,
// cost estimates, and a daily time series).
const { costOf, unpricedModels, resetUnpriced } = require('./pricing');
const { projectLabel } = require('./paths');

const FIVE_H = 5 * 3600 * 1000;
const SEVEN_D = 7 * 86400 * 1000;

function emptyAgg() {
  return {
    input: 0, output: 0,
    cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    total: 0, cost: 0, count: 0,
  };
}

function addEvent(agg, ev) {
  const t = ev.tokens;
  agg.input += t.input || 0;
  agg.output += t.output || 0;
  agg.cacheWrite5m += t.cacheWrite5m || 0;
  agg.cacheWrite1h += t.cacheWrite1h || 0;
  agg.cacheWrite += t.cacheWrite || 0;
  agg.cacheRead += t.cacheRead || 0;
  agg.total += t.total || 0;
  agg.cost += costOf(ev.model, t);
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
// Local calendar day key. Deliberately *not* toISOString(): that renders a local
// midnight in UTC and shifts the label a day backwards for every timezone east
// of Greenwich.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfHour(ms) {
  return Math.floor(ms / 3600000) * 3600000;
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

function windowAgg(events, fromMs, toMs) {
  const agg = emptyAgg();
  for (const ev of events) {
    if (ev.tsMs >= fromMs && (toMs == null || ev.tsMs < toMs)) addEvent(agg, ev);
  }
  return agg;
}

function dailySeries(events, now, days) {
  const buckets = [];
  const index = new Map();
  const today = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    // day arithmetic on the calendar, not on epoch ms: a DST shift makes two
    // local midnights 23 or 25 hours apart and breaks fixed-offset bucketing
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = dayKey(d.getTime());
    const bucket = { dayStart: d.getTime(), key, label: key.slice(5), total: 0, cost: 0 };
    index.set(key, bucket);
    buckets.push(bucket);
  }
  for (const ev of events) {
    const bucket = index.get(dayKey(ev.tsMs));
    if (!bucket) continue;
    bucket.total += ev.tokens.total || 0;
    bucket.cost += costOf(ev.model, ev.tokens);
  }
  return buckets;
}

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function parseMonthKey(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}
// Day count of a local calendar month (day 0 of the next month = last day).
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Months that have any recorded activity, newest first. Drives the month picker
// so the user can only page through months that actually contain data.
function availableMonths(events) {
  const map = new Map();
  for (const ev of events) {
    if (!ev.tsMs) continue;
    const key = monthKey(ev.tsMs);
    let m = map.get(key);
    if (!m) { m = { key, total: 0, cost: 0, count: 0 }; map.set(key, m); }
    m.total += ev.tokens.total || 0;
    m.cost += costOf(ev.model, ev.tokens);
    m.count += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
}

function emptyCell() { return { total: 0, cost: 0, count: 0 }; }
function addCell(cell, total, cost) {
  cell.total += total;
  cell.cost += cost;
  cell.count += 1;
}

// Day x project matrix for one calendar month.
//   provider: 'all' | 'codex' | 'claude'
function buildMonthlyReport(events, key, { provider = 'all', now = Date.now() } = {}) {
  const parsed = parseMonthKey(key) || parseMonthKey(monthKey(now));
  const { year, monthIndex } = parsed;
  const from = new Date(year, monthIndex, 1).getTime();
  const to = new Date(year, monthIndex + 1, 1).getTime();
  const nDays = daysInMonth(year, monthIndex);

  const days = [];
  for (let i = 0; i < nDays; i++) {
    const d = new Date(year, monthIndex, i + 1);
    days.push({ day: i + 1, weekday: d.getDay() });
  }

  const rows = new Map();
  const dayTotals = days.map(() => emptyCell());
  const totals = emptyCell();
  let maxCellTotal = 0;
  let maxCellCost = 0;

  for (const ev of events) {
    if (!(ev.tsMs >= from && ev.tsMs < to)) continue;
    if (provider !== 'all' && ev.provider !== provider) continue;
    // local calendar day, so a late-evening turn stays on the day it happened
    const idx = new Date(ev.tsMs).getDate() - 1;
    if (idx < 0 || idx >= nDays) continue;

    let row = rows.get(ev.project);
    if (!row) {
      row = {
        project: ev.project,
        label: projectLabel(ev.project),
        providers: {},
        days: days.map(() => emptyCell()),
        total: emptyCell(),
        lastTs: 0,
      };
      rows.set(ev.project, row);
    }

    const total = ev.tokens.total || 0;
    const cost = costOf(ev.model, ev.tokens);
    addCell(row.days[idx], total, cost);
    addCell(row.total, total, cost);
    addCell(dayTotals[idx], total, cost);
    addCell(totals, total, cost);
    row.providers[ev.provider] = true;
    if (ev.tsMs > row.lastTs) row.lastTs = ev.tsMs;

    if (row.days[idx].total > maxCellTotal) maxCellTotal = row.days[idx].total;
    if (row.days[idx].cost > maxCellCost) maxCellCost = row.days[idx].cost;
  }

  const projects = Array.from(rows.values())
    .map((r) => ({ ...r, providers: Object.keys(r.providers).sort() }))
    .sort((a, b) => b.total.total - a.total.total);

  // index of "today" within this month, or -1 when looking at another month
  const nowDate = new Date(now);
  const todayIndex = (nowDate.getFullYear() === year && nowDate.getMonth() === monthIndex)
    ? nowDate.getDate() - 1
    : -1;

  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    provider,
    days,
    projects,
    dayTotals,
    totals,
    maxCellTotal,
    maxCellCost,
    todayIndex,
    activeDays: dayTotals.filter((d) => d.count > 0).length,
    generatedAt: now,
  };
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

// codexRate: { windows:[{slot,usedPercent,windowMinutes,resetsAtMs}], planType }
function buildModel({ codex, claude, now = Date.now() }) {
  const codexEvents = codex.events || [];
  const claudeEvents = claude.events || [];
  const all = [...codexEvents, ...claudeEvents];

  // Recorded fresh on every build so a model that stopped being priced (or a
  // brand-new one) shows up instead of silently contributing $0.
  resetUnpriced();

  const codexProvider = buildProvider(codexEvents, now, {
    rate: codex.rate || null, // official window percentages from Codex itself
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
    months: availableMonths(all), // drives the monthly-report picker
    currentMonth: monthKey(now),
    unpricedModels: unpricedModels(),
    totals: {
      monthCost: codexProvider.monthly.cost + claudeProvider.monthly.cost,
      monthTokens: codexProvider.monthly.total + claudeProvider.monthly.total,
      allCost: codexProvider.allTime.cost + claudeProvider.allTime.cost,
    },
  };
}

module.exports = { buildModel, buildMonthlyReport, availableMonths, monthKey };
