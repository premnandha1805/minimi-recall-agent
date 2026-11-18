import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConversationStore, MemoryError, type Conversation } from './memory.js';
import type { ChatHistoryMessage } from './contracts.js';

/** Normalize supplied history only; automatic retrieval belongs to the next milestone. */
export function authoritativeHistory(value: Conversation, history: ChatHistoryMessage[], ordinal: number): ChatHistoryMessage[] {
  const hash = (m: ChatHistoryMessage) => createHash('sha256').update(JSON.stringify([
    m.role, new Date(m.timestamp).toISOString(), m.content])).digest('hex');
  return history.flatMap((supplied) => {
    for (const turn of value.turns) {
      const messages = [{ message: turn.user, eligible: turn.ordinal < ordinal }, ...turn.attempts.flatMap((a) =>
        a.answer ? [{ message: a.answer.result.message, eligible: a.status === 'accepted' && turn.ordinal < ordinal }] : [])];
      for (const { message, eligible } of messages) {
        if (supplied.id ? supplied.id === message.id : hash(supplied) === hash(message)) return eligible ? [message] : [];
      }
    }
    const key = supplied.id ? `id:${supplied.id}` : `hash:${hash(supplied)}`;
    const seed = value.seededMessages.find((s) => s.id === supplied.id || s.mergeKey === key);
    return seed ? [{ id: seed.id, role: seed.role, content: seed.content, timestamp: seed.timestamp }] : [];
  });
}

const Id = z.uuid();
const identity = z.strictObject({ id: Id, turnId: Id, attemptId: Id });
function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MemoryError('INVALID_INPUT');
  return result.data;
}
/** Local single-user protection; conversation IDs are not public-deployment auth. */
export function allowLocalMemory(request: FastifyRequest): boolean {
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || host.username || host.password) return false;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return false;
    const address = request.server.server.address();
    if (address && typeof address !== 'string' && Number(host.port || 80) !== address.port) return false;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== host.origin) return false;
    return !request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']));
  } catch { return false; }
}

export function installMemoryHttp(app: FastifyInstance, directory?: string, debug = process.env.NODE_ENV !== 'production' || process.env.DEBUG_MEMORY === '1', migrateLegacy = false) {
  let pendingStore: Promise<ConversationStore> | undefined;
  const jobs = new Set<Promise<unknown>>();
  const getStore = () => pendingStore ??= (async () => {
    if (migrateLegacy && directory) {
      const legacy = resolve(import.meta.dirname, '..', '.recall-data');
      try { await fs.access(directory); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        try { await fs.cp(legacy, directory, { recursive: true, force: false, errorOnExist: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    return ConversationStore.open({ directory, cachedSnapshots: true, recoverCorrupt: true, maxConversations: 1000 });
  })();
  const track = <T>(job: Promise<T>) => {
    jobs.add(job); void job.finally(() => jobs.delete(job)).catch(() => {}); return job;
  };
  app.addHook('onClose', async () => {
    await Promise.allSettled([...jobs]);
    if (pendingStore) { const store = await pendingStore.catch(() => undefined); await store?.close(); }
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0].startsWith('/api/conversations') || request.url.split('?')[0] === '/api/chat' || request.url.split('?')[0] === '/api/debug/memory') {
      reply.header('Cache-Control', 'no-store');
      if (!allowLocalMemory(request)) return reply.code(403).send({ error: { code: 'LOCAL_ACCESS_REQUIRED',
        message: 'Local same-origin access is required.' }, requestId: request.id });
    }
  });
  if (debug) app.get('/api/debug/memory', async () => (await getStore()).diagnostics());
  app.post('/api/conversations', async (request, reply) => {
    valid(z.strictObject({}), request.body ?? {});
    return reply.code(201).send(await (await getStore()).create());
  });
  app.get('/api/conversations', async (request) => {
    const query = valid(z.strictObject({ offset: z.coerce.number().int().min(0).max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional() }), request.query);
    return (await getStore()).list(query);
  });
  app.get('/api/conversations/:id', async (request) => {
    const { id } = valid(z.strictObject({ id: Id }), request.params);
    const value = await (await getStore()).load(id);
    if (!value) throw new MemoryError('NOT_FOUND');
    return value;
  });
  app.delete('/api/conversations/:id', async (request) => {
    const { id } = valid(z.strictObject({ id: Id }), request.params);
    return { deleted: await (await getStore()).delete(id) };
  });
  const base = '/api/conversations/:id/turns/:turnId/attempts/:attemptId';
  app.get(`${base}/result`, async (request) => {
    const { id, turnId, attemptId } = valid(identity, request.params);
    const value = await (await getStore()).load(id);
    const attempt = value?.turns.find((t) => t.id === turnId)?.attempts.find((a) => a.id === attemptId);
    if (!attempt) throw new MemoryError('NOT_FOUND');
    if (!['awaiting_receipt', 'accepted', 'partial'].includes(attempt.status) || !attempt.answer) throw new MemoryError('CONFLICT');
    return { status: attempt.status, result: attempt.answer.result };
  });
  app.post(`${base}/receipt`, async (request) => {
    const { id, turnId, attemptId } = valid(identity, request.params);
    const { messageId } = valid(z.strictObject({ messageId: Id }), request.body);
    return (await getStore()).acknowledge(id, turnId, attemptId, messageId);
  });
  return { getStore, track, executing: new Set<string>() };
}
