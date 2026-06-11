'use strict';
// CLI terminal dashboard — renders the same data model as the Electron GUI
// using ANSI escape codes + box-drawing characters. Zero external dependencies.

const { collectCodex } = require('./collectors/codex');
const { collectClaude } = require('./collectors/claude');
const { collectAntigravity } = require('./collectors/antigravity');
const { buildModel } = require('./aggregate');

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;

const FG = {
  black:   `${ESC}30m`, red:     `${ESC}31m`, green:   `${ESC}32m`,
  yellow:  `${ESC}33m`, blue:    `${ESC}34m`, magenta: `${ESC}35m`,
  cyan:    `${ESC}36m`, white:   `${ESC}37m`,
  gray:    `${ESC}90m`,
  brightCyan:    `${ESC}96m`,
  brightYellow:  `${ESC}93m`,
  brightGreen:   `${ESC}92m`,
  brightMagenta: `${ESC}95m`,
  brightWhite:   `${ESC}97m`,
};

const BG = {
  black:   `${ESC}40m`, red:     `${ESC}41m`, green:   `${ESC}42m`,
  yellow:  `${ESC}43m`, blue:    `${ESC}44m`, magenta: `${ESC}45m`,
  cyan:    `${ESC}46m`, white:   `${ESC}47m`,
};

// 256-color foreground
const fg256 = (n) => `${ESC}38;5;${n}m`;
const bg256 = (n) => `${ESC}48;5;${n}m`;

// ── formatting helpers ───────────────────────────────────────────────────────
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function usd(n) { return '$' + (n || 0).toFixed(2); }

function durUntil(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return '已重置';
  const m = Math.floor(d / 60000);
  const h = Math.floor(m / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `${days}天${h % 24}小時後重置`;
  if (h >= 1) return `${h}小時${m % 60}分後重置`;
  return `${m}分後重置`;
}

// Codex reports each limit's window length in minutes (5h, weekly, or 30 days
// on some plans) — name the row from the actual window instead of hardcoding.
function codexWindowName(windowMinutes, fallback) {
  if (!windowMinutes) return fallback;
  if (windowMinutes === 10080) return '每週額度';
  if (windowMinutes % 1440 === 0 && windowMinutes >= 2880) return `${windowMinutes / 1440} 天額度`;
  return `${Math.round(windowMinutes / 60)} 小時額度`;
}

// Visible (display) length of a string (strips ANSI escapes)
function visLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Pad to a visible width (right-pad with spaces)
function padEnd(s, w) {
  const diff = w - visLen(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

function padStart(s, w) {
  const diff = w - visLen(s);
  return diff > 0 ? ' '.repeat(diff) + s : s;
}

// ── box drawing ──────────────────────────────────────────────────────────────
// Use Unicode box-drawing characters for a premium look.
const BOX = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  dtl: '╔', dtr: '╗', dbl: '╚', dbr: '╝', dh: '═', dv: '║',
};

function hLine(ch, len) { return ch.repeat(len); }

function boxTop(title, width, color) {
  const inner = width - 2;
  const titleStr = ` ${title} `;
  const titleLen = visLen(titleStr);
  const left = 2;
  const right = inner - left - titleLen;
  return `${color}${BOX.tl}${hLine(BOX.h, left)}${BOLD}${titleStr}${RESET}${color}${hLine(BOX.h, Math.max(0, right))}${BOX.tr}${RESET}`;
}

function boxMid(content, width, color) {
  const inner = width - 4; // │ + space ... space + │
  return `${color}${BOX.v}${RESET} ${padEnd(content, inner)} ${color}${BOX.v}${RESET}`;
}

function boxBottom(width, color) {
  return `${color}${BOX.bl}${hLine(BOX.h, width - 2)}${BOX.br}${RESET}`;
}

function boxEmpty(width, color) {
  return boxMid('', width, color);
}

// ── progress bar ─────────────────────────────────────────────────────────────
function progressBar(pct, barWidth, fillColor, emptyColor) {
  if (pct == null) pct = 0;
  pct = Math.max(0, Math.min(100, pct));
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const fillChar = '█';
  const emptyChar = '░';
  // ≥85% used -> render the filled portion red. Must REPLACE the fill color, not
  // precede it: a 256-color SGR emitted after FG.red would override the red.
  const fill = pct >= 85 ? FG.red : fillColor;
  return `${fill}${fillChar.repeat(filled)}${RESET}${emptyColor}${emptyChar.repeat(empty)}${RESET}`;
}

// ── main render ──────────────────────────────────────────────────────────────
function renderDashboard(model) {
  const W = Math.min(process.stdout.columns || 80, 76); // card width
  const lines = [];
  const p = (s) => lines.push(s);

  // ── Header ──
  const headerW = W;
  p('');
  p(`${fg256(39)}${BOX.dtl}${hLine(BOX.dh, headerW - 2)}${BOX.dtr}${RESET}`);
  const title = `${BOLD}${fg256(39)}AI Usage Dashboard${RESET}`;
  p(`${fg256(39)}${BOX.dv}${RESET}${padEnd('', Math.floor((headerW - 2 - 18) / 2))}${title}${padEnd('', Math.ceil((headerW - 2 - 18) / 2))}${fg256(39)}${BOX.dv}${RESET}`);
  // Totals row
  const tCost = `${BOLD}本月花費${RESET} ${FG.brightGreen}${usd(model.totals.monthCost)}${RESET}`;
  const tTokens = `${BOLD}本月 Tokens${RESET} ${FG.brightCyan}${fmtTokens(model.totals.monthTokens)}${RESET}`;
  const tAll = `${BOLD}累計花費${RESET} ${FG.brightYellow}${usd(model.totals.allCost)}${RESET}`;
  const totalsStr = `  ${tCost}   ${tTokens}   ${tAll}  `;
  p(`${fg256(39)}${BOX.dv}${RESET}${padEnd(totalsStr, headerW - 2)}${fg256(39)}${BOX.dv}${RESET}`);
  p(`${fg256(39)}${BOX.dbl}${hLine(BOX.dh, headerW - 2)}${BOX.dbr}${RESET}`);
  p('');

  // ── Codex Card ──
  const codex = model.providers.codex;
  const codexColor = fg256(42); // greenish
  const codexTitle = `Codex (OpenAI) — ${codex.planType || 'plan'}`;
  p(boxTop(codexTitle, W, codexColor));

  for (const key of ['primary', 'secondary']) {
    const r = codex.rate && codex.rate[key];
    if (!r) continue;
    const name = codexWindowName(r.window_minutes, key === 'primary' ? '5 小時額度' : '每週額度');
    const bar = progressBar(r.used_percent, 24, fg256(42), FG.gray);
    const pctStr = `${BOLD}${Math.round(r.used_percent)}%${RESET}`;
    const resetStr = `${DIM}${durUntil(r.resets_at * 1000)}${RESET}`;
    p(boxMid(`  ${padEnd(name, 10)}  ${bar}  ${pctStr}  ${resetStr}`, W, codexColor));
  }
  if (!codex.rate || (!codex.rate.primary && !codex.rate.secondary)) {
    p(boxMid(`  ${DIM}尚無 Codex 額度資料${RESET}`, W, codexColor));
  } else if (codex.rate.tsMs) {
    p(boxMid(`  ${DIM}額度快照：${new Date(codex.rate.tsMs).toLocaleString()}${RESET}`, W, codexColor));
  }
  p(boxEmpty(W, codexColor));
  const codexStats = `  今日 ${FG.brightWhite}${fmtTokens(codex.today.total)}${RESET}  本月 ${FG.brightWhite}${fmtTokens(codex.monthly.total)}${RESET} tok  花費 ${FG.brightGreen}${usd(codex.monthly.cost)}${RESET}`;
  p(boxMid(codexStats, W, codexColor));
  p(boxBottom(W, codexColor));
  p('');

  // ── Claude Card ──
  const claude = model.providers.claude;
  const claudeColor = fg256(208); // orange
  const sub = claude.subscription;
  const claudeTitle = `Claude Code (Anthropic) — ${(sub && sub.subscriptionType) || 'claude'}`;
  p(boxTop(claudeTitle, W, claudeColor));

  const c5hVal = fmtTokens(claude.window5h.total) + ' tok';
  const c5hReset = claude.block5hResetMs ? `  ${DIM}${durUntil(claude.block5hResetMs)}${RESET}` : '';
  p(boxMid(`  5 小時區塊  ${FG.brightWhite}${c5hVal}${RESET}${c5hReset}`, W, claudeColor));

  const c7dVal = fmtTokens(claude.weekly.total) + ' tok';
  p(boxMid(`  近 7 天     ${FG.brightWhite}${c7dVal}${RESET}`, W, claudeColor));

  p(boxEmpty(W, claudeColor));
  const claudeStats = `  今日 ${FG.brightWhite}${fmtTokens(claude.today.total)}${RESET}  本月 ${FG.brightWhite}${fmtTokens(claude.monthly.total)}${RESET} tok  花費 ${FG.brightGreen}${usd(claude.monthly.cost)}${RESET}`;
  p(boxMid(claudeStats, W, claudeColor));
  p(boxBottom(W, claudeColor));
  p('');

  // ── Antigravity Card ──
  const ag = model.providers.antigravity;
  const agColor = fg256(33); // blue
  if (ag && (ag.active || ag.stale)) {
    const agTitle = `Antigravity (Google) — ${ag.planName || 'Hub'}${ag.stale ? '（快取）' : ''}`;
    p(boxTop(agTitle, W, agColor));
    if (ag.stale) {
      p(boxMid(`  ${DIM}Antigravity 未執行 — 顯示 ${new Date(ag.cachedAt).toLocaleString()} 的快取資料${RESET}`, W, agColor));
    }

    if (ag.promptCredits && ag.promptCredits.monthly) {
      const pct = ag.promptCredits.pct || 0;
      const bar = progressBar(pct, 24, fg256(33), FG.gray);
      const valStr = `${fmtTokens(ag.promptCredits.available)} / ${fmtTokens(ag.promptCredits.monthly)}`;
      p(boxMid(`  Prompts 點數  ${bar}  ${FG.brightWhite}${valStr}${RESET}`, W, agColor));
    } else {
      p(boxMid(`  Prompts 點數  ${FG.brightGreen}無限制${RESET}`, W, agColor));
    }

    if (ag.flowCredits && ag.flowCredits.monthly) {
      const pct = ag.flowCredits.pct || 0;
      const bar = progressBar(pct, 24, fg256(33), FG.gray);
      const valStr = `${fmtTokens(ag.flowCredits.available)} / ${fmtTokens(ag.flowCredits.monthly)}`;
      p(boxMid(`  Flows 點數    ${bar}  ${FG.brightWhite}${valStr}${RESET}`, W, agColor));
    } else {
      p(boxMid(`  Flows 點數    ${FG.brightGreen}無限制${RESET}`, W, agColor));
    }

    if (ag.models && ag.models.length) {
      p(boxEmpty(W, agColor));
      for (const m of ag.models) {
        const usedPct = 100 - (m.remaining_percentage || 0);
        const bar = progressBar(usedPct, 20, fg256(33), FG.gray);
        const pctStr = `${BOLD}${Math.round(usedPct)}%${RESET}`;
        const resetStr = (m.reset_time && !ag.stale) ? `  ${DIM}${durUntil(m.reset_time)}${RESET}` : '';
        const label = (m.label || 'Model').substring(0, 28);
        p(boxMid(`  ${padEnd(label, 28)}  ${bar}  ${pctStr}${resetStr}`, W, agColor));
      }
    }

    p(boxBottom(W, agColor));
  } else {
    const agTitle = 'Antigravity (Google) — OFFLINE';
    p(boxTop(agTitle, W, agColor));
    const errMsg = (ag && ag.message) ? ag.message : '請啟動 Antigravity IDE。';
    p(boxMid(`  ${FG.red}${errMsg}${RESET}`, W, agColor));
    p(boxBottom(W, agColor));
  }
  p('');

  // ── 14-day Chart (horizontal bar chart) ──
  const codexDaily = model.providers.codex.daily || [];
  const claudeDaily = model.providers.claude.daily || [];
  const agDaily = (ag && ag.daily) ? ag.daily : [];
  const days = Math.max(codexDaily.length, claudeDaily.length, agDaily.length);

  if (days > 0) {
    p(`${BOLD}近 14 天每日用量${RESET}  ${fg256(42)}■${RESET} Codex  ${fg256(208)}■${RESET} Claude  ${fg256(33)}■${RESET} Antigravity`);
    p(`${DIM}${hLine('─', W)}${RESET}`);

    let maxTotal = 1;
    for (let i = 0; i < days; i++) {
      const t = (codexDaily[i]?.total || 0) + (claudeDaily[i]?.total || 0) + (agDaily[i]?.total || 0);
      if (t > maxTotal) maxTotal = t;
    }

    const barMax = W - 22; // leave room for label + value

    for (let i = 0; i < days; i++) {
      const cVal = codexDaily[i]?.total || 0;
      const aVal = claudeDaily[i]?.total || 0;
      const gVal = agDaily[i]?.total || 0;
      const total = cVal + aVal + gVal;
      const label = codexDaily[i]?.label || claudeDaily[i]?.label || agDaily[i]?.label || '';

      const cW = Math.round((cVal / maxTotal) * barMax);
      const aW = Math.round((aVal / maxTotal) * barMax);
      const gW = Math.round((gVal / maxTotal) * barMax);

      const cBar = cW > 0 ? `${fg256(42)}${'█'.repeat(cW)}${RESET}` : '';
      const aBar = aW > 0 ? `${fg256(208)}${'█'.repeat(aW)}${RESET}` : '';
      const gBar = gW > 0 ? `${fg256(33)}${'█'.repeat(gW)}${RESET}` : '';

      const valStr = total > 0 ? ` ${DIM}${fmtTokens(total)}${RESET}` : '';
      p(`  ${FG.gray}${label}${RESET} ${cBar}${aBar}${gBar}${valStr}`);
    }
    p('');
  }

  // ── Projects Table ──
  const projects = model.projects || [];
  if (projects.length > 0) {
    p(`${BOLD}各專案用量${RESET}  ${DIM}(${projects.length} 個專案，顯示前 15)${RESET}`);
    p(`${DIM}${hLine('─', W)}${RESET}`);

    // Header
    const hdr = `  ${padEnd('專案', 20)} ${padEnd('來源', 12)} ${padStart('累計 Tok', 10)} ${padStart('本月 Tok', 10)} ${padStart('本月花費', 10)}`;
    p(`${DIM}${hdr}${RESET}`);

    for (const proj of projects.slice(0, 15)) {
      const label = proj.label.length > 18 ? proj.label.substring(0, 17) + '…' : proj.label;
      const providers = Object.keys(proj.byProvider).join('+');
      const provColored = providers.split('+').map(prov => {
        if (prov === 'codex') return `${fg256(42)}${prov}${RESET}`;
        if (prov === 'claude') return `${fg256(208)}${prov}${RESET}`;
        return `${fg256(33)}${prov}${RESET}`;
      }).join('+');

      p(`  ${padEnd(label, 20)} ${padEnd(provColored, 12)} ${padStart(fmtTokens(proj.all.total), 10)} ${padStart(fmtTokens(proj.month.total), 10)} ${padStart(usd(proj.month.cost), 10)}`);
    }
    p('');
  }

  // ── Footer ──
  p(`${DIM}${hLine('─', W)}${RESET}`);
  p(`${DIM}生成於 ${new Date(model.generatedAt).toLocaleString()}  ·  資料純本機讀取，不上傳任何雲端${RESET}`);
  p(`${DIM}提示：GUI 模式請執行 llm-usage-dashboard（不加 --cli）${RESET}`);
  p('');

  // Output all at once for clean display
  console.log(lines.join('\n'));
}

// ── entry point ──────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  process.stdout.write(`${DIM}正在收集資料…${RESET}\r`);

  try {
    const [codex, claude, antigravity] = await Promise.all([
      collectCodex(),
      collectClaude(),
      collectAntigravity(),
    ]);
    const model = buildModel({ codex, claude, antigravity });

    // Clear the loading line
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    renderDashboard(model);

    const elapsed = Date.now() - t0;
    console.log(`${DIM}(完成，耗時 ${elapsed}ms，codex=${codex.events.length} claude=${claude.events.length} 筆事件)${RESET}`);
  } catch (e) {
    console.error(`${FG.red}${BOLD}錯誤：${RESET}${FG.red}${e.message}${RESET}`);
    if (e.stack) console.error(`${DIM}${e.stack}${RESET}`);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { main };
