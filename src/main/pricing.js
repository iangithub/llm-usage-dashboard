'use strict';
// Model pricing (USD per 1 token). Subscription users are not billed per token,
// so these are *reference estimates* only. Values are per 1,000,000 tokens,
// converted to per-token at load. Editable via assets/pricing.json (optional
// override placed next to the app data dir).
const fs = require('fs');
const path = require('path');

// USD per 1M tokens. Keys are matched by substring against the model id.
const DEFAULT_PRICES_PER_M = {
  // --- Anthropic Claude ---
  'claude-opus':    { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet':  { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-haiku':   { input: 1,    output: 5,   cacheWrite: 1.25,  cacheRead: 0.1 },
  'claude-fable':   { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude':         { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  // --- OpenAI / Codex (gpt-5 family, reference) ---
  'gpt-5':          { input: 1.25, output: 10,  cacheWrite: 1.25,  cacheRead: 0.125 },
  'codex':          { input: 1.25, output: 10,  cacheWrite: 1.25,  cacheRead: 0.125 },
  'o4':             { input: 1.1,  output: 4.4, cacheWrite: 1.1,   cacheRead: 0.275 },
  'gpt-4':          { input: 2.5,  output: 10,  cacheWrite: 2.5,   cacheRead: 1.25 },
};

function loadOverrides(overridePath) {
  if (overridePath && fs.existsSync(overridePath)) {
    try {
      return JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    } catch (e) {
      console.warn('[pricing] failed to read override:', e.message);
    }
  }
  return {};
}

function buildTable(overridePath) {
  const merged = { ...DEFAULT_PRICES_PER_M, ...loadOverrides(overridePath) };
  const perToken = {};
  for (const [k, v] of Object.entries(merged)) {
    perToken[k] = {
      input: (v.input || 0) / 1e6,
      output: (v.output || 0) / 1e6,
      cacheWrite: (v.cacheWrite ?? v.input ?? 0) / 1e6,
      cacheRead: (v.cacheRead ?? 0) / 1e6,
    };
  }
  return perToken;
}

let TABLE = buildTable(path.join(__dirname, '..', '..', 'assets', 'pricing.json'));

function priceFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  // longest matching key wins (more specific)
  let best = null, bestLen = -1;
  for (const key of Object.keys(TABLE)) {
    if (m.includes(key) && key.length > bestLen) { best = TABLE[key]; bestLen = key.length; }
  }
  return best;
}

// tokens = { input, output, cacheWrite, cacheRead }
function costOf(model, tokens) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (tokens.input || 0) * p.input +
    (tokens.output || 0) * p.output +
    (tokens.cacheWrite || 0) * p.cacheWrite +
    (tokens.cacheRead || 0) * p.cacheRead
  );
}

module.exports = { costOf, priceFor, reload: (p) => { TABLE = buildTable(p); } };
