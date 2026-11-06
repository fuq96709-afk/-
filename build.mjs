import { readFile, mkdir, writeFile } from 'node:fs/promises';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const core = (await read('./src/core.mjs')).replace(/^export /gm, '');
const app = (await read('./src/app.mjs')).replace(/^import .*?;\n/gm, '');
const host = (await read('./src/host.mjs')).replace(/^export /gm, '');
const history = (await read('./src/history.mjs')).replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
const syncServer = (await read('./src/sync.mjs')).replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
const mcp = (await read('./src/mcp.mjs')).replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
const checker = (await read('./src/checker.mjs')).replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
const html = (await read('./src/index.html'))
  .replace('/* STYLES */', await read('./src/style.css'))
  .replace('/* APP */', `${core}\n${host}\n${history}\n${app}`);
const widget = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-chatgpt-app="true">').replace('<main>', '<main><p id="hostStatus" class="host-status" role="status">正在连接 ChatGPT…</p>').replace('MVP / 01', 'CHATGPT APP').replace('class="brand" href="/"', 'class="brand" href="#title"');
await mkdir(new URL('./dist/server/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/server/index.js', import.meta.url), `${core}\n${checker}\n${syncServer}\n${mcp}\nconst WIDGET = ${JSON.stringify(widget)};\nconst HTML = ${JSON.stringify(html)};\nexport default { fetch(request, env) { const path = new URL(request.url).pathname; if (path === '/mcp') return handleMCP(request, WIDGET, env); if (path === '/api/sync') return handleSyncRequest(request, env); if (path === '/app-preview') return handleRequest(new Request(new URL('/', request.url), request), WIDGET); return handleRequest(request, HTML); } };\n`);
console.log('Built dependency-free webpage and Worker.');
