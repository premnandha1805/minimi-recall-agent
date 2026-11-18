const root = process.env.LIVE_URL ?? 'http://127.0.0.1:3000';
for (const message of ['I have an Infosys meeting on 23 August.', 'What meeting did I tell you about?',
  'Do I have any meeting coming up?', 'Do I have anything planned?']) {
  const start = performance.now();
  const response = await fetch(`${root}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, conversationId: crypto.randomUUID(), timezone: 'Asia/Kolkata' }) });
  console.log(JSON.stringify({ message, requestId: response.headers.get('x-request-id'),
    response: await response.text(), durationMs: Math.round(performance.now() - start) }));
}
console.log(await (await fetch(`${root}/api/debug/memory`)).text());
