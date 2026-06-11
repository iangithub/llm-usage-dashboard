'use strict';
// Codex (OpenAI) collector.
// Source: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   line 1: { type:"session_meta", payload:{ cwd, cli_version, model_provider } }
//   token_count events: { type:"event_msg", payload:{ type:"token_count",
//       info:{ last_token_usage{...}, total_token_usage{...} },
//       rate_limits:{ primary{used_percent,window_minutes,resets_at}, secondary{...}, plan_type } } }
//
// We emit one normalized usage event per token_count (using last_token_usage =
// the per-turn delta) and capture the globally newest rate_limits snapshot.
const { readJsonl, listJsonl } = require('./jsonl');
const { CODEX_SESSIONS, normalizeCwd } = require('../paths');

// Codex config.toml default model is read for labeling; per-turn model is not in
// the token_count event, so we approximate with the session model when known.
function tokensFromCodex(u) {
  if (!u) return null;
  const cachedIn = u.cached_input_tokens || 0;
  const inputAll = u.input_tokens || 0;
  return {
    input: Math.max(0, inputAll - cachedIn), // uncached input
    cacheRead: cachedIn,
    cacheWrite: 0, // codex does not separate cache writes
    output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
    total: u.total_tokens || (inputAll + (u.output_tokens || 0)),
  };
}

async function collectCodex() {
  const files = listJsonl(CODEX_SESSIONS);
  const events = [];
  let latestRate = null; // { tsMs, primary, secondary, plan_type }
  let planType = null;
  let planTsMs = -1;

  for (const file of files) {
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
        if (tk && (tk.total > 0)) {
          events.push({ provider: 'codex', project: cwd, model, tsMs, tokens: tk });
        }
        const rl = o.payload.rate_limits;
        if (rl) {
          // Newer Codex builds emit snapshots whose plan_type is null; keep the
          // most recent explicit plan_type by timestamp (limit_id is a limit
          // bucket name, not a plan — never let it override a real plan_type).
          if (rl.plan_type && tsMs > planTsMs) { planType = rl.plan_type; planTsMs = tsMs; }
          // Many recent snapshots have primary/secondary set to null — never
          // let an empty snapshot overwrite the newest one that has real data.
          const hasWindows = !!(rl.primary || rl.secondary);
          if (hasWindows && (!latestRate || tsMs > latestRate.tsMs)) {
            latestRate = {
              tsMs,
              primary: rl.primary || null,   // shorter window (5h / 30d on some plans)
              secondary: rl.secondary || null, // longer window (weekly)
              plan_type: rl.plan_type || null,
            };
          }
        }
      }
    });
  }

  return { events, rate: latestRate, planType, fileCount: files.length };
}

module.exports = { collectCodex };
