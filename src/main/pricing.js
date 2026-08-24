'use strict';
// Model pricing (USD per 1 token). Subscription users are not billed per token,
// so these are *reference estimates* only. Values below are per 1,000,000 tokens
// and are converted to per-token at load. Editable via assets/pricing.json.
//
// Sources (verified 2026-08-24):
//   Anthropic https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI    https://developers.openai.com/api/docs/pricing
//
// Anthropic bills prompt-cache writes at two different rates depending on the
// requested TTL - 1.25x base input for a 5-minute entry, 2x for a 1-hour entry -
// and cache hits at 0.1x. OpenAI has no cache-write surcharge (writes are billed
// as ordinary input) and prices cache hits at 0.1x for the gpt-5 family.
const fs = require('fs');
const path = require('path');

// USD per 1M tokens. Keys are matched as substrings of the model id; the longest
// matching key wins, so specific ids override family fallbacks.
//   input        uncached input tokens
//   output       output tokens (reasoning/thinking tokens are already counted in
//                the provider-reported output total - never add them twice)
//   cacheWrite5m Anthropic 5-minute cache write (defaults to `input`)
//   cacheWrite1h Anthropic 1-hour cache write   (defaults to cacheWrite5m)
//   cacheRead    cache hit / cached input
const DEFAULT_PRICES_PER_M = {
  // --- Anthropic Claude ------------------------------------------------------
  'claude-fable-5':  { input: 10,  output: 50, cacheWrite5m: 12.5,  cacheWrite1h: 20,  cacheRead: 1 },
  'claude-mythos-5': { input: 10,  output: 50, cacheWrite5m: 12.5,  cacheWrite1h: 20,  cacheRead: 1 },
  'claude-opus-5':   { input: 5,   output: 25, cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5,   output: 25, cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5,   output: 25, cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5,   output: 25, cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5,   output: 25, cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15,  output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 },
  'claude-opus-4':   { input: 15,  output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 },
  'claude-sonnet-5': { input: 2,   output: 10, cacheWrite5m: 2.5,   cacheWrite1h: 4,   cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3,   output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6,   cacheRead: 0.3 },
  'claude-haiku-4':  { input: 1,   output: 5,  cacheWrite5m: 1.25,  cacheWrite1h: 2,   cacheRead: 0.1 },
  'claude-haiku-3':  { input: 0.8, output: 4,  cacheWrite5m: 1,     cacheWrite1h: 1.6, cacheRead: 0.08 },
  // family fallbacks for ids we do not know yet (current-generation rates)
  'claude-opus':     { input: 5,   output: 25, cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 },
  'claude-sonnet':   { input: 2,   output: 10, cacheWrite5m: 2.5,   cacheWrite1h: 4,   cacheRead: 0.2 },
  'claude-haiku':    { input: 1,   output: 5,  cacheWrite5m: 1.25,  cacheWrite1h: 2,   cacheRead: 0.1 },

  // --- OpenAI / Codex --------------------------------------------------------
  'gpt-5.6-sol':   { input: 4,    output: 20,   cacheRead: 0.4 },
  'gpt-5.6-terra': { input: 2,    output: 12,   cacheRead: 0.2 },
  'gpt-5.6-luna':  { input: 0.2,  output: 1.2,  cacheRead: 0.02 },
  'gpt-5.5-pro':   { input: 30,   output: 180,  cacheRead: 30 },
  'gpt-5.5':       { input: 5,    output: 30,   cacheRead: 0.5 },
  'gpt-5.4-mini':  { input: 0.75, output: 4.5,  cacheRead: 0.075 },
  'gpt-5.4-nano':  { input: 0.2,  output: 1.25, cacheRead: 0.02 },
  'gpt-5.4-pro':   { input: 30,   output: 180,  cacheRead: 30 },
  'gpt-5.4':       { input: 2.5,  output: 15,   cacheRead: 0.25 },
  // The pricing page lists gpt-5.3-codex only; plain gpt-5.3 is assumed to share
  // the same tier it is priced at.
  'gpt-5.3-codex': { input: 1.75, output: 14,   cacheRead: 0.175 },
  'gpt-5.3':       { input: 1.75, output: 14,   cacheRead: 0.175 },
  'gpt-5.2-pro':   { input: 21,   output: 168,  cacheRead: 21 },
  'gpt-5.2':       { input: 1.75, output: 14,   cacheRead: 0.175 },
  'gpt-5.1':       { input: 1.25, output: 10,   cacheRead: 0.125 },
  'gpt-5-pro':     { input: 15,   output: 120,  cacheRead: 15 },
  'gpt-5-mini':    { input: 0.25, output: 2,    cacheRead: 0.025 },
  'gpt-5-nano':    { input: 0.05, output: 0.4,  cacheRead: 0.005 },
  'gpt-5-codex':   { input: 1.25, output: 10,   cacheRead: 0.125 },
  'gpt-5':         { input: 1.25, output: 10,   cacheRead: 0.125 },
  'codex':         { input: 1.25, output: 10,   cacheRead: 0.125 },
  'o4-mini':       { input: 1.1,  output: 4.4,  cacheRead: 0.275 },
  'o3-mini':       { input: 1.1,  output: 4.4,  cacheRead: 0.55 },
  'o3-pro':        { input: 20,   output: 80,   cacheRead: 20 },
  'o3':            { input: 2,    output: 8,    cacheRead: 0.5 },
  'gpt-4.1-mini':  { input: 0.4,  output: 1.6,  cacheRead: 0.1 },
  'gpt-4.1-nano':  { input: 0.1,  output: 0.4,  cacheRead: 0.025 },
  'gpt-4.1':       { input: 2,    output: 8,    cacheRead: 0.5 },
  'gpt-4o-mini':   { input: 0.15, output: 0.6,  cacheRead: 0.075 },
  'gpt-4o':        { input: 2.5,  output: 10,   cacheRead: 1.25 },
};

function loadOverrides(overridePath) {
  if (overridePath && fs.existsSync(overridePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      // drop the "_comment" documentation keys used in the example file
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_') || typeof v !== 'object' || v === null) continue;
        out[k.toLowerCase()] = v;
      }
      return out;
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
    // `cacheWrite` stays supported for overrides written against the old
    // single-rate schema.
    const write5m = v.cacheWrite5m ?? v.cacheWrite ?? v.input ?? 0;
    const write1h = v.cacheWrite1h ?? write5m;
    perToken[k] = {
      input: (v.input || 0) / 1e6,
      output: (v.output || 0) / 1e6,
      cacheWrite5m: write5m / 1e6,
      cacheWrite1h: write1h / 1e6,
      cacheRead: (v.cacheRead ?? 0) / 1e6,
    };
  }
  return perToken;
}

const DEFAULT_OVERRIDE_PATH = path.join(__dirname, '..', '..', 'assets', 'pricing.json');
let TABLE = buildTable(DEFAULT_OVERRIDE_PATH);

// Model ids we were asked to price but have no entry for. Surfaced in the UI so
// that a new model silently costing $0 is visible instead of quietly skewing the
// totals (which is exactly what claude-fable-5 did before it was added).
const unpriced = new Set();

function priceFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (TABLE[m]) return TABLE[m]; // exact id match
  // longest matching key wins (more specific)
  let best = null, bestLen = -1;
  for (const key of Object.keys(TABLE)) {
    if (m.includes(key) && key.length > bestLen) { best = TABLE[key]; bestLen = key.length; }
  }
  if (!best) unpriced.add(m);
  return best;
}

// tokens = { input, output, cacheWrite5m, cacheWrite1h, cacheRead }
function costOf(model, tokens) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (tokens.input || 0) * p.input +
    (tokens.output || 0) * p.output +
    (tokens.cacheWrite5m || 0) * p.cacheWrite5m +
    (tokens.cacheWrite1h || 0) * p.cacheWrite1h +
    (tokens.cacheRead || 0) * p.cacheRead
  );
}

module.exports = {
  costOf,
  priceFor,
  unpricedModels: () => Array.from(unpriced).sort(),
  resetUnpriced: () => unpriced.clear(),
  reload: (p) => { TABLE = buildTable(p || DEFAULT_OVERRIDE_PATH); unpriced.clear(); },
};
