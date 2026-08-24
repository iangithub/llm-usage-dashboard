'use strict';
// Codex (OpenAI) collector.
// Source: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   line 1: { type:"session_meta", payload:{ cwd, cli_version, model_provider } }
//   turn_context events: { type:"turn_context", payload:{ model, ... } }
//   token_count events: { type:"event_msg", payload:{ type:"token_count",
//       info:{ last_token_usage{...}, total_token_usage{...} },
//       rate_limits:{ primary{used_percent,window_minutes,resets_at},
//                     secondary{...}, plan_type } } }
//
// We emit one normalized usage event per token_count (using last_token_usage =
// the per-turn delta; summing those reproduces total_token_usage exactly) and
// capture the globally newest rate_limits snapshot.
const { readJsonl, listJsonl, makeFileCache } = require('./jsonl');
const { CODEX_SESSIONS, normalizeCwd } = require('../paths');

// `cached_input_tokens` is a *subset* of `input_tokens`, and
// `reasoning_output_tokens` is a *subset* of `output_tokens` (OpenAI bills
// reasoning tokens as output tokens and reports them as a breakdown) - verified
// against the rollout data, where total_tokens == input_tokens + output_tokens.
// Adding either one again double-counts.
// `cache_write_input_tokens` also sits inside `input_tokens`; OpenAI has no
// cache-write surcharge, so those tokens stay in the plain input bucket.
function tokensFromCodex(u) {
  if (!u) return null;
  const inputAll = u.input_tokens || 0;
  const cacheRead = Math.min(u.cached_input_tokens || 0, inputAll);
  const input = inputAll - cacheRead; // uncached input
  const output = u.output_tokens || 0;
  return {
    input,
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: 0,
    output,
    total: input + cacheRead + output,
  };
}

// Codex has changed the meaning of the primary/secondary slots between CLI
// versions: older builds put the 5-hour window in `primary` and the weekly one
// in `secondary`, newer builds report a single weekly window in `primary` with
// `secondary: null`. Always trust `window_minutes`, never the slot name.
function normalizeWindows(rl, tsMs) {
  const windows = [];
  for (const slot of ['primary', 'secondary']) {
    const w = rl[slot];
    if (!w) continue;
    let resetsAtMs = null;
    if (typeof w.resets_at === 'number') resetsAtMs = w.resets_at * 1000;
    else if (typeof w.resets_in_seconds === 'number') resetsAtMs = tsMs + w.resets_in_seconds * 1000;
    windows.push({
      slot,
      usedPercent: typeof w.used_percent === 'number' ? w.used_percent : null,
      windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : null,
      resetsAtMs,
    });
  }
  return windows;
}

const scan = makeFileCache();

async function parseFile(file) {
  const events = [];
  let latestRate = null;
  let cwd = 'unknown';
  let model = 'gpt-5'; // codex default family for pricing/label

  await readJsonl(file, (o) => {
    if (o.type === 'session_meta' && o.payload) {
      cwd = normalizeCwd(o.payload.cwd);
      return;
    }
    if (o.type === 'turn_context' && o.payload && o.payload.model) {
      model = o.payload.model;
      return;
    }
    if (o.type === 'event_msg' && o.payload && o.payload.type === 'token_count') {
      const info = o.payload.info || {};
      const tsMs = Date.parse(o.timestamp) || 0;
      const tk = tokensFromCodex(info.last_token_usage);
      if (tk && tk.total > 0) {
        events.push({ provider: 'codex', project: cwd, model, tsMs, tokens: tk });
      }
      const rl = o.payload.rate_limits;
      if (rl && (!latestRate || tsMs > latestRate.tsMs)) {
        latestRate = {
          tsMs,
          windows: normalizeWindows(rl, tsMs),
          planType: rl.plan_type || null,
          primary: rl.primary || null,   // raw, kept for debugging
          secondary: rl.secondary || null,
        };
      }
    }
  });

  return { events, latestRate };
}

async function collectCodex() {
  const files = listJsonl(CODEX_SESSIONS);
  const { results, parsed, failed } = await scan(files, parseFile, (file, e) =>
    console.warn('[codex] skipped unreadable log:', file, e.message));

  const events = [];
  let latestRate = null;
  for (const r of results) {
    events.push(...r.events);
    // plan type comes from the newest snapshot too, not from whichever file
    // happened to be scanned last
    if (r.latestRate && (!latestRate || r.latestRate.tsMs > latestRate.tsMs)) latestRate = r.latestRate;
  }

  return {
    events,
    rate: latestRate,
    planType: latestRate ? latestRate.planType : null,
    fileCount: files.length,
    parsedFiles: parsed,
    failedFiles: failed,
  };
}

module.exports = { collectCodex, tokensFromCodex, normalizeWindows };
