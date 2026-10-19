'use strict';

// Dependency-free source for the installed app / tray icon.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const type = Buffer.from(name);
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([header, type, bytes, checksum]);
}
function rounded(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, 0, x - (right - radius));
  const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
  return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius;
}
function render(size) {
  const scan = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = (x + (sx + .5) / 4) / size;
        const py = (y + (sy + .5) / 4) / size;
        if (!rounded(px, py, .035, .035, .965, .965, .245)) continue;
        let rgb = [Math.round(144 - py * 24), Math.round(125 - py * 29), Math.round(255 - py * 9)];
        if (rounded(px, py, .252, .365, .35, .635, .049)
          || rounded(px, py, .451, .245, .549, .755, .049)
          || rounded(px, py, .65, .365, .748, .635, .049)) rgb = [255, 255, 255];
        color[0] += rgb[0]; color[1] += rgb[1]; color[2] += rgb[2]; color[3] += 255;
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const opacity = color[3] / 255;
      scan[offset] = opacity ? Math.round(color[0] / opacity) : 0;
      scan[offset + 1] = opacity ? Math.round(color[1] / opacity) : 0;
      scan[offset + 2] = opacity ? Math.round(color[2] / opacity) : 0;
      scan[offset + 3] = Math.round(color[3] / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scan, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const output = path.join(__dirname, 'assets');
fs.mkdirSync(output, { recursive: true });
const sizes = [16, 32, 48, 256];
const images = sizes.map(render);
fs.writeFileSync(path.join(output, 'icon.png'), images[3]);
const icoHeader = Buffer.alloc(6); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(sizes.length, 4);
let offset = 6 + sizes.length * 16;
const entries = images.map((bytes, index) => {
  const entry = Buffer.alloc(16);
  entry[0] = sizes[index] === 256 ? 0 : sizes[index]; entry[1] = entry[0];
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(bytes.length, 8); entry.writeUInt32LE(offset, 12); offset += bytes.length;
  return entry;
});
fs.writeFileSync(path.join(output, 'icon.ico'), Buffer.concat([icoHeader, ...entries, ...images]));
