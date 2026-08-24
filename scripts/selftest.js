'use strict';
// Offline regression checks for the token/cost/window maths. No Electron, no
// user data - everything runs against synthetic events. Run: npm test
const assert = require('assert');
const path = require('path');

const { buildModel, buildMonthlyReport, availableMonths } = require('../src/main/aggregate');
const { reportToCsv } = require('../src/main/csv');
const { costOf, priceFor } = require('../src/main/pricing');
const { tokensFromClaude } = require('../src/main/collectors/claude');
const { tokensFromCodex, normalizeWindows } = require('../src/main/collectors/codex');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('pricing');

test('published Anthropic rates (platform.claude.com/docs/en/about-claude/pricing)', () => {
  const cases = {
    'claude-fable-5':  [10, 50, 12.5, 20, 1],
    'claude-opus-5':   [5, 25, 6.25, 10, 0.5],
    'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
    'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
    'claude-opus-4-1-20250805': [15, 75, 18.75, 30, 1.5],
  };
  for (const [model, [i, o, w5, w1, r]] of Object.entries(cases)) {
    const p = priceFor(model);
    assert.ok(p, `${model} has no price entry`);
    assert.strictEqual(p.input * 1e6, i, `${model} input`);
    assert.strictEqual(p.output * 1e6, o, `${model} output`);
    assert.strictEqual(p.cacheWrite5m * 1e6, w5, `${model} 5m cache write`);
    assert.strictEqual(p.cacheWrite1h * 1e6, w1, `${model} 1h cache write`);
    assert.strictEqual(p.cacheRead * 1e6, r, `${model} cache read`);
  }
});

test('Anthropic cache multipliers are 1.25x / 2x / 0.1x of base input', () => {
  for (const model of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    const p = priceFor(model);
    assert.ok(Math.abs(p.cacheWrite5m - p.input * 1.25) < 1e-12, `${model} 5m != 1.25x`);
    assert.ok(Math.abs(p.cacheWrite1h - p.input * 2) < 1e-12, `${model} 1h != 2x`);
    assert.ok(Math.abs(p.cacheRead - p.input * 0.1) < 1e-12, `${model} read != 0.1x`);
  }
});

test('published OpenAI rates (developers.openai.com/api/docs/pricing)', () => {
  const cases = {
    'gpt-5': [1.25, 10, 0.125],
    'gpt-5.1': [1.25, 10, 0.125],
    'gpt-5.2': [1.75, 14, 0.175],
    'gpt-5.3-codex': [1.75, 14, 0.175],
    'gpt-5.4': [2.5, 15, 0.25],
    'gpt-5.5': [5, 30, 0.5],
    'gpt-5.6-sol': [4, 20, 0.4],
    'gpt-5.6-terra': [2, 12, 0.2],
    'o4-mini': [1.1, 4.4, 0.275],
  };
  for (const [model, [i, o, r]] of Object.entries(cases)) {
    const p = priceFor(model);
    assert.ok(p, `${model} has no price entry`);
    assert.strictEqual(p.input * 1e6, i, `${model} input`);
    assert.strictEqual(p.output * 1e6, o, `${model} output`);
    assert.strictEqual(p.cacheRead * 1e6, r, `${model} cached input`);
  }
});

test('longest key wins, so a versioned id beats its family fallback', () => {
  assert.strictEqual(priceFor('gpt-5.6-sol').input * 1e6, 4);   // not gpt-5's 1.25
  assert.strictEqual(priceFor('claude-opus-5').input * 1e6, 5); // not claude-opus-4's 15
});

test('cost sums each bucket at its own rate', () => {
  const cost = costOf('claude-opus-5', {
    input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6,
  });
  assert.ok(Math.abs(cost - (5 + 25 + 6.25 + 10 + 0.5)) < 1e-9, 'got ' + cost);
});

console.log('token normalisation');

test('Claude: buckets are disjoint and thinking is not added twice', () => {
  const tk = tokensFromClaude({
    input_tokens: 100,
    output_tokens: 900,
    output_tokens_details: { thinking_tokens: 700 }, // subset of output_tokens
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 5000,
    cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
  });
  assert.strictEqual(tk.output, 900, 'thinking tokens double-counted');
  assert.strictEqual(tk.cacheWrite5m, 400);
  assert.strictEqual(tk.cacheWrite1h, 600);
  assert.strictEqual(tk.cacheWrite, 1000);
  assert.strictEqual(tk.total, 100 + 900 + 1000 + 5000);
});

test('Claude: records with no TTL breakdown fall back to the 5m rate', () => {
  const tk = tokensFromClaude({
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 800, cache_read_input_tokens: 0,
  });
  assert.strictEqual(tk.cacheWrite5m, 800);
  assert.strictEqual(tk.cacheWrite1h, 0);
});

test('Claude: an unattributed write remainder is charged at the 5m rate', () => {
  const tk = tokensFromClaude({
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 1000, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 },
  });
  assert.strictEqual(tk.cacheWrite5m, 400);
  assert.strictEqual(tk.cacheWrite1h, 600);
});

test('Codex: cached input and reasoning output are subsets, not additions', () => {
  // shape taken verbatim from a real rollout token_count event
  const tk = tokensFromCodex({
    input_tokens: 117616,
    cached_input_tokens: 116480,
    cache_write_input_tokens: 0,
    output_tokens: 306,
    reasoning_output_tokens: 161,
    total_tokens: 117922,
  });
  assert.strictEqual(tk.input, 117616 - 116480, 'uncached input');
  assert.strictEqual(tk.cacheRead, 116480);
  assert.strictEqual(tk.output, 306, 'reasoning tokens double-counted');
  assert.strictEqual(tk.total, 117922, 'total must match the provider total');
});

test('Codex: window length comes from window_minutes, not the slot name', () => {
  // newer Codex builds report the weekly window in `primary` with no secondary
  const w = normalizeWindows({
    primary: { used_percent: 8, window_minutes: 10080, resets_at: 1788146882 },
    secondary: null,
  }, 0);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].windowMinutes, 10080);
  assert.strictEqual(w[0].resetsAtMs, 1788146882000);

  // older builds: 5h in primary, weekly in secondary
  const w2 = normalizeWindows({
    primary: { used_percent: 12, window_minutes: 300, resets_at: 100 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: 200 },
  }, 0);
  assert.deepStrictEqual(w2.map((x) => x.windowMinutes), [300, 10080]);
});

console.log('aggregation');

const ZERO = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
function ev(provider, tsMs, tokens, model, project) {
  return { provider, tsMs, model: model || 'gpt-5', project: project || 'p', tokens: { ...ZERO, ...tokens } };
}

test('daily labels follow the local calendar day, not UTC', () => {
  const now = new Date(2026, 7, 24, 23, 30).getTime(); // 24 Aug, late evening local
  const model = buildModel({ codex: { events: [] }, claude: { events: [] }, now });
  const daily = model.providers.codex.daily;
  assert.strictEqual(daily.length, 14);
  assert.strictEqual(daily[13].label, '08-24', 'last bucket must be today');
  assert.strictEqual(daily[12].label, '08-23');
  assert.strictEqual(daily[0].label, '08-11');
});

test('events land in the local day bucket they happened on', () => {
  const now = new Date(2026, 7, 24, 23, 30).getTime();
  const lateToday = new Date(2026, 7, 24, 23, 0).getTime();
  const yesterday = new Date(2026, 7, 23, 10, 0).getTime();
  const model = buildModel({
    codex: { events: [ev('codex', lateToday, { total: 10 }), ev('codex', yesterday, { total: 5 })] },
    claude: { events: [] },
    now,
  });
  const daily = model.providers.codex.daily;
  assert.strictEqual(daily[13].total, 10, 'today bucket');
  assert.strictEqual(daily[12].total, 5, 'yesterday bucket');
});

test('the 5h block expires and stops reporting stale usage', () => {
  const now = Date.UTC(2026, 7, 24, 20, 0);
  const stale = { codex: { events: [ev('codex', Date.UTC(2026, 7, 24, 9, 0), { total: 7 })] }, claude: { events: [] }, now };
  assert.strictEqual(buildModel(stale).providers.codex.block5hResetMs, null);

  const fresh = { codex: { events: [ev('codex', Date.UTC(2026, 7, 24, 18, 30), { total: 7 })] }, claude: { events: [] }, now };
  const p = buildModel(fresh).providers.codex;
  assert.strictEqual(p.window5h.total, 7);
  assert.strictEqual(p.block5hResetMs, Date.UTC(2026, 7, 24, 23, 0), 'block starts at the floored hour');
});

test('a model with no price entry is reported instead of silently costing $0', () => {
  const now = Date.now();
  const model = buildModel({
    codex: { events: [ev('codex', now - 1000, { input: 10, total: 10 }, 'totally-unknown-model')] },
    claude: { events: [] },
    now,
  });
  assert.deepStrictEqual(model.unpricedModels, ['totally-unknown-model']);
  assert.strictEqual(model.totals.monthCost, 0);
});

test('totals add up across providers', () => {
  const now = Date.now();
  const model = buildModel({
    codex: { events: [ev('codex', now - 1000, { input: 1e6, total: 1e6 }, 'gpt-5')] },
    claude: { events: [ev('claude', now - 1000, { input: 1e6, total: 1e6 }, 'claude-opus-5')] },
    now,
  });
  assert.strictEqual(model.totals.monthTokens, 2e6);
  assert.ok(Math.abs(model.totals.monthCost - (1.25 + 5)) < 1e-9, 'got ' + model.totals.monthCost);
});

console.log('monthly report');

// Three projects spread over a leap February, plus one event in another month.
const REPORT_EVENTS = [
  ev('codex', new Date(2026, 1, 3, 9, 0).getTime(), { input: 1e6, total: 1e6 }, 'gpt-5', 'D:\\a'),
  ev('codex', new Date(2026, 1, 3, 23, 55).getTime(), { input: 1e6, total: 1e6 }, 'gpt-5', 'D:\\a'),
  ev('claude', new Date(2026, 1, 3, 10, 0).getTime(), { input: 1e6, total: 1e6 }, 'claude-opus-5', 'D:\\b'),
  ev('claude', new Date(2026, 1, 28, 8, 0).getTime(), { input: 1e6, total: 1e6 }, 'claude-opus-5', 'D:\\b'),
  ev('codex', new Date(2026, 2, 1, 8, 0).getTime(), { input: 1e6, total: 1e6 }, 'gpt-5', 'D:\\c'),
];
const REPORT_NOW = new Date(2026, 1, 20, 12, 0).getTime();

test('month length follows the calendar (Feb 2026 has 28 days)', () => {
  const r = buildMonthlyReport(REPORT_EVENTS, '2026-02', { now: REPORT_NOW });
  assert.strictEqual(r.days.length, 28);
  assert.strictEqual(buildMonthlyReport([], '2026-04', { now: REPORT_NOW }).days.length, 30);
  assert.strictEqual(buildMonthlyReport([], '2024-02', { now: REPORT_NOW }).days.length, 29, 'leap year');
});

test('every cell lands on its local calendar day', () => {
  const r = buildMonthlyReport(REPORT_EVENTS, '2026-02', { now: REPORT_NOW });
  const a = r.projects.find((p) => p.project === 'D:\\a');
  // both 3 Feb events, including the 23:55 one, belong to day 3 (index 2)
  assert.strictEqual(a.days[2].total, 2e6);
  assert.strictEqual(a.days[2].count, 2);
  assert.strictEqual(a.days[27].total, 0);
  const b = r.projects.find((p) => p.project === 'D:\\b');
  assert.strictEqual(b.days[2].total, 1e6);
  assert.strictEqual(b.days[27].total, 1e6, 'last day of the month');
});

test('the matrix reconciles: rows = day totals = cells = grand total', () => {
  const r = buildMonthlyReport(REPORT_EVENTS, '2026-02', { now: REPORT_NOW });
  const rowSum = r.projects.reduce((a, p) => a + p.total.total, 0);
  const daySum = r.dayTotals.reduce((a, c) => a + c.total, 0);
  const cellSum = r.projects.reduce((a, p) => a + p.days.reduce((s, c) => s + c.total, 0), 0);
  assert.strictEqual(rowSum, 4e6);
  assert.strictEqual(daySum, 4e6);
  assert.strictEqual(cellSum, 4e6);
  assert.strictEqual(r.totals.total, 4e6);
  assert.strictEqual(r.activeDays, 2);
});

test('other months are excluded', () => {
  const r = buildMonthlyReport(REPORT_EVENTS, '2026-02', { now: REPORT_NOW });
  assert.ok(!r.projects.some((p) => p.project === 'D:\\c'), 'March event leaked into February');
  const march = buildMonthlyReport(REPORT_EVENTS, '2026-03', { now: REPORT_NOW });
  assert.deepStrictEqual(march.projects.map((p) => p.project), ['D:\\c']);
});

test('the provider filter partitions the month exactly', () => {
  const opts = { now: REPORT_NOW };
  const all = buildMonthlyReport(REPORT_EVENTS, '2026-02', opts);
  const cx = buildMonthlyReport(REPORT_EVENTS, '2026-02', { ...opts, provider: 'codex' });
  const cl = buildMonthlyReport(REPORT_EVENTS, '2026-02', { ...opts, provider: 'claude' });
  assert.strictEqual(cx.totals.total + cl.totals.total, all.totals.total);
  assert.deepStrictEqual(cx.projects.map((p) => p.project), ['D:\\a']);
  assert.deepStrictEqual(cl.projects.map((p) => p.project), ['D:\\b']);
});

test('todayIndex only points at a day in the month being viewed', () => {
  assert.strictEqual(buildMonthlyReport(REPORT_EVENTS, '2026-02', { now: REPORT_NOW }).todayIndex, 19);
  assert.strictEqual(buildMonthlyReport(REPORT_EVENTS, '2026-03', { now: REPORT_NOW }).todayIndex, -1);
});

test('a month with no data still renders an empty grid', () => {
  const r = buildMonthlyReport(REPORT_EVENTS, '2026-01', { now: REPORT_NOW });
  assert.strictEqual(r.projects.length, 0);
  assert.strictEqual(r.days.length, 31);
  assert.strictEqual(r.totals.total, 0);
  assert.strictEqual(r.activeDays, 0);
});

test('a bad month key falls back to the current month instead of throwing', () => {
  assert.strictEqual(buildMonthlyReport(REPORT_EVENTS, 'nonsense', { now: REPORT_NOW }).month, '2026-02');
  assert.strictEqual(buildMonthlyReport(REPORT_EVENTS, null, { now: REPORT_NOW }).month, '2026-02');
});

test('availableMonths lists only months with data, newest first', () => {
  assert.deepStrictEqual(availableMonths(REPORT_EVENTS).map((m) => m.key), ['2026-03', '2026-02']);
});

test('CSV has one column per day and a reconciling total row', () => {
  const r = buildMonthlyReport(REPORT_EVENTS, '2026-02', { now: REPORT_NOW });
  const lines = reportToCsv(r, 'tokens').replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.strictEqual(lines.length, 1 + r.projects.length + 1);
  const head = lines[0].split(',');
  assert.strictEqual(head.length, 2 + 28 + 1);
  assert.strictEqual(head[2], '2026-02-01');
  assert.strictEqual(head[29], '2026-02-28');
  const foot = lines[lines.length - 1].split(',');
  assert.strictEqual(foot[0], '每日合計');
  assert.strictEqual(foot[foot.length - 1], String(4e6));
  assert.ok(reportToCsv(r, 'tokens').charCodeAt(0) === 0xFEFF, 'missing UTF-8 BOM for Excel');
});

test('CSV quotes fields that contain commas or quotes', () => {
  const events = [ev('codex', new Date(2026, 1, 3).getTime(), { total: 1 }, 'gpt-5', 'D:\\a,b "c"')];
  const r = buildMonthlyReport(events, '2026-02', { now: REPORT_NOW });
  const line = reportToCsv(r, 'tokens').split('\r\n')[1];
  assert.ok(line.startsWith('"D:\\a,b ""c""",codex,'), line.slice(0, 40));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
