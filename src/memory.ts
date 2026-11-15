import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { z } from 'zod';
import { ChatHistoryMessageSchema, ChatResultSchema, SourceMetadataSchema, isValidTimeZone } from './contracts.js';

export const MEMORY_LIMITS = Object.freeze({ conversations: 100, fileBytes: 4 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024, directoryEntries: 256, turns: 500, attempts: 8,
  seededMessages: 1000, seedBatch: 100, pageSize: 50 });
const Id = z.uuid();
const Key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const Utc = z.iso.datetime();
const Zone = z.string().max(64).refine(isValidTimeZone);
const Text = z.string().min(1).max(32_000).refine((s) => !!s.trim());
const Message = z.strictObject({ id: Id, role: z.enum(['user', 'assistant']), content: Text, timestamp: Utc });
const Seed = Message.extend({ provenance: z.literal('client_seed'), mergeKey: z.string().min(1).max(256),
  suppliedId: z.string().min(1).max(128).optional(), receivedAtUtc: Utc });
const Evidence = SourceMetadataSchema.extend({ text: z.string().min(1).max(2000) });
const Answer = z.strictObject({ result: ChatResultSchema, evidence: z.array(Evidence).max(24) }).superRefine((v, ctx) => {
  if (v.result.sources.length !== v.evidence.length || v.result.sources.some((s, i) => {
    const { text: _text, ...metadata } = v.evidence[i] ?? {};
    return JSON.stringify(s) !== JSON.stringify(SourceMetadataSchema.safeParse(metadata).data);
  })) ctx.addIssue({ code: 'custom', message: 'Invalid evidence snapshot' });
});
const Attempt = z.strictObject({ id: Id, key: Key, startedAtUtc: Utc, finishedAtUtc: Utc.optional(),
  status: z.enum(['running', 'generated', 'awaiting_receipt', 'accepted', 'partial', 'failed', 'cancelled', 'interrupted']),
  answer: Answer.optional(), failure: z.enum(['MODEL_FAILED', 'TIMEOUT', 'INVALID_OUTPUT', 'STORAGE', 'CANCELLED']).optional(),
}).superRefine((a, ctx) => {
  const hasAnswer = ['generated', 'awaiting_receipt', 'accepted', 'partial'].includes(a.status);
  if ((hasAnswer && !a.answer) || (a.status === 'running' && (a.answer || a.finishedAtUtc)) ||
      (a.status !== 'running' && !a.finishedAtUtc) ||
      (a.status === 'accepted' && a.answer?.result.coverage !== 'complete') ||
      (a.status === 'partial' && a.answer?.result.coverage !== 'partial') ||
      (!['failed', 'cancelled'].includes(a.status) && a.failure)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid attempt state' });
  }
});
const Turn = z.strictObject({ id: Id, key: Key, ordinal: z.number().int().nonnegative(),
  provenance: z.literal('server_recorded'), user: Message.extend({ role: z.literal('user') }),
  timezone: Zone.optional(), attempts: z.array(Attempt).max(MEMORY_LIMITS.attempts) });
export const ConversationSchema = z.strictObject({ schemaVersion: z.literal('recall.memory.v1'), id: Id,
  clientKey: Key.optional(),
  revision: z.number().int().nonnegative(), createdAtUtc: Utc, updatedAtUtc: Utc, timezone: Zone.optional(),
  seededMessages: z.array(Seed).max(MEMORY_LIMITS.seededMessages), turns: z.array(Turn).max(MEMORY_LIMITS.turns),
}).superRefine((v, ctx) => {
  const ids = new Set<string>([v.id]);
  const unique = (id: string) => { if (ids.has(id)) return false; ids.add(id); return true; };
  let valid = true;
  const turnKeys = new Set<string>();
  const seedKeys = new Set<string>();
  let active = 0;
  for (const seed of v.seededMessages) {
    valid = unique(seed.id) && !seedKeys.has(seed.mergeKey) && valid; seedKeys.add(seed.mergeKey);
  }
  v.turns.forEach((t, i) => {
    valid = unique(t.id) && unique(t.user.id) && t.ordinal === i && !turnKeys.has(t.key) && valid;
    turnKeys.add(t.key);
    const keys = new Set<string>();
    let accepted = 0;
    t.attempts.forEach((a, n) => {
      valid = unique(a.id) && !keys.has(a.key) && valid; keys.add(a.key);
      if (a.answer) valid = Id.safeParse(a.answer.result.message.id).success && unique(a.answer.result.message.id) && valid;
      if (['running', 'generated', 'awaiting_receipt'].includes(a.status)) {
        if (a.status !== 'awaiting_receipt') active++;
        valid = n === t.attempts.length - 1 && valid;
      }
      if (a.status === 'accepted') { accepted++; valid = n === t.attempts.length - 1 && valid; }
    });
    valid = accepted <= 1 && valid;
  });
  if (!valid || active > 1) ctx.addIssue({ code: 'custom', message: 'Invalid conversation identity or order' });
});
export type Conversation = z.infer<typeof ConversationSchema>;
type StoredAnswer = z.infer<typeof Answer>;
type Failure = z.infer<typeof Attempt>['failure'];
export type MemoryErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CORRUPT' | 'LIMIT' | 'CONFLICT' | 'IO' | 'IN_USE' | 'CLOSED';
/** Never include file paths, supplied content, Zod details or filesystem causes. */
export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode) { super(`Conversation storage: ${code}`); this.name = 'MemoryError'; }
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new MemoryError('INVALID_INPUT');
  return result.data;
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const activeRoots = new Set<string>();
const activeStatus = (s: string) => ['running', 'generated', 'awaiting_receipt'].includes(s);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/** One store instance per private root, one Node process; not a cross-process lock. */
export class ConversationStore {
  private queues = new Map<string, Promise<unknown>>();
  private commitQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(readonly directory: string, private readonly clock: () => Date,
    private readonly newId: () => string) {}

  static async open(options: { directory?: string; now?: () => Date; newId?: () => string } = {}): Promise<ConversationStore> {
    try {
      const path = resolve(options.directory ?? '.recall-data');
      await fs.mkdir(path, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(path)).isDirectory() || (await fs.lstat(path)).isSymbolicLink()) throw new MemoryError('IO');
      const root = await fs.realpath(path);
      const publicPath = await fs.realpath(resolve(import.meta.dirname, '..', 'public'));
      const rel = relative(publicPath, root);
      if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) throw new MemoryError('INVALID_INPUT');
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (activeRoots.has(key)) throw new MemoryError('IN_USE');
      const store = new ConversationStore(root, options.now ?? (() => new Date()), options.newId ?? randomUUID);
      activeRoots.add(key);
      try { await store.inventory(); await store.recover(); }
      catch (e) { activeRoots.delete(key); throw e; }
      return store;
    } catch (e) { throw e instanceof MemoryError ? e : new MemoryError('IO'); }
  }
  private time(): string { return parse(Utc, this.clock().toISOString()); }
  private id(): string { return parse(Id, this.newId()); }
  private path(id: string): string { return join(this.directory, `${digest(parse(Id, id))}.json`); }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MemoryError('CLOSED'));
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation).catch((e: unknown) => {
      throw e instanceof MemoryError ? e : new MemoryError('IO');
    });
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  private commit<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.commitQueue.catch(() => {}).then(operation);
    this.commitQueue = next;
    return next;
  }
  private async inventory() {
    const files: Array<{ name: string; size: number }> = [];
    let total = 0;
    const dir = await fs.opendir(this.directory);
    for await (const entry of dir) {
      if (files.length >= MEMORY_LIMITS.directoryEntries) throw new MemoryError('LIMIT');
      const stat = await fs.lstat(join(this.directory, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(entry.name)) throw new MemoryError('CORRUPT');
      if (stat.size > MEMORY_LIMITS.fileBytes) throw new MemoryError('LIMIT');
      total += stat.size; files.push({ name: entry.name, size: stat.size });
    }
    if (total > MEMORY_LIMITS.totalBytes || files.filter((f) => f.name.endsWith('.json')).length > MEMORY_LIMITS.conversations) throw new MemoryError('LIMIT');
    return { files, total };
  }
  private async read(id: string): Promise<Conversation | undefined> {
    return this.readPath(this.path(id), id);
  }
  private async readPath(path: string, expectedId?: string): Promise<Conversation | undefined> {
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new MemoryError('CORRUPT');
      if (stat.size > MEMORY_LIMITS.fileBytes) throw new MemoryError('LIMIT');
      const file = await fs.open(path, 'r');
      try {
        const buffer = Buffer.alloc(MEMORY_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break; length += bytesRead;
        }
        if (length > MEMORY_LIMITS.fileBytes) throw new MemoryError('LIMIT');
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
        catch { throw new MemoryError('CORRUPT'); }
        const parsed = ConversationSchema.safeParse(value);
        if (!parsed.success || (expectedId !== undefined && parsed.data.id !== expectedId) ||
            basename(path) !== `${digest(parsed.data.id)}.json`) throw new MemoryError('CORRUPT');
        return parsed.data;
      } finally { await file.close(); }
    } catch (e) { if (missing(e)) return undefined; throw e; }
  }
  private async write(value: Conversation, creating = false): Promise<void> {
    if (!ConversationSchema.safeParse(value).success) throw new MemoryError('CONFLICT');
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MEMORY_LIMITS.fileBytes) throw new MemoryError('LIMIT');
    await this.commit(async () => {
      const { files, total } = await this.inventory();
      const target = this.path(value.id);
      const name = target.slice(this.directory.length + 1);
      if (creating && files.some((f) => f.name === name)) throw new MemoryError('CONFLICT');
      if ((creating && files.filter((f) => f.name.endsWith('.json')).length >= MEMORY_LIMITS.conversations) ||
          files.length >= MEMORY_LIMITS.directoryEntries || total + bytes.length > MEMORY_LIMITS.totalBytes) throw new MemoryError('LIMIT');
      // Same-directory exclusive temp. Include both old and new files in peak quota.
      const temporary = `${target}.${randomUUID()}.tmp`;
      let owned = false;
      try {
        const file = await fs.open(temporary, 'wx', 0o600); owned = true;
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, target);
        // No unlink/copy fallback. Windows sharing/AV failures leave the old file intact.
      } finally {
        if (owned) {
          try { await fs.unlink(temporary); } catch (e) { if (!missing(e)) throw e; }
        }
      }
    });
  }
  private async require(id: string): Promise<Conversation> {
    const value = await this.read(id);
    if (!value) throw new MemoryError('NOT_FOUND');
    return value;
  }
  private update<T>(id: string, action: (v: Conversation) => T): Promise<T> {
    parse(Id, id);
    return this.serial(id, async () => {
      const value = await this.require(id);
      const before = JSON.stringify(value);
      const output = action(value);
      if (before !== JSON.stringify(value)) {
        value.revision++; value.updatedAtUtc = this.time(); await this.write(value);
      }
      return structuredClone(output);
    });
  }
  async create(timezone?: string, clientKey?: string): Promise<Conversation> {
    if (timezone !== undefined) parse(Zone, timezone);
    if (clientKey !== undefined) parse(Key, clientKey);
    const id = this.id();
    return this.serial(id, async () => {
      const now = this.time();
      const value: Conversation = { schemaVersion: 'recall.memory.v1', id, revision: 0,
        createdAtUtc: now, updatedAtUtc: now, ...(timezone ? { timezone } : {}), ...(clientKey ? { clientKey } : {}), seededMessages: [], turns: [] };
      await this.write(value, true); return value;
    });
  }
  async load(id: string): Promise<Conversation | undefined> {
    parse(Id, id); return this.serial(id, () => this.read(id));
  }
  /** Legacy browser IDs are aliases, never canonical server-owned identities. */
  async resolveClientConversation(key: string, timezone?: string): Promise<Conversation> {
    parse(Key, key);
    return this.serial('$aliases', async () => {
      for (const offset of [0, 50]) for (const item of (await this.list({ offset, limit: 50 })).items) {
        const value = await this.require(item.id);
        if (value.clientKey === key || value.id === key) return value;
      }
      return this.create(timezone, key);
    });
  }
  /** Startup only. Pending receipt stays pending; never accepted. */
  private async recover(): Promise<void> {
    for (const { id } of (await this.list({ limit: MEMORY_LIMITS.pageSize })).items) await this.recoverOne(id);
    // list is bounded; walk the second page (maximum 100 conversations).
    for (const { id } of (await this.list({ offset: MEMORY_LIMITS.pageSize, limit: MEMORY_LIMITS.pageSize })).items) await this.recoverOne(id);
  }
  private recoverOne(id: string) {
    return this.update(id, (v) => {
      for (const t of v.turns) for (const a of t.attempts) {
        if (a.status === 'running' || a.status === 'generated') { a.status = 'interrupted'; a.finishedAtUtc = this.time(); }
      }
    });
  }
  async list(options: { offset?: number; limit?: number } = {}) {
    const { offset, limit } = parse(z.strictObject({ offset: z.number().int().min(0).max(100).default(0),
      limit: z.number().int().min(1).max(MEMORY_LIMITS.pageSize).default(20) }), options);
    return this.serial('$list', async () => this.commit(async () => {
      const { files } = await this.inventory();
      const items: Array<{ id: string; createdAtUtc: string; updatedAtUtc: string; turnCount: number }> = [];
      for (const { name } of files.filter((f) => f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const v = await this.readPath(join(this.directory, name));
        if (!v) throw new MemoryError('CORRUPT');
        items.push({ id: v.id, createdAtUtc: v.createdAtUtc, updatedAtUtc: v.updatedAtUtc, turnCount: v.turns.length });
      }
      return { items: items.slice(offset, offset + limit), total: items.length };
    }));
  }
  async delete(id: string): Promise<boolean> {
    parse(Id, id);
    return this.serial(id, async () => this.commit(async () => {
      const v = await this.read(id); if (!v) return false;
      if (v.turns.some((t) => t.attempts.some((a) => activeStatus(a.status)))) throw new MemoryError('CONFLICT');
      await fs.unlink(this.path(id)); return true;
    }));
  }
  async addTurn(id: string, input: { key: string; content: string; timezone?: string }) {
    const data = parse(z.strictObject({ key: Key, content: Text.max(16_000), timezone: Zone.optional() }), input);
    return this.update(id, (v) => {
      const found = v.turns.find((t) => t.key === data.key); if (found) return found; // server wins
      if (v.turns.length >= MEMORY_LIMITS.turns) throw new MemoryError('LIMIT');
      const turn: Conversation['turns'][number] = { id: this.id(), key: data.key, ordinal: v.turns.length,
        provenance: 'server_recorded', user: { id: this.id(), role: 'user', content: data.content, timestamp: this.time() },
        ...(data.timezone ? { timezone: data.timezone } : {}), attempts: [] };
      v.turns.push(turn); return turn;
    });
  }
  async seed(id: string, history: unknown) {
    const input = parse(z.array(ChatHistoryMessageSchema).max(MEMORY_LIMITS.seedBatch), history);
    return this.update(id, (v) => {
      for (const item of input) {
        const timestamp = new Date(item.timestamp).toISOString();
        const mergeKey = item.id ? `id:${item.id}` : `hash:${digest(JSON.stringify([item.role, timestamp, item.content]))}`;
        const serverMessages = v.turns.flatMap((t) => [t.user, ...t.attempts.flatMap((a) => a.answer ? [a.answer.result.message] : [])]);
        const matchesServer = serverMessages.some((m) => item.id ? item.id === m.id :
          mergeKey === `hash:${digest(JSON.stringify([m.role, new Date(m.timestamp).toISOString(), m.content]))}`);
        // Restored seeds carry their canonical server ID, not their original import ID.
        // Match identities before inspecting content: the stored original always wins.
        if (matchesServer || v.seededMessages.some((s) => s.id === item.id || s.mergeKey === mergeKey)) continue;
        if (v.seededMessages.length >= MEMORY_LIMITS.seededMessages) throw new MemoryError('LIMIT');
        v.seededMessages.push({ id: this.id(), role: item.role, content: item.content, timestamp,
          provenance: 'client_seed', mergeKey, ...(item.id ? { suppliedId: item.id } : {}), receivedAtUtc: this.time() });
      }
      return v.seededMessages;
    });
  }
  async startAttempt(id: string, turnId: string, key: string) {
    parse(Id, turnId); parse(Key, key);
    return this.update(id, (v) => {
      const t = v.turns.find((t) => t.id === turnId); if (!t) throw new MemoryError('NOT_FOUND');
      const existing = t.attempts.find((a) => a.key === key); if (existing) return existing;
      if (v.turns.some((t) => t.attempts.some((a) => ['running', 'generated'].includes(a.status))) ||
          t.attempts.some((a) => ['accepted', 'awaiting_receipt'].includes(a.status))) throw new MemoryError('CONFLICT');
      if (t.attempts.length >= MEMORY_LIMITS.attempts) throw new MemoryError('LIMIT');
      const attempt: Conversation['turns'][number]['attempts'][number] = { id: this.id(), key,
        startedAtUtc: this.time(), status: 'running' };
      t.attempts.push(attempt); return attempt;
    });
  }
  private attempt(id: string, turnId: string, attemptId: string,
    action: (a: Conversation['turns'][number]['attempts'][number]) => void) {
    parse(Id, turnId); parse(Id, attemptId);
    return this.update(id, (v) => {
      const t = v.turns.find((t) => t.id === turnId);
      const a = t?.attempts.find((a) => a.id === attemptId);
      if (!a) throw new MemoryError('NOT_FOUND');
      action(a); return a;
    });
  }
  async saveGenerated(id: string, turnId: string, attemptId: string, answer: StoredAnswer) {
    const data = parse(Answer, answer);
    return this.attempt(id, turnId, attemptId, (a) => {
      if (a.answer || a.status !== 'running') return; // original server snapshot always wins
      a.answer = { ...data, result: { ...data.result, message: { ...data.result.message, id: this.id(), timestamp: this.time() } } };
      a.status = 'generated'; a.finishedAtUtc = this.time();
    });
  }
  async markAwaitingReceipt(id: string, turnId: string, attemptId: string) {
    return this.attempt(id, turnId, attemptId, (a) => {
      if (a.status === 'generated') a.status = 'awaiting_receipt';
      else if (!['awaiting_receipt', 'accepted', 'partial'].includes(a.status)) throw new MemoryError('CONFLICT');
    });
  }
  async acknowledge(id: string, turnId: string, attemptId: string, messageId: string) {
    parse(Id, messageId);
    return this.attempt(id, turnId, attemptId, (a) => {
      if (a.answer?.result.message.id !== messageId || !['awaiting_receipt', 'accepted', 'partial'].includes(a.status)) throw new MemoryError('CONFLICT');
      a.status = a.answer.result.coverage === 'complete' ? 'accepted' : 'partial';
    });
  }
  async stopAttempt(id: string, turnId: string, attemptId: string, status: 'failed' | 'cancelled', failure?: Failure) {
    parse(z.enum(['failed', 'cancelled']), status);
    if (failure !== undefined) parse(Attempt.shape.failure, failure);
    return this.attempt(id, turnId, attemptId, (a) => {
      if (!activeStatus(a.status)) return;
      a.status = status; a.finishedAtUtc = this.time(); if (failure) a.failure = failure;
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]); await this.commitQueue.catch(() => {});
    activeRoots.delete(process.platform === 'win32' ? this.directory.toLowerCase() : this.directory);
  }
}
