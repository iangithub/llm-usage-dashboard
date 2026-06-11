#!/usr/bin/env node
'use strict';
// Launcher so the app can be run via `npx ai-usage-dashboard` or, after
// `npm i -g ai-usage-dashboard`, simply `ai-usage-dashboard`.
//
// Modes:
//   --cli   Terminal dashboard (no Electron required)
//   (none)  Full Electron GUI (default)

const args = process.argv.slice(2);

// ── CLI mode: pure Node.js terminal dashboard ──
if (args.includes('--cli')) {
  const { main } = require('../src/main/cli-render');
  main();
} else {
  // ── GUI mode: launch Electron ──
  const { spawn } = require('child_process');
  const path = require('path');

  let electronPath;
  try {
    electronPath = require('electron');
  } catch (e) {
    console.error('找不到 Electron。請先安裝:npm i -g ai-usage-dashboard（或在專案內 npm install）。');
    console.error('提示：若只需終端模式，請加上 --cli 參數：llm-usage-dashboard --cli');
    process.exit(1);
  }

  const appDir = path.join(__dirname, '..');
  const child = spawn(electronPath, [appDir, ...args], {
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('close', (code) => process.exit(code == null ? 0 : code));
  child.on('error', (err) => { console.error('啟動失敗:', err.message); process.exit(1); });
}
