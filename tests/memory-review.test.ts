import { expect, it } from 'vitest';
import { recallIntent, retrieveMemory } from '../src/context.js';
import { rankMemory } from '../src/memory-ranking.js';
import { groundedRecallAnswer, groundHistoricalProse } from '../src/recall-answer.js';
import { runAgent } from '../src/agent.js';
import { history, fixtureId, referenceInstant } from './fixtures/universal-memory.js';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, json, wire } from './fixtures/chat-stream.js';
const value = history(10, ['I chose PostgreSQL.']);
const store = { load: async () => value, list: async () => ({ total: 1, items: [{ id:value.id, createdAtUtc:value.createdAtUtc, updatedAtUtc:value.updatedAtUtc, turnCount:1 }] }) };
const opts = (query: string) => ({ query, activeConversationId:fixtureId(999), currentTurnId:fixtureId(998), referenceInstant, timezone:'UTC', signal:new AbortController().signal, startedAt:performance.now(), deadlineMs:25000 });
it.each(["What is my dog's name?", 'Which hotel did I choose?', 'What framework did I learn?', 'What did I previously decide?', 'Where did I buy my laptop?'])('private recall: %s', (q) => expect(recallIntent(q)).toEqual({recall:true,memoryOnly:true}));
it('does not assign unrelated documents a score for empty lookup anchors', () => expect(rankMemory([], [['garden'],['database']])).toEqual([0,0]));
it('keeps partial decisions even when an exact overview exists', () => {
  const scores = rankMemory(['atlas','database','decision'], [['atlas','database','decision','overview'], ['atlas','decision','postgresql']]);
  expect(scores[1]).toBeGreaterThan(0);
});
it('ambiguous topic-free recall asks for a locator rather than arbitrary facts', async () => {
  const m = await retrieveMemory(store, opts('What did I previously decide?'));
  expect(m.records).toEqual([]); expect(m.status).toBe('ambiguous');
});
it('natural evidence answer', async () => {
  const m = await retrieveMemory(store, opts('What did I choose?'));
  m.records = [{conversationId:value.id,turnId:value.turns[0].id,ordinal:0,provenance:'server_recorded',user:value.turns[0].user,evidence:[]}]; m.status='found'; delete m.limitation;
  const answer = groundedRecallAnswer(JSON.stringify({memoryEvidence:[{messageId:value.turns[0].user.id,quote:'I chose PostgreSQL.'}]}), m, 'What database did I choose?');
  expect(answer).toContain('You chose PostgreSQL.'); expect(answer.length).toBeLessThan(500);
});
it('bounds multiple long original messages', async () => {
  const m = await retrieveMemory(store, opts('Recall PostgreSQL'));
  m.records = Array.from({length:3},(_,i) => ({conversationId:value.id,turnId:fixtureId(i+100),ordinal:i,provenance:'server_recorded' as const,user:{...value.turns[0].user,id:fixtureId(i+200),content:'Long original. '.repeat(1000)},evidence:[]}));
  expect(groundedRecallAnswer('{}',m).length).toBeLessThanOrEqual(16000);
});
it('blocks invented non-calendar personal claims while preserving web reasoning', async () => {
  const m = await retrieveMemory(store, opts('Recall PostgreSQL and search the web for its documentation'));
  const response = await runAgent({message:'Recall PostgreSQL and search the web for its documentation'}, {memory:m,signal:new AbortController().signal,
    provider:{contextWindowTokens:65536,complete:async()=>({text:'You chose MongoDB. Recursion uses a base case.',finishReason:'stop',toolCalls:[]})}});
  expect(response.answer).not.toContain('You chose MongoDB'); expect(response.answer).toContain('Recursion uses a base case.');
});
it.each([
  ['What is my axolotl called?', 'My axolotl is called Nimbus.'],
  ['Which hotel did I choose?', 'I chose the Juniper hotel.'],
  ['What framework did I learn?', 'I learned the Svelte framework.'],
  ['Where did I buy my laptop?', 'I bought my laptop in Kochi.'],
])('retrieves arbitrary user facts: %s', async (query, content) => {
  const v = history(30,[content]);
  const m = await retrieveMemory({...store,load:async()=>v},opts(query));
  expect(m.records.map((r)=>r.user.content)).toContain(content); expect(m.memoryOnly).toBe(true);
});
it.each(['You chose MongoDB [S1].', 'Your colleague is Ravi.', 'You previously paid USD 500.', 'The selected database was MongoDB.', 'You chose MongoDB for your appointment.'])('rejects arbitrary fabricated mixed history: %s', async (claim) => {
  const m = await retrieveMemory(store,opts('Recall PostgreSQL'));
  expect(groundHistoricalProse(claim+' A recursive function needs a base case.',m)).not.toContain(claim);
  expect(groundHistoricalProse(claim+' A recursive function needs a base case.',m)).toContain('A recursive function needs a base case.');
});
it('transcript requests retain original wording', async()=>{
  const m = await retrieveMemory(store,opts('Recall PostgreSQL'));
  const text = JSON.stringify({memoryEvidence:[{messageId:value.turns[0].user.id,quote:value.turns[0].user.content}]});
  expect(groundedRecallAnswer(text,m,'Show the original messages')).toContain('> I chose PostgreSQL.');
});
it('retains cross-conversation named corrections and multi-turn reference chains', async()=>{
  const first = history(10,['I chose PostgreSQL for Atlas.', 'It needs a maintenance plan.', 'Actually, use SQLite for it.']);
  const second = history(30,['Correction: the Atlas database will use MariaDB.'],'2026-11-04T10:00:00.000Z');
  const db={load:async(id:string)=>id===first.id?first:second,list:async()=>({total:2,items:[first,second].map(v=>({id:v.id,createdAtUtc:v.createdAtUtc,updatedAtUtc:v.updatedAtUtc,turnCount:v.turns.length}))})};
  const m=await retrieveMemory(db,opts('Recall our Atlas database'));
  expect(m.records.map(r=>r.user.content)).toContain(second.turns[0].user.content);
  expect(m.records.map(r=>r.user.content)).toContain(first.turns[2].user.content);
});
it('chronological recall remains explicit despite empty topics',async()=>{
  const m=await retrieveMemory(store,opts('What did we discuss on 3 November?'));
  expect(m.records).toHaveLength(1);
});
it('keeps mixed public research enabled for arbitrary private subjects',()=>{
  expect(recallIntent('What is my axolotl called and what is the latest animal welfare news?')).toEqual({recall:true,memoryOnly:false});
});
it('persists and streams a bounded result for several oversized historical originals',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'recall-review-length-'));
  const db=await ConversationStore.open({directory:root,now:()=>new Date('2026-11-03T10:00:00Z')});
  let app: ReturnType<typeof buildServer> | undefined;
  try {
    const c=await db.create('UTC');
    for(let n=0;n<3;n++) await db.addTurn(c.id,{key:`long${n}`,content:'I chose PostgreSQL. '+ 'Supporting notes. '.repeat(350)});
    await db.close();
    app=buildServer({memoryDirectory:root,config:loadConfig(azureEnv),logger:false,fetchImpl:async()=>json(wire('{}'))});
    const response=await app.inject({method:'POST',url:'/api/chat',payload:{message:'Recall PostgreSQL',timezone:'UTC'}});
    const stream=await readChatStream(new Response(response.body));
    expect(stream.error).toBeUndefined(); expect(stream.result?.message.content.length).toBeLessThanOrEqual(16000);
    expect(stream.result?.message.content).toMatch(/narrow|limit/i);
    const saved=(await app.inject(`/api/conversations/${response.headers['x-conversation-id']}`)).json();
    expect(saved.turns[0].attempts[0].answer.result.message.content).toBe(stream.result?.message.content);
  } finally {await app?.close();await db.close();await fs.rm(root,{recursive:true,force:true});}
});
