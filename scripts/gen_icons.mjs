import sharp from '../node_modules/sharp/lib/index.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgBuf = readFileSync(join(__dirname, '../public/icons/icon.svg'));

async function gen(size, outName) {
  const png = await sharp(svgBuf).resize(size, size).png().toBuffer();
  writeFileSync(join(__dirname, '../public/icons', outName), png);
  console.log(`生成: ${outName} (${size}x${size})`);
}

await gen(192, 'icon-192.png');
await gen(512, 'icon-512.png');
await gen(180, 'apple-touch-icon.png');
