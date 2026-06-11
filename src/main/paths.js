'use strict';
// Resolves the on-disk data sources for Codex and Claude Code.
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();

const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

const CODEX_SESSIONS = path.join(CODEX_DIR, 'sessions');
const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, 'projects');

const CODEX_AUTH = path.join(CODEX_DIR, 'auth.json');
const CLAUDE_CREDS = path.join(CLAUDE_DIR, '.credentials.json');
const CLAUDE_JSON = path.join(HOME, '.claude.json');

// Normalize a cwd into a stable, comparable project key.
// Handles Windows extended-length prefix (\\?\) and trailing slashes.
function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown';
  let p = cwd.replace(/^\\\\\?\\/, ''); // strip \\?\ prefix
  p = p.replace(/[\\/]+$/, ''); // strip trailing slash
  return p;
}

// Friendly short name for a project path (last path segment).
function projectLabel(cwd) {
  const p = normalizeCwd(cwd);
  if (p === 'unknown') return 'unknown';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function getClaudeLogDirs() {
  const dirs = [];
  if (exists(CLAUDE_PROJECTS)) {
    dirs.push(CLAUDE_PROJECTS);
  }
  const localAgentDirs = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    localAgentDirs.push(path.join(appData, 'Claude', 'local-agent-mode-sessions'));
    
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const packagesDir = path.join(localAppData, 'Packages');
    if (exists(packagesDir)) {
      try {
        const pkgEntries = fs.readdirSync(packagesDir, { withFileTypes: true });
        for (const entry of pkgEntries) {
          if (entry.isDirectory() && entry.name.toLowerCase().startsWith('claude_')) {
            localAgentDirs.push(path.join(packagesDir, entry.name, 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions'));
          }
        }
      } catch (e) {
        // ignore
      }
    }
  } else if (process.platform === 'darwin') {
    localAgentDirs.push(path.join(HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'));
  } else {
    localAgentDirs.push(path.join(HOME, '.config', 'Claude', 'local-agent-mode-sessions'));
  }
  for (const d of localAgentDirs) {
    if (exists(d)) {
      dirs.push(d);
    }
  }
  return dirs;
}

module.exports = {
  HOME,
  CODEX_DIR,
  CLAUDE_DIR,
  CODEX_SESSIONS,
  CLAUDE_PROJECTS,
  CODEX_AUTH,
  CLAUDE_CREDS,
  CLAUDE_JSON,
  normalizeCwd,
  projectLabel,
  exists,
  getClaudeLogDirs,
};
