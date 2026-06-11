'use strict';
// Generates assets/icon.png (256x256) and assets/tray.png (32x32) without any
// native deps — a small PNG encoder over a hand-drawn RGBA gauge motif.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.40, ring = size * 0.11;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let r = 0, g = 0, b = 0, a = 0;
      // rounded dark background
      const bgR = size * 0.46;
      if (d <= bgR) { r = 24; g = 27; b = 38; a = 255; }
      // gauge ring: angle from -210deg..30deg, two-tone (codex green / claude orange)
      if (d <= R + ring / 2 && d >= R - ring / 2) {
        let ang = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
        let t = (ang + 210) % 360; // 0 at start
        if (t >= 0 && t <= 240) {
          if (t < 120) { r = 52; g = 211; b = 153; } // teal/green
          else { r = 251; g = 146; b = 60; }         // orange
          a = 255;
        }
      }
      // center dot
      if (d <= size * 0.12) { r = 96; g = 165; b = 250; a = 255; }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return buf;
}

// Wrap a 256x256 PNG inside an .ico container (valid for modern Windows).
function encodeICO(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 => 256
  entry[1] = 0; // height 0 => 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // size of PNG data
  entry.writeUInt32LE(6 + 16, 12);    // offset to PNG data
  return Buffer.concat([header, entry, png]);
}

const outDir = __dirname;
const png256 = encodePNG(256, 256, draw(256));
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, 32, draw(32)));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(png256));
console.log('icons written (png + tray + ico)');
