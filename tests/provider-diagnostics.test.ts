import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createModelProvider, modelFailureDiagnostic, ModelProviderError } from '../src/model.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, json } from './fixtures/chat-stream.js';

it.each([400, 401, 403, 404, 422, 429, 500, 503])('logs HTTP %i without body, credentials or hidden retries; preserves user turn', async (status) => {
  const directory = await mkdtemp(join(tmpdir(), 'recall-provider-diagnostic-'));
  const lines: string[] = [];
  const logStream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const network = vi.fn<typeof fetch>(async () => json({ error: { message:'PRIVATE_UPSTREAM_MESSAGE', code:'PRIVATE_UPSTREAM_CODE' } }, status));
  const app = buildServer({ memoryDirectory:directory,config:loadConfig(azureEnv),fetchImpl:network,logStream });
  try {
    const conversation = (await app.inject({method:'POST',url:'/api/conversations',payload:{}})).json();
    const send = (attemptKey:string) => app.inject({method:'POST',url:'/api/chat',payload:{conversationId:conversation.id,
      message:'PRIVATE_WORKSHOP_DETAILS',turn:{key:'same-user-turn',attemptKey},timezone:'UTC'}});
    const first = await send('first');
    const streamed = await readChatStream(new Response(first.body));
    expect(streamed.error?.code).toBe('MODEL_FAILED'); expect(streamed.result).toBeUndefined();
    const events = lines.flatMap((line)=>line.trim().split('\n').map((row)=>JSON.parse(row)));
    const model = events.find((event)=>event.stage==='model_call');
    expect(model).toMatchObject({requestId:first.headers['x-request-id'],outcome:'failure',modelFailure:{code:'HTTP_ERROR',httpStatus:status}});
    expect(network).toHaveBeenCalledTimes(1);
    const saved = (await app.inject(`/api/conversations/${conversation.id}`)).json();
    expect(saved.turns).toHaveLength(1); expect(saved.turns[0].user.content).toBe('PRIVATE_WORKSHOP_DETAILS');
    expect(saved.turns[0].attempts[0]).toMatchObject({status:'failed',failure:'MODEL_FAILED'});
    expect(saved.turns[0].attempts[0].answer).toBeUndefined();
    await send('second');
    const retried = (await app.inject(`/api/conversations/${conversation.id}`)).json();
    expect(retried.turns).toHaveLength(1); expect(retried.turns[0].user).toEqual(saved.turns[0].user);
    expect(retried.turns[0].attempts).toHaveLength(2); expect(network).toHaveBeenCalledTimes(2);
    const output = lines.join('');
    for(const privateText of ['PRIVATE_WORKSHOP_DETAILS','PRIVATE_UPSTREAM_MESSAGE','PRIVATE_UPSTREAM_CODE',azureEnv.AZURE_OPENAI_API_KEY,azureEnv.TAVILY_API_KEY,azureEnv.AZURE_OPENAI_CHAT_ENDPOINT]) expect(output).not.toContain(privateText);
  } finally { await app.close(); await rm(directory,{recursive:true,force:true}); }
});

it.each(['ENOTFOUND','ECONNREFUSED','ETIMEDOUT','CERT_HAS_EXPIRED','PRIVATE_CODE'])('sanitizes network cause %s',async(code)=>{
  const provider=createModelProvider(loadConfig(azureEnv),async()=>{throw new Error('PRIVATE_URL', {cause:{code,message:'PRIVATE_CAUSE'}});});
  try {
    await provider.complete({messages:[{role:'user',content:'Hello'}],tools:[],maxOutputTokens:100,signal:new AbortController().signal});
    expect.unreachable();
  } catch(error) {
    expect(modelFailureDiagnostic(error)).toEqual({code:'NETWORK_ERROR',...(code==='PRIVATE_CODE'?{}:{networkCode:code})});
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE/);
  }
});
it('distinguishes invalid responses without claiming an HTTP failure',async()=>{
  const provider=createModelProvider(loadConfig(azureEnv),async()=>json({not:'a completion'}));
  await expect(provider.complete({messages:[{role:'user',content:'Hello'}],tools:[],maxOutputTokens:100,signal:new AbortController().signal}))
    .rejects.toMatchObject({code:'INVALID_RESPONSE'});
  expect(modelFailureDiagnostic(new ModelProviderError('INVALID_RESPONSE'))).toEqual({code:'INVALID_RESPONSE'});
  expect(modelFailureDiagnostic(new Error('PRIVATE'))).toBeUndefined();
});
it('rejects diagnostic values outside the safe allowlists',()=>{
  expect(modelFailureDiagnostic(new ModelProviderError('HTTP_ERROR', NaN))).toEqual({code:'HTTP_ERROR'});
  const fake=new ModelProviderError('NETWORK_ERROR'); Object.defineProperty(fake,'networkCode',{get:()=>{throw new Error('PRIVATE');}});
  expect(modelFailureDiagnostic(fake)).toBeUndefined();
});
