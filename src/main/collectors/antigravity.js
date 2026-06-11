'use strict';
/**
 * Antigravity Usage Collector
 * Connects to the local Antigravity Language Server to fetch user plan status, prompt credits, and model quotas.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// Last successful snapshot is cached on disk so the panel can still show the
// most recent quotas when the Antigravity IDE is not running.
const CACHE_FILE = path.join(os.homedir(), '.llm-usage-dashboard', 'antigravity-cache.json');

function writeCache(snapshot) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ cachedAt: Date.now(), snapshot }, null, 2));
  } catch { /* cache is best-effort */ }
}

function offlineResult(message) {
  try {
    const { cachedAt, snapshot } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (snapshot && snapshot.active) {
      return { ...snapshot, active: false, stale: true, cachedAt, message };
    }
  } catch { /* no cache yet */ }
  return { active: false, message };
}

// Platform-specific process name and discovery commands
const isWin = os.platform() === 'win32';
const isMac = os.platform() === 'darwin';

/**
 * Executes a shell command and returns stdout, swallowing errors.
 */
async function safeExec(cmd) {
  try {
    const { stdout } = await execAsync(cmd);
    return stdout || '';
  } catch (e) {
    return '';
  }
}

/**
 * Discover the Antigravity Language Server PID and CSRF token.
 */
async function discoverProcess() {
  if (isWin) {
    // Windows Strategy: check Get-CimInstance or WMIC for language_server
    const psCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name like \'%language_server%\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"';
    const stdout = await safeExec(psCmd);
    if (!stdout.trim()) return null;

    try {
      let data = JSON.parse(stdout.trim());
      if (!Array.isArray(data)) data = [data];

      for (const item of data) {
        if (item && item.CommandLine && item.CommandLine.includes('antigravity')) {
          const pid = item.ProcessId;
          const tokenMatch = item.CommandLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
          if (pid && tokenMatch && tokenMatch[1]) {
            return { pid, csrfToken: tokenMatch[1] };
          }
        }
      }
    } catch (e) {
      // JSON parse failed, try wmic fallback
      const wmicCmd = 'wmic process where "name like \'%language_server%\'" get ProcessId,CommandLine /format:list';
      const wmicOut = await safeExec(wmicCmd);
      const blocks = wmicOut.split(/\r?\n\s*\r?\n/).filter(b => b.trim().length > 0);
      for (const block of blocks) {
        const pidMatch = block.match(/ProcessId=(\d+)/);
        const cmdMatch = block.match(/CommandLine=(.+)/);
        if (pidMatch && cmdMatch && cmdMatch[1].includes('antigravity')) {
          const pid = parseInt(pidMatch[1], 10);
          const tokenMatch = cmdMatch[1].match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
          if (pid && tokenMatch && tokenMatch[1]) {
            return { pid, csrfToken: tokenMatch[1] };
          }
        }
      }
    }
  } else {
    // macOS / Linux Strategy: search via pgrep/ps
    const pgrepCmd = isMac ? 'pgrep -fl language_server' : 'pgrep -af language_server';
    const stdout = await safeExec(pgrepCmd);
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('--csrf_token')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
        if (pid && tokenMatch && tokenMatch[1]) {
          return { pid, csrfToken: tokenMatch[1] };
        }
      }
    }
  }
  return null;
}

/**
 * Discover the listening TCP ports for the given PID.
 */
async function discoverPorts(pid) {
  const ports = [];
  if (isWin) {
    const psCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
    const stdout = await safeExec(psCmd);
    if (stdout.trim()) {
      try {
        const data = JSON.parse(stdout.trim());
        if (Array.isArray(data)) {
          for (const port of data) {
            if (typeof port === 'number' && !ports.includes(port)) ports.push(port);
          }
        } else if (typeof data === 'number') {
          ports.push(data);
        }
      } catch (e) {
        // Parse error fallback, try netstat
      }
    }
    if (ports.length === 0) {
      const netstatCmd = `netstat -ano | findstr "${pid}"`;
      const netstatOut = await safeExec(netstatCmd);
      const portRegex = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):(\\d+)\\s+(?:0\\.0\\.0\\.0:0|\\[::\\]:0|\\*:\\*).*?\\s+${pid}$`, 'gim');
      let match;
      while ((match = portRegex.exec(netstatOut)) !== null) {
        const port = parseInt(match[1], 10);
        if (!ports.includes(port)) ports.push(port);
      }
    }
  } else {
    // Unix: ss or lsof
    const ssCmd = `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
    const stdout = await safeExec(ssCmd);
    const lsofRegex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\S+):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
    let match;
    while ((match = lsofRegex.exec(stdout)) !== null) {
      const port = parseInt(match[1], 10);
      if (!ports.includes(port)) ports.push(port);
    }
    const ssRegex = new RegExp(`LISTEN\\s+\\d+\\s+\\d+\\s+(?:\\*|[\\d.]+|\\S+):(\\d+).*?users:.*?,pid=${pid},`, 'gi');
    while ((match = ssRegex.exec(stdout)) !== null) {
      const port = parseInt(match[1], 10);
      if (!ports.includes(port)) ports.push(port);
    }
  }
  return ports.sort((a, b) => a - b);
}

/**
 * Tests if the given port is responsive and working.
 */
function testPort(port, csrfToken) {
  return new Promise(resolve => {
    const data = JSON.stringify({ wrapper_data: {} });
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Codeium-Csrf-Token': csrfToken,
        'Connect-Protocol-Version': '1',
      },
      rejectUnauthorized: false,
      timeout: 1500,
    }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            JSON.parse(body);
            resolve(true);
          } catch {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.write(data);
    req.end();
  });
}

/**
 * Queries GetUserStatus from a working port.
 */
function fetchUserStatus(port, csrfToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en',
      }
    });

    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Codeium-Csrf-Token': csrfToken,
        'Connect-Protocol-Version': '1',
      },
      rejectUnauthorized: false,
      timeout: 3000,
    }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid JSON in GetUserStatus response'));
          }
        } else {
          reject(new Error(`HTTP status ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GetUserStatus request timeout'));
    });

    req.write(data);
    req.end();
  });
}

/**
 * Core collector function to find the server and collect quota details.
 */
async function collectAntigravity() {
  try {
    const processInfo = await discoverProcess();
    if (!processInfo) {
      return offlineResult('Antigravity 未執行');
    }

    const { pid, csrfToken } = processInfo;
    const ports = await discoverPorts(pid);
    if (!ports.length) {
      return offlineResult('No listening ports found for Antigravity');
    }

    // Try finding the working port
    let workingPort = null;
    for (const port of ports) {
      const isWorking = await testPort(port, csrfToken);
      if (isWorking) {
        workingPort = port;
        break;
      }
    }

    if (!workingPort) {
      return offlineResult('Could not establish connection to Antigravity endpoints');
    }

    const statusData = await fetchUserStatus(workingPort, csrfToken);
    const userStatus = statusData.userStatus || {};
    const planStatus = userStatus.planStatus || {};
    const planInfo = planStatus.planInfo || {};

    const availableCredits = planStatus.availablePromptCredits !== undefined ? Number(planStatus.availablePromptCredits) : null;
    const monthlyCredits = planInfo.monthlyPromptCredits !== undefined ? Number(planInfo.monthlyPromptCredits) : null;
    const availableFlow = planStatus.availableFlowCredits !== undefined ? Number(planStatus.availableFlowCredits) : null;
    const monthlyFlow = planInfo.monthlyFlowCredits !== undefined ? Number(planInfo.monthlyFlowCredits) : null;

    const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    const models = rawModels
      .filter(m => m.quotaInfo)
      .map(m => {
        const resetTime = new Date(m.quotaInfo.resetTime).getTime();
        return {
          label: m.label || 'Unknown Model',
          model_id: m.modelOrAlias?.model || 'unknown',
          remaining_fraction: m.quotaInfo.remainingFraction,
          remaining_percentage: m.quotaInfo.remainingFraction !== undefined ? m.quotaInfo.remainingFraction * 100 : 100,
          reset_time: resetTime,
        };
      });

    const result = {
      active: true,
      name: userStatus.name || 'User',
      email: userStatus.email || '',
      planName: planInfo.planName || 'Free',
      promptCredits: {
        available: availableCredits,
        monthly: monthlyCredits,
        pct: (availableCredits !== null && monthlyCredits) ? ((monthlyCredits - availableCredits) / monthlyCredits) * 100 : 0
      },
      flowCredits: {
        available: availableFlow,
        monthly: monthlyFlow,
        pct: (availableFlow !== null && monthlyFlow) ? ((monthlyFlow - availableFlow) / monthlyFlow) * 100 : 0
      },
      models
    };
    writeCache(result);
    return result;
  } catch (e) {
    console.error('[collectAntigravity] error:', e);
    return offlineResult(`Error: ${e.message}`);
  }
}

module.exports = { collectAntigravity };
