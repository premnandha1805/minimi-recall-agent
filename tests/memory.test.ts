import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore, ConversationSchema, MEMORY_LIMITS } from '../src/memory.js';
import { result, source } from './fixtures/chat-stream.js';

const instant = '2026-11-15T10:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const filename = (directory: string, id: string) => join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
const roots: string[] = [];
const stores: ConversationStore[] = [];
let sequence = 0;
async function open(directory?: string, newId = () => uuid(++sequence)) {
  if (!directory) { directory = await fs.mkdtemp(join(tmpdir(), 'recall-memory-')); roots.push(directory); }
  const store = await ConversationStore.open({ directory, newId, now: () => new Date(instant) });
  stores.push(store); return store;
}
async function setup() {
  const store = await open(); const conversation = await store.create('Asia/Kolkata');
  const turn = await store.addTurn(conversation.id, { key: 'turn-A', content: 'Original नमस्ते 🌍' });
  const attempt = await store.startAttempt(conversation.id, turn.id, 'attempt-1');
  return { store, id: conversation.id, turn, attempt };
}
const snapshot = () => ({ result: { ...result, sources: [source], message: { ...result.message, content: 'Evidence [S1]' } },
  evidence: [{ ...source, text: 'Exact truncated evidence with private content.' }] });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('durable conversation storage (offline)', () => {
  it('keeps restored canonical and original seed identities idempotent across restart', async () => {
    let store = await open(); const c = await store.create();
    const imported = { id: 'external', role: 'user' as const, content: 'Original seed', timestamp: instant };
    await store.seed(c.id, [imported]);
    const before = (await store.load(c.id))!;
    for (let cycle = 0; cycle < 3; cycle++) {
      const restored = (await store.load(c.id))!.seededMessages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp }));
      await store.seed(c.id, restored);
      await store.seed(c.id, [{ ...restored[0], content: 'Canonical conflict', role: 'assistant' }, { ...imported, content: 'Import conflict' }]);
      expect(await store.load(c.id)).toEqual(before);
      await store.close(); store = await open(store.directory);
    }
    await store.seed(c.id, [{ ...imported, id: 'distinct' }, { ...imported, id: 'later', timestamp: '2026-11-15T11:00:00.000Z' }]);
    expect((await store.load(c.id))!.seededMessages.map((s) => s.suppliedId)).toEqual(['external', 'distinct', 'later']);
  });
  it('preserves accepted server messages when imported with conflicting content', async () => {
    const { store, id, turn, attempt } = await setup();
    const generated = await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    await store.markAwaitingReceipt(id, turn.id, attempt.id);
    await store.acknowledge(id, turn.id, attempt.id, generated.answer!.result.message.id);
    const before = await store.load(id);
    await store.seed(id, [{ ...turn.user, content: 'Forged user' }, { ...generated.answer!.result.message, content: 'Forged assistant' }]);
    expect(await store.load(id)).toEqual(before);
  });
  it('recognizes canonical IDs of hash-imported seeds without collapsing distinct messages', async () => {
    const store = await open(); const c = await store.create();
    const imported = { role: 'assistant' as const, content: 'Same text', timestamp: instant };
    await store.seed(c.id, [imported]); const before = (await store.load(c.id))!;
    const canonical = before.seededMessages[0];
    await store.seed(c.id, [{ id: canonical.id, role: canonical.role, content: 'Conflicting text', timestamp: instant }, imported]);
    expect(await store.load(c.id)).toEqual(before);
    await store.seed(c.id, [{ ...imported, timestamp: '2026-11-15T11:00:00.000Z' }, { ...imported, role: 'user' }]);
    expect((await store.load(c.id))!.seededMessages).toHaveLength(3);
  });
  it('creates validated UTC/server identities and survives close/reopen with exact originals', async () => {
    const { store, id, turn, attempt } = await setup();
    expect(turn.provenance).toBe('server_recorded'); expect(turn.user.timestamp).toBe(instant);
    const saved = await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    expect(saved.answer?.result.message.id).not.toBe(result.message.id);
    expect(saved.answer?.result.message.timestamp).toBe(instant);
    await store.markAwaitingReceipt(id, turn.id, attempt.id);
    await store.acknowledge(id, turn.id, attempt.id, saved.answer!.result.message.id);
    const before = await store.load(id); await store.close();
    const reopened = await open(store.directory);
    expect(await reopened.load(id)).toEqual(before);
    expect(ConversationSchema.safeParse(before).success).toBe(true);
    expect(before!.turns[0].attempts[0].answer!.evidence).toEqual(snapshot().evidence);
    expect(before!.turns[0].user.content).toBe('Original नमस्ते 🌍');
  });

  it('distinguishes generated, awaiting receipt and accepted; acknowledgments are idempotent', async () => {
    const { store, id, turn, attempt } = await setup();
    const generated = await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    const messageId = generated.answer!.result.message.id;
    expect(generated.status).toBe('generated');
    await expect(store.acknowledge(id, turn.id, attempt.id, messageId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.markAwaitingReceipt(id, turn.id, attempt.id)).status).toBe('awaiting_receipt');
    expect((await store.acknowledge(id, turn.id, attempt.id, messageId)).status).toBe('accepted');
    const revision = (await store.load(id))!.revision;
    await store.acknowledge(id, turn.id, attempt.id, messageId);
    expect((await store.load(id))!.revision).toBe(revision);
    await expect(store.startAttempt(id, turn.id, 'new')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('retains research-partial answers as partial, never accepted', async () => {
    const { store, id, turn, attempt } = await setup();
    const data = snapshot(); data.result.coverage = 'partial'; data.result.issues = ['search_timeout'];
    const a = await store.saveGenerated(id, turn.id, attempt.id, data);
    await store.markAwaitingReceipt(id, turn.id, attempt.id);
    expect((await store.acknowledge(id, turn.id, attempt.id, a.answer!.result.message.id)).status).toBe('partial');
    expect((await store.startAttempt(id, turn.id, 'retry')).status).toBe('running');
  });

  it('preserves server content, IDs and revisions on idempotent/conflicting replay', async () => {
    const { store, id, turn, attempt } = await setup();
    const before = await store.load(id);
    expect(await store.addTurn(id, { key: 'turn-A', content: 'Conflicting replacement' })).toEqual(before!.turns[0]);
    expect(await store.startAttempt(id, turn.id, 'attempt-1')).toEqual(attempt);
    expect(await store.load(id)).toEqual(before);
    const saved = await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    const changed = snapshot(); changed.result.message.content = 'Changed [S1]';
    expect(await store.saveGenerated(id, turn.id, attempt.id, changed)).toEqual(saved);
  });

  it('unions seeds in supplied order by supplied ID or normalized UTC hash, without trusting provenance', async () => {
    const { store, id, turn } = await setup();
    const seed = { role: 'user', content: 'Original seed', timestamp: '2026-11-15T15:30:00+05:30' } as const;
    await store.seed(id, [{ ...seed, id: 'client-id' }, seed]);
    const first = (await store.load(id))!.seededMessages;
    await store.seed(id, [{ ...seed, id: 'client-id', content: 'Conflict' }, { ...seed, timestamp: instant },
      { ...seed, id: turn.user.id, content: 'Overwrite server' }]);
    expect((await store.load(id))!.seededMessages).toEqual(first);
    expect(first.map((s) => s.content)).toEqual(['Original seed', 'Original seed']);
    expect(first.every((s) => s.provenance === 'client_seed' && s.timestamp === instant && s.receivedAtUtc === instant)).toBe(true);
    expect(first[0].id).not.toBe('client-id');
  });

  it('does not let a seeded assistant spoof a cancelled generated answer', async () => {
    const { store, id, turn, attempt } = await setup();
    const saved = await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    await store.stopAttempt(id, turn.id, attempt.id, 'cancelled', 'CANCELLED');
    await store.seed(id, [saved.answer!.result.message]);
    const { id: _messageId, ...withoutId } = saved.answer!.result.message;
    await store.seed(id, [withoutId]);
    expect((await store.load(id))!.seededMessages).toEqual([]);
    expect((await store.load(id))!.turns[0].attempts[0].status).toBe('cancelled');
  });

  it('serializes concurrent read-modify-write operations without lost turns or cross-conversation leakage', async () => {
    const store = await open(); const a = await store.create(); const b = await store.create();
    await Promise.all(Array.from({ length: 24 }, (_, i) => store.addTurn(i % 2 ? a.id : b.id, { key: `k${i}`, content: `Q${i}` })));
    for (const [id, parity] of [[a.id, 1], [b.id, 0]] as const) {
      const v = (await store.load(id))!;
      expect(v.turns).toHaveLength(12); expect(v.revision).toBe(12);
      expect(v.turns.map((t) => t.ordinal)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      expect(v.turns.every((t) => Number(t.user.content.slice(1)) % 2 === parity)).toBe(true);
    }
  });

  it('allows one active attempt and preserves older retry order and stale completion ownership', async () => {
    const { store, id, turn, attempt } = await setup();
    await store.stopAttempt(id, turn.id, attempt.id, 'failed', 'MODEL_FAILED');
    const later = await store.addTurn(id, { key: 'B', content: 'Later question' });
    const retry = await store.startAttempt(id, turn.id, 'retry');
    await expect(store.startAttempt(id, later.id, 'B1')).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.saveGenerated(id, turn.id, attempt.id, snapshot()); // stale result is ignored
    expect((await store.load(id))!.turns[0].attempts[0].answer).toBeUndefined();
    await store.stopAttempt(id, turn.id, retry.id, 'cancelled');
    await store.startAttempt(id, later.id, 'B1');
    expect((await store.load(id))!.turns.map((t) => t.user.content)).toEqual(['Original नमस्ते 🌍', 'Later question']);
  });

  it.each(['running', 'generated', 'awaiting_receipt'] as const)('recovers %s without promoting it', async (status) => {
    const { store, id, turn, attempt } = await setup();
    if (status !== 'running') await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    if (status === 'awaiting_receipt') await store.markAwaitingReceipt(id, turn.id, attempt.id);
    await store.close(); const reopened = await open(store.directory);
    const a = (await reopened.load(id))!.turns[0].attempts[0];
    expect(a.status).toBe(status === 'awaiting_receipt' ? 'awaiting_receipt' : 'interrupted');
    expect(a.answer?.evidence).toEqual(status === 'running' ? undefined : snapshot().evidence);
  });

  it('leaves orphan temp files unpromoted and preserves the valid destination', async () => {
    const store = await open(); const c = await store.create();
    const path = filename(store.directory, c.id); const bytes = await fs.readFile(path);
    const orphan = `${path}.${uuid(9999)}.tmp`; await fs.writeFile(orphan, '{"unfinished":');
    await store.close(); const next = await open(store.directory);
    expect(await next.load(c.id)).toEqual(c); expect(await fs.readFile(path)).toEqual(bytes);
    expect(await fs.readFile(orphan, 'utf8')).toBe('{"unfinished":');
  });

  it.each(['../escape', '..', 'CON', 'a/b', 'a\\b', 'SESSION', ''])('rejects invalid/path-unsafe conversation ID %j', async (id) => {
    const store = await open();
    await expect(store.load(id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.delete(id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('detects server ID collisions without overwriting an existing conversation', async () => {
    const store = await open(undefined, () => uuid(9000)); const c = await store.create();
    const bytes = await fs.readFile(filename(store.directory, c.id));
    await expect(store.create()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(filename(store.directory, c.id))).toEqual(bytes);
    await expect(store.addTurn(c.id, { key: 'k', content: 'Collision' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.load(c.id))!.turns).toEqual([]);
  });

  it.each(['{broken', JSON.stringify({ schemaVersion: 'recall.memory.v999' }), '{"secret-unexpected-key":"private"}'])('preserves corrupt or unsupported documents and sanitizes errors', async (bytes) => {
    const store = await open(); const c = await store.create(); const path = filename(store.directory, c.id);
    await fs.writeFile(path, bytes);
    await expect(store.load(c.id)).rejects.toMatchObject({ code: 'CORRUPT', message: 'Conversation storage: CORRUPT' });
    await expect(store.addTurn(c.id, { key: 'k', content: 'Private prompt' })).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    await store.close(); await expect(open(store.directory)).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('rejects a valid document placed under a different conversation digest', async () => {
    const store = await open(); const a = await store.create(); const b = await store.create();
    await fs.writeFile(filename(store.directory, b.id), JSON.stringify(a));
    await expect(store.load(b.id)).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'ENOSPC'])('preserves old bytes when replacement fails with %s; queue remains usable', async (code) => {
    const store = await open(); const c = await store.create(); const path = filename(store.directory, c.id);
    const before = await fs.readFile(path);
    const replacement = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('private filesystem detail'), { code }));
    const unlink = vi.spyOn(fs, 'unlink');
    await expect(store.addTurn(c.id, { key: 'k', content: 'Private input' })).rejects.toMatchObject({ code: 'IO', message: 'Conversation storage: IO' });
    expect(await fs.readFile(path)).toEqual(before);
    expect(unlink.mock.calls.every(([p]) => String(p).endsWith('.tmp'))).toBe(true);
    expect((await fs.readdir(store.directory)).filter((p) => p.endsWith('.tmp'))).toEqual([]);
    replacement.mockRestore();
    expect((await store.addTurn(c.id, { key: 'next', content: 'Next' })).ordinal).toBe(0);
  });

  it('syncs the exclusive same-directory temp before replacement (real Windows replacement when run on Windows)', async () => {
    const store = await open(); const c = await store.create();
    const realOpen = fs.open.bind(fs); const order: string[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[1] === 'wx') {
        expect(String(args[0])).toContain(filename(store.directory, c.id) + '.');
        expect(args[2]).toBe(0o600);
        const sync = handle.sync.bind(handle); const close = handle.close.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); order.push('sync'); });
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); order.push('close'); });
      }
      return handle;
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { order.push('rename'); await rename(...args); });
    await store.addTurn(c.id, { key: 'k', content: 'Replacement works' });
    expect(order).toEqual(['sync', 'close', 'rename']);
    expect((await store.load(c.id))!.turns[0].user.content).toBe('Replacement works');
  });

  it('preserves existing data when flushing fails', async () => {
    const store = await open(); const c = await store.create(); const before = await store.load(c.id);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('private'));
      return handle;
    });
    await expect(store.addTurn(c.id, { key: 'k', content: 'Never committed' })).rejects.toMatchObject({ code: 'IO' });
    expect(await store.load(c.id)).toEqual(before);
  });

  it('enforces conversation capacity, bounded listing and private summaries; deletion is idempotent', async () => {
    const store = await open(); const ids: string[] = [];
    for (let i = 0; i < MEMORY_LIMITS.conversations; i++) ids.push((await store.create()).id);
    await expect(store.create()).rejects.toMatchObject({ code: 'LIMIT' });
    const page = await store.list({ limit: 3 });
    expect(page.total).toBe(100); expect(page.items).toHaveLength(3);
    expect(Object.keys(page.items[0]).sort()).toEqual(['createdAtUtc', 'id', 'turnCount', 'updatedAtUtc']);
    expect((await store.list({ offset: 3, limit: 3 })).items.some((x) => page.items.some((y) => x.id === y.id))).toBe(false);
    await expect(store.list({ limit: 51 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await store.delete(ids[0])).toBe(true); expect(await store.delete(ids[0])).toBe(false);
    expect(await store.load(ids[0])).toBeUndefined();
    await store.create();
  }, 20_000);

  it('enforces batch/file UTF-8 limits atomically, without discarding existing originals', async () => {
    const store = await open(); const c = await store.create();
    await expect(store.seed(c.id, Array(101).fill({ role: 'user', content: 'x', timestamp: instant }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const history = Array.from({ length: 50 }, (_, i) => ({ id: `seed${i}`, role: 'user', content: 'न'.repeat(32000), timestamp: instant }));
    const before = await store.load(c.id);
    await expect(store.seed(c.id, history)).rejects.toMatchObject({ code: 'LIMIT' });
    expect(await store.load(c.id)).toEqual(before);
  });

  it('rejects oversized on-disk files before parsing', async () => {
    const store = await open(); const c = await store.create();
    await fs.truncate(filename(store.directory, c.id), MEMORY_LIMITS.fileBytes + 1);
    await expect(store.load(c.id)).rejects.toMatchObject({ code: 'LIMIT' });
  });

  it('rejects missing snapshots, mismatched evidence and invalid citations without recording answers', async () => {
    const { store, id, turn, attempt } = await setup();
    const invalid = [ { ...snapshot(), evidence: [] },
      { ...snapshot(), evidence: [{ ...source, url: 'https://other.example', text: 'x' }] },
      { ...snapshot(), result: { ...snapshot().result, message: { ...result.message, content: '[S99]' } } } ];
    for (const data of invalid) await expect(store.saveGenerated(id, turn.id, attempt.id, data)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await store.load(id))!.turns[0].attempts[0].answer).toBeUndefined();
    await expect(store.delete(id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('isolates old and new source snapshots even when both use S1 and the same URL', async () => {
    const { store, id, turn, attempt } = await setup();
    const old = await store.saveGenerated(id, turn.id, attempt.id, snapshot());
    await store.markAwaitingReceipt(id, turn.id, attempt.id);
    await store.acknowledge(id, turn.id, attempt.id, old.answer!.result.message.id);
    const later = await store.addTurn(id, { key: 'B', content: 'What changed?' });
    const next = await store.startAttempt(id, later.id, 'B1');
    const fresh = snapshot(); fresh.evidence[0].text = 'Different evidence from a later request';
    await store.saveGenerated(id, later.id, next.id, fresh);
    const v = (await store.load(id))!;
    expect(v.turns[0].attempts[0].answer).toEqual(old.answer);
    expect(v.turns[1].attempts[0].answer!.evidence[0].text).toBe(fresh.evidence[0].text);
  });

  it('rejects symlink files rather than following them', async (context) => {
    const store = await open(); const c = await store.create(); const path = filename(store.directory, c.id);
    const outside = join(store.directory, 'outside'); await fs.writeFile(outside, 'do not read or overwrite');
    await fs.unlink(path);
    try { await fs.symlink(outside, path, 'file'); }
    catch (e) { if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') context.skip('Windows account cannot create file symlinks'); else throw e; }
    await expect(store.load(c.id)).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(await fs.readFile(outside, 'utf8')).toBe('do not read or overwrite');
  });

  it('rejects duplicate store owners and rejects work after close', async () => {
    const store = await open(); await expect(open(store.directory)).rejects.toMatchObject({ code: 'IN_USE' });
    await store.close(); await expect(store.create()).rejects.toMatchObject({ code: 'CLOSED' });
    const next = await open(store.directory);
    await store.close(); // an old owner's repeated close cannot release the new owner
    await expect(open(next.directory)).rejects.toMatchObject({ code: 'IN_USE' });
  });

  it('enforces peak total-byte quota including orphan temps, without evicting anything', async () => {
    const store = await open(); const c = await store.create();
    const before = await fs.readFile(filename(store.directory, c.id));
    for (let i = 0; i < 16; i++) {
      const path = `${filename(store.directory, uuid(90000 + i))}.${uuid(80000 + i)}.tmp`;
      await fs.writeFile(path, '');
      await fs.truncate(path, i === 15 ? MEMORY_LIMITS.fileBytes - before.length : MEMORY_LIMITS.fileBytes);
    }
    await expect(store.addTurn(c.id, { key: 'new', content: 'No room for a temp file' })).rejects.toMatchObject({ code: 'LIMIT' });
    expect(await fs.readFile(filename(store.directory, c.id))).toEqual(before);
    expect(await fs.readdir(store.directory)).toHaveLength(17);
  });

  it('enforces the eight-attempt cap without changing logical turn identity', async () => {
    const { store, id, turn, attempt } = await setup();
    await store.stopAttempt(id, turn.id, attempt.id, 'failed');
    for (let i = 1; i < MEMORY_LIMITS.attempts; i++) {
      const a = await store.startAttempt(id, turn.id, `retry${i}`);
      await store.stopAttempt(id, turn.id, a.id, 'failed');
    }
    await expect(store.startAttempt(id, turn.id, 'too-many')).rejects.toMatchObject({ code: 'LIMIT' });
    expect((await store.load(id))!.turns[0].id).toBe(turn.id);
  });

  it('rejects invalid on-disk states and duplicate identities', async () => {
    const { store, id } = await setup(); const original = (await store.load(id))!;
    const duplicate = structuredClone(original); duplicate.turns[0].user.id = duplicate.turns[0].id;
    const state = structuredClone(original); state.turns[0].attempts[0].status = 'accepted';
    const ordinal = structuredClone(original); ordinal.turns[0].ordinal = 9;
    for (const value of [duplicate, state, ordinal]) expect(ConversationSchema.safeParse(value).success).toBe(false);
    expect(ConversationSchema.safeParse({ ...original, turns: Array(501).fill(original.turns[0]) }).success).toBe(false);
    expect(ConversationSchema.safeParse({ ...original, unexpected: 'private' }).success).toBe(false);
  });
});
