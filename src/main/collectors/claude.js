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
const path = require('path');
const { readJsonl, listJsonl } = require('./jsonl');
const { CLAUDE_PROJECTS, CLAUDE_CREDS, CLAUDE_JSON, normalizeCwd, exists, getClaudeLogDirs } = require('../paths');

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
  // Older Claude Code wrote the OAuth blob (incl. subscriptionType) into
  // ~/.claude/.credentials.json; newer Windows builds keep credentials in the
  // OS keychain and the file only holds MCP OAuth. Fall back to ~/.claude.json.
  try {
    if (exists(CLAUDE_CREDS)) {
      const o = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8')).claudeAiOauth;
      if (o && (o.subscriptionType || o.rateLimitTier)) {
        return { subscriptionType: o.subscriptionType || null, rateLimitTier: o.rateLimitTier || null };
      }
    }
  } catch { /* fall through */ }
  try {
    if (exists(CLAUDE_JSON)) {
      const d = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
      const sub = (d.oauthAccount && d.oauthAccount.subscriptionType) || d.subscriptionType || null;
      if (sub) return { subscriptionType: sub, rateLimitTier: null };
    }
  } catch { /* no local subscription info available */ }
  return null;
}

function resolveWorkspacePath(cwd) {
  if (!cwd || typeof cwd !== 'string') return cwd || 'unknown';
  const match = cwd.match(/[\\/]local-agent-mode-sessions[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)/i);
  if (!match) return cwd;

  const id1 = match[1];
  const id2 = match[2];
  const sessionName = match[3];

  const logDirs = getClaudeLogDirs();
  for (const dir of logDirs) {
    if (dir.toLowerCase().includes('local-agent-mode-sessions')) {
      const jsonPath = path.join(dir, id1, id2, `${sessionName}.json`);
      if (exists(jsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (data.userSelectedFolders && data.userSelectedFolders.length > 0) {
            return data.userSelectedFolders[0];
          } else if (data.title) {
            return data.title;
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }
  return cwd;
}

async function collectClaude() {
  const dirs = getClaudeLogDirs();
  const files = [];
  for (const dir of dirs) {
    try {
      files.push(...listJsonl(dir));
    } catch (e) {
      // ignore
    }
  }

  // dedup map: key -> event (last write wins)
  const dedup = new Map();

  for (const file of files) {
    const isAgentMode = file.toLowerCase().endsWith('audit.jsonl') && file.includes('local-agent-mode-sessions');
    let agentCwd = null;

    if (isAgentMode) {
      const parentDir = path.dirname(file);
      const sessionName = path.basename(parentDir);
      const grandParent = path.dirname(parentDir);
      const jsonPath = path.join(grandParent, `${sessionName}.json`);
      if (exists(jsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (data.userSelectedFolders && data.userSelectedFolders.length > 0) {
            agentCwd = data.userSelectedFolders[0];
          } else if (data.title) {
            agentCwd = data.title;
          }
        } catch (e) {
          // ignore
        }
      }
    }

    await readJsonl(file, (o) => {
      if (o.type !== 'assistant') return;
      const msg = o.message;
      if (!msg || !msg.usage) return;
      const usage = msg.usage;
      // skip synthetic/empty
      const tk = tokensFromClaude(usage);
      if (tk.total <= 0) return;

      const requestId = o.requestId || o.request_id || '';
      const msgId = msg.id || '';
      const key = (requestId || msgId) ? `${requestId}:${msgId}` : `${file}:${o.uuid || Math.random()}`;
      
      const rawCwd = isAgentMode ? (agentCwd || o.cwd) : o.cwd;
      const projectPath = resolveWorkspacePath(rawCwd);
      const ts = o.timestamp || o._audit_timestamp;
      const tsMs = ts ? (Date.parse(ts) || 0) : 0;

      dedup.set(key, {
        provider: 'claude',
        project: normalizeCwd(projectPath),
        model: msg.model || 'claude',
        tsMs: tsMs,
        tokens: tk,
      });
    });
  }

  return { events: Array.from(dedup.values()), subscription: readSubscription(), fileCount: files.length };
}

module.exports = { collectClaude };
