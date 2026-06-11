'use strict';
// Launches the Codex / Claude / Antigravity apps from the dashboard.
// Resolution order per tool:
//   1. known install paths (fast, no shell-out)
//   2. Microsoft Store / Start-menu app via its AppUserModelID (Get-StartApps)
//   3. CLI on PATH, opened in a new terminal window
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const isWin = os.platform() === 'win32';
const isMac = os.platform() === 'darwin';

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

// Direct executable candidates per tool (checked first).
const EXE_CANDIDATES = {
  antigravity: [
    path.join(LOCAL, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(LOCAL, 'Programs', 'antigravity', 'Antigravity.exe'),
  ],
  claude: [
    path.join(LOCAL, 'AnthropicClaude', 'claude.exe'),
  ],
  codex: [],
};

// Start-menu (Get-StartApps) name patterns per tool, most specific first.
const APP_NAME_PATTERNS = {
  codex: [/^codex$/i, /codex/i],
  claude: [/^claude$/i, /^claude\b/i],
  antigravity: [/^antigravity$/i, /antigravity/i],
};

let startAppsCache = null; // [{ name, appId }]
async function getStartApps() {
  if (startAppsCache) return startAppsCache;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
    ], { windowsHide: true, timeout: 15000 });
    let list = JSON.parse(stdout.trim() || '[]');
    if (!Array.isArray(list)) list = [list];
    startAppsCache = list
      .map((a) => ({ name: a.Name || '', appId: a.AppID || '' }))
      .filter((a) => a.appId);
  } catch {
    startAppsCache = [];
  }
  return startAppsCache;
}

function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  child.unref();
}

async function cliOnPath(name) {
  try {
    const finder = isWin ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(finder, [name], { windowsHide: true, timeout: 5000 });
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch { return null; }
}

async function launchTool(tool) {
  tool = String(tool || '').toLowerCase();
  if (!APP_NAME_PATTERNS[tool]) return { ok: false, error: `unknown tool: ${tool}` };

  // 1) direct executable
  for (const exe of EXE_CANDIDATES[tool] || []) {
    if (fs.existsSync(exe)) {
      spawnDetached(exe, [], { cwd: path.dirname(exe) });
      return { ok: true, via: exe };
    }
  }

  if (isWin) {
    // 2) Store / Start-menu app by AppUserModelID
    const apps = await getStartApps();
    for (const re of APP_NAME_PATTERNS[tool]) {
      const hit = apps.find((a) => re.test(a.name));
      if (hit) {
        spawnDetached('explorer.exe', ['shell:AppsFolder\\' + hit.appId]);
        return { ok: true, via: `${hit.name} (${hit.appId})` };
      }
    }
    // 3) CLI on PATH -> open in a new terminal window
    if (await cliOnPath(tool)) {
      spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd', '/k', tool], { windowsHide: true });
      return { ok: true, via: `${tool} (CLI)` };
    }
  } else if (isMac) {
    const appNames = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' };
    try {
      await execFileAsync('open', ['-a', appNames[tool]], { timeout: 5000 });
      return { ok: true, via: appNames[tool] + '.app' };
    } catch { /* fall through to CLI */ }
    if (await cliOnPath(tool)) {
      spawnDetached('open', ['-a', 'Terminal']);
      return { ok: true, via: `${tool} (CLI)` };
    }
  } else {
    if (await cliOnPath(tool)) {
      const term = process.env.TERMINAL || 'x-terminal-emulator';
      spawnDetached(term, ['-e', tool]);
      return { ok: true, via: `${tool} (CLI)` };
    }
  }

  return { ok: false, error: `找不到 ${tool}，請確認已安裝。` };
}

module.exports = { launchTool };
