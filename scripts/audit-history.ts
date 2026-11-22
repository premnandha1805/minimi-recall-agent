import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

/** Heuristic publication preflight, not a guarantee that arbitrary private data
 * can be identified automatically. Findings contain categories and paths only. */
export function inspectBlob(bytes: Buffer, paths: readonly string[], knownSecrets: readonly string[] = []): string[] {
  const findings: string[] = [];
  const add = (category: string) => { if (!findings.includes(category)) findings.push(category); };
  if (knownSecrets.some((secret) => bytes.includes(Buffer.from(secret)))) add('known_local_credential');
  if (paths.some((file) => /(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example'))) add('environment_file');
  if (paths.some((file) => /(?:^|\/)(?:\.data|\.recall-data)\//.test(file))) add('private_storage_path');
  if (paths.some((file) => /\.log$/i.test(file))) add('log_file');
  if (bytes.includes(0)) return findings;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) add('private_key');
  const tokens = text.match(/\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|tvly-[a-zA-Z0-9_-]{20,}|sk-(?:proj-)?[a-zA-Z0-9_-]{24,})\b/g) ?? [];
  if (tokens.some((token) => !/fixture|placeholder|offline|sentinel|fake|example|your_|test/i.test(token))) add('provider_token_pattern');
  // Azure keys need not have a recognizable prefix. Inspect literal assignments,
  // while excluding identifiers, documented placeholders and fixture sentinels.
  for (const match of text.matchAll(/(?:api[_-]?key|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']([a-zA-Z0-9_+/=-]{32,})["']/gi)) {
    if (!/fixture|placeholder|offline|sentinel|fake|example|your_|test|do.not.leak/i.test(match[1])) add('credential_literal');
  }
  return findings;
}

export function auditHistory(root = process.cwd()) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const commits = git('rev-list', '--all', '--reflog').split('\n').filter(Boolean);
  const blobs = new Map<string, Set<string>>(), trees = new Map<string, Set<string>>();
  for (const commit of commits) {
    const ids = new Set<string>();
    for (const line of git('ls-tree', '-r', commit).split('\n')) {
      const match = line.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/);
      if (!match) continue;
      ids.add(match[1]);
      if (!blobs.has(match[1])) blobs.set(match[1], new Set());
      blobs.get(match[1])!.add(match[2]);
    }
    trees.set(commit, ids);
  }
  const envPath = resolve(root, '.env');
  const localEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const knownSecrets = Object.entries(localEnv).flatMap(([name, value]) =>
    /KEY|SECRET|TOKEN/.test(name) && typeof value === 'string' && value.length >= 16 ? [value] : []);
  const ids = [...blobs.keys()];
  const raw = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: ids.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 });
  const findings = new Map<string, { blob: string; paths: string[]; categories: string[] }>();
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(10, offset);
    const [id, type, length] = raw.subarray(offset, end).toString().split(' ');
    const size = Number(length);
    if (end < 0 || type !== 'blob' || !Number.isSafeInteger(size)) throw new Error('Unexpected Git object framing');
    const paths = [...(blobs.get(id) ?? [])];
    const categories = inspectBlob(raw.subarray(end + 1, end + 1 + size), paths, knownSecrets);
    if (categories.length) findings.set(id, { blob: id, paths, categories });
    offset = end + 1 + size + 1;
  }
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').map((name) => {
    const reachable = new Set(git('rev-list', name).split('\n').flatMap((commit) => [...(trees.get(commit) ?? [])]));
    const issues = [...findings.values()].filter((finding) => reachable.has(finding.blob));
    return { name, tip: git('rev-parse', name), status: issues.length ? 'BLOCKED' : 'NO_DETECTED_SECRET_OR_PRIVATE_FILE', findings: issues };
  });
  return { timestamp: new Date().toISOString(), commits: commits.length, blobs: blobs.size,
    scope: 'Entire reachable history of every local branch, plus remote and reflog objects; local credentials compared only in memory.',
    limits: 'Pattern-based checks plus manual content review are required. Standard Git author metadata and public profile links remain in authentic history. Dirty worktree changes are not covered by a branch push.',
    findings: [...findings.values()], branches };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = auditHistory();
    const directory = resolve('.data', 'audits'); mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'publication.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ commits: report.commits, blobs: report.blobs, branches: report.branches.length,
      blocked: report.branches.filter((branch) => branch.status === 'BLOCKED').map((branch) => branch.name), report: '.data/audits/publication.json' }));
    process.exitCode = report.findings.length ? 1 : 0;
  } catch {
    console.error('History audit did not complete; no publication clearance is established. Raw object data is withheld.');
    process.exitCode = 1;
  }
}
