'use strict';
// Stream a .jsonl file line-by-line, yielding parsed objects.
// Tolerates blank/corrupt lines (skips them).
const fs = require('fs');
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
      const full = require('path').join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

module.exports = { readJsonl, listJsonl };
