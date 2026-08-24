#!/usr/bin/env node
'use strict';
// Launcher so the app can be run via `npx llm-usage-dashboard` or, after
// `npm i -g llm-usage-dashboard`, simply `llm-usage-dashboard`.
// `require('electron')` resolves to the Electron binary path when run from Node.
const { spawn } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron');
} catch (e) {
  console.error('找不到 Electron。請先安裝:npm i -g llm-usage-dashboard(或在專案內 npm install)。');
  process.exit(1);
}

const appDir = path.join(__dirname, '..');
const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
});
child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => { console.error('啟動失敗:', err.message); process.exit(1); });
