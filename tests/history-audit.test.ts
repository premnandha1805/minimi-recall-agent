import { describe, expect, it } from 'vitest';
import { inspectBlob } from '../scripts/audit-history.js';

describe('publication preflight reports categories without secret contents', () => {
  it('detects known credentials, including in binary assets', () => {
    const sentinel = 'local-credential-sentinel-123456';
    expect(inspectBlob(Buffer.from(`\0${sentinel}`), ['asset.png'], [sentinel])).toEqual(['known_local_credential']);
  });
  it.each(['.env', 'nested/.env.local', '.data/conversations/a.json', '.recall-data/a.json', 'debug.log'])('blocks private file path %s', (file) => {
    expect(inspectBlob(Buffer.from('{}'), [file])).not.toHaveLength(0);
  });
  it('keeps documented placeholders and the environment example publishable', () => {
    expect(inspectBlob(Buffer.from('TAVILY_API_KEY=your_tavily_api_key_here'), ['.env.example'])).toEqual([]);
  });
  it('detects private-key and unknown literal-key patterns without returning their values', () => {
    const sentinel = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const result = inspectBlob(Buffer.from(`const apiKey = '${sentinel}';\n${header}`), ['src/example.ts']);
    expect(result).toEqual(['private_key', 'credential_literal']);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
