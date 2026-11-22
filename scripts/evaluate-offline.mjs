import { spawnSync } from 'node:child_process';
// Explicitly run only the frozen evaluation, using installed dependencies.
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/evaluation.test.ts', 'tests/search-baseline.test.ts'], {
  stdio: 'inherit', env: { ...process.env, RECALL_EVALUATION: '1' },
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
