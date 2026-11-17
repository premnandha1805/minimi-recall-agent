import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/universal-memory.test.ts'], {
  stdio: 'inherit', env: { ...process.env, RECALL_MEMORY_EVALUATION: '1' },
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
