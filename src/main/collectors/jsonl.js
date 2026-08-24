'use strict';
// Stream a .jsonl file line-by-line, yielding parsed objects.
// Tolerates blank/corrupt lines (skips them).
const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function readJsonl(filePath, onObj) {
  await new Promise((resolve, reject) => {
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    } catch (e) { return reject(e); }
    stream.on('error', reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try { obj = JSON.parse(s); } catch { return; }
      try { onObj(obj); } catch { /* ignore handler errors per-line */ }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// Recursively list *.jsonl files under a directory.
function listJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

function statKey(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch { return null; }
}

// Session logs are append-only and never rewritten, so a file whose size and
// mtime are unchanged since the last scan cannot have new events in it. Without
// this the app re-parses every historical rollout on every refresh (hundreds of
// MB every 5 minutes, plus once per file-watch event) to learn nothing new.
// Entries for files that disappear are dropped on the next scan.
function makeFileCache() {
  let store = new Map();
  return async function scan(files, parseFile, onError) {
    const next = new Map();
    const out = [];
    let parsed = 0;
    let failed = 0;
    for (const file of files) {
      const key = statKey(file);
      const hit = key ? store.get(file) : null;
      if (hit && hit.key === key) {
        out.push(hit.value);
        next.set(file, hit);
        continue;
      }
      let value;
      try {
        value = await parseFile(file);
        parsed++;
      } catch (e) {
        // One locked or half-written log must not abort the whole refresh, and
        // it must not be cached either - retry it on the next scan.
        failed++;
        if (onError) onError(file, e);
        continue;
      }
      if (key) next.set(file, { key, value });
      out.push(value);
    }
    store = next;
    return { results: out, parsed, failed };
  };
}

module.exports = { readJsonl, listJsonl, makeFileCache };
