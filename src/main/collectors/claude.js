'use strict';
// Claude Code collector.
// Source: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (+ subagents/*.jsonl)
//   assistant records: { type:"assistant", cwd, timestamp, requestId,
//       message:{ id, model, usage:{ input_tokens, output_tokens,
//                 cache_creation_input_tokens, cache_read_input_tokens } } }
//
// The same message is streamed across multiple lines; we de-duplicate by
// requestId:messageId and keep the LAST occurrence (final cumulative usage),
// mirroring ccusage's dedup strategy.
const fs = require('fs');
const { readJsonl, listJsonl } = require('./jsonl');
const { CLAUDE_PROJECTS, CLAUDE_CREDS, normalizeCwd, exists } = require('../paths');

function tokensFromClaude(u) {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    total:
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0),
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

async function collectClaude() {
  if (!exists(CLAUDE_PROJECTS)) return { events: [], subscription: null, fileCount: 0 };
  const files = listJsonl(CLAUDE_PROJECTS);
  // dedup map: key -> event (last write wins)
  const dedup = new Map();

  for (const file of files) {
    await readJsonl(file, (o) => {
      if (o.type !== 'assistant') return;
      const msg = o.message;
      if (!msg || !msg.usage) return;
      const usage = msg.usage;
      // skip synthetic/empty
      const tk = tokensFromClaude(usage);
      if (tk.total <= 0) return;
      const key = `${o.requestId || ''}:${msg.id || ''}` || `${file}:${o.uuid}`;
      dedup.set(key, {
        provider: 'claude',
        project: normalizeCwd(o.cwd),
        model: msg.model || 'claude',
        tsMs: Date.parse(o.timestamp) || 0,
        tokens: tk,
      });
    });
  }

  return { events: Array.from(dedup.values()), subscription: readSubscription(), fileCount: files.length };
}

module.exports = { collectClaude };
