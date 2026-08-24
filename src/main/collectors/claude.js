'use strict';
// Claude Code collector.
// Source: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (+ subagents/*.jsonl)
//   assistant records: { type:"assistant", cwd, timestamp, requestId, uuid,
//       message:{ id, model, usage:{ input_tokens, output_tokens,
//                 cache_creation_input_tokens, cache_read_input_tokens,
//                 cache_creation:{ ephemeral_5m_input_tokens,
//                                  ephemeral_1h_input_tokens } } } }
//
// The same message is written repeatedly while it streams, each line carrying
// the cumulative usage so far, so we de-duplicate by requestId:messageId and
// keep the largest total (the final snapshot).
const fs = require('fs');
const { readJsonl, listJsonl, makeFileCache } = require('./jsonl');
const { CLAUDE_PROJECTS, CLAUDE_CREDS, normalizeCwd, exists } = require('../paths');

// Anthropic reports `input_tokens` as *uncached* input; cache writes and cache
// reads are reported separately, so the four buckets are disjoint and sum to the
// billable total. Thinking tokens are already inside `output_tokens`
// (`output_tokens_details.thinking_tokens` is a breakdown, not an addition).
function tokensFromClaude(u) {
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const writeTotal = u.cache_creation_input_tokens || 0;

  // Cache writes are billed at 1.25x base input for a 5-minute TTL and 2x for a
  // 1-hour TTL, so the two have to be tracked apart.
  const cc = u.cache_creation || {};
  let write1h = cc.ephemeral_1h_input_tokens || 0;
  let write5m = cc.ephemeral_5m_input_tokens || 0;
  if (write5m + write1h === 0) {
    write5m = writeTotal;                       // older records carry no breakdown
  } else if (write5m + write1h < writeTotal) {
    write5m += writeTotal - (write5m + write1h); // unattributed remainder
  }

  return {
    input,
    output,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheWrite: write5m + write1h,
    cacheRead,
    total: input + output + write5m + write1h + cacheRead,
  };
}

function readSubscription() {
  if (!exists(CLAUDE_CREDS)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8'));
    const o = d.claudeAiOauth || {};
    return { subscriptionType: o.subscriptionType || null, rateLimitTier: o.rateLimitTier || null };
  } catch { return null; }
}

const scan = makeFileCache();

// Returns [ [dedupKey, event], ... ] for one session file.
async function parseFile(file) {
  const out = [];
  await readJsonl(file, (o) => {
    if (o.type !== 'assistant') return;
    const msg = o.message;
    if (!msg || !msg.usage) return;
    const tk = tokensFromClaude(msg.usage);
    if (tk.total <= 0) return; // synthetic / empty records
    // Fall back to a per-record key when the record carries neither id, or every
    // such record would collapse into one bucket.
    const key = (o.requestId || msg.id)
      ? `${o.requestId || ''}:${msg.id || ''}`
      : `${file}:${o.uuid || out.length}`;
    out.push([key, {
      provider: 'claude',
      project: normalizeCwd(o.cwd),
      model: msg.model || 'claude',
      tsMs: Date.parse(o.timestamp) || 0,
      tokens: tk,
    }]);
  });
  return out;
}

async function collectClaude() {
  if (!exists(CLAUDE_PROJECTS)) return { events: [], subscription: null, fileCount: 0 };
  const files = listJsonl(CLAUDE_PROJECTS);
  const { results, parsed, failed } = await scan(files, parseFile, (file, e) =>
    console.warn('[claude] skipped unreadable log:', file, e.message));

  // dedup across files: the same message can be copied into a resumed session
  const dedup = new Map();
  for (const perFile of results) {
    for (const [key, ev] of perFile) {
      const prev = dedup.get(key);
      if (!prev || ev.tokens.total >= prev.tokens.total) dedup.set(key, ev);
    }
  }

  return {
    events: Array.from(dedup.values()),
    subscription: readSubscription(),
    fileCount: files.length,
    parsedFiles: parsed,
    failedFiles: failed,
  };
}

module.exports = { collectClaude, tokensFromClaude };
