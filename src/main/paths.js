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

module.exports = {
  HOME,
  CODEX_DIR,
  CLAUDE_DIR,
  CODEX_SESSIONS,
  CLAUDE_PROJECTS,
  CODEX_AUTH,
  CLAUDE_CREDS,
  normalizeCwd,
  projectLabel,
  exists,
};
