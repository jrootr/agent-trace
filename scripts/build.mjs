// Writes dist/agent-trace.html, the standalone viewer (drag a trace file onto it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHtml } from '../src/build/bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'agent-trace.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
const html = buildHtml();
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(1)} KB)`);
