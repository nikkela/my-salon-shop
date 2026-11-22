// Embeds public/ into src/static.gen.js (minifying JS and CSS) so the Worker is one self-contained file.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { transformSync } from 'esbuild';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const out = {};
for (const name of readdirSync('public')) {
  const ext = extname(name);
  if (!TYPES[ext]) continue;
  let body = readFileSync(join('public', name), 'utf8');
  if (ext === '.js' || ext === '.css') body = transformSync(body, { loader: ext.slice(1), minify: true }).code;
  out['/' + name] = { type: TYPES[ext], body };
}
writeFileSync('src/static.gen.js', `export default ${JSON.stringify(out)};\n`);
console.log('Embedded', Object.keys(out).join(', '));
