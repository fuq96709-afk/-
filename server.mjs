import { createServer } from 'node:http';
import worker from './dist/server/index.js';

const port = Number(process.env.PORT || 4173);
createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method, headers, signal: controller.signal,
      ...(incoming.method !== 'GET' && incoming.method !== 'HEAD' ? { body: incoming, duplex: 'half' } : {})
    });
    const response = await worker.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.destroyed) { outgoing.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify({ error: '本地检查服务暂时不可用。' })); }
  }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
