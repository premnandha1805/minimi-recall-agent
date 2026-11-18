import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
// Dependency-free, deterministic hygiene check. TypeScript's strict compiler
// remains the semantic checker; this is deliberately not advertised as ESLint.
let errors = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await scan(path); continue; }
    if (!/\.(?:ts|js|mjs)$/.test(path)) continue;
    const text = await readFile(path, 'utf8');
    if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(text) || /\u0000/.test(text)) {
      console.error(`${path}: unresolved conflict marker or NUL`); errors++;
    }
  }
}
for (const directory of ['src', 'public', 'scripts', 'tests']) await scan(directory);
console.log(`Lint: ${errors} errors (conflict markers and NUL bytes; strict typing: npm run typecheck)`);
process.exitCode = errors ? 1 : 0;
