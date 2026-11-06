import test from 'node:test';
import assert from 'node:assert/strict';
import { connectCheckerHost } from '../src/host.mjs';

test('App bridge initializes, ignores forged senders and sends the script only on explicit request', async () => {
  const handlers = new Map(), sent = [], results = [], states = [];
  const parent = { postMessage(message) {
    sent.push(message);
    if (message.id) queueMicrotask(() => handlers.get('message')({ source: parent, data: { jsonrpc: '2.0', id: message.id, result: {} } }));
  } };
  globalThis.window = { parent, addEventListener(name, fn) { handlers.set(name, fn); } };
  try {
    const host = connectCheckerHost(data => results.push(data), (connected, message) => states.push({ connected, message }));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(states.at(-1).connected);
    assert.equal(sent[0].method, 'ui/initialize');
    assert.equal(sent.filter(m => m.method === 'ui/message').length, 0);
    const event = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { source: 'chatgpt', originalScript: '原稿' } } };
    handlers.get('message')({ source: {}, data: event });
    assert.equal(results.length, 0);
    handlers.get('message')({ source: parent, data: event });
    assert.equal(results[0].originalScript, '原稿');
    await host.send('明确提交的脚本检查请求');
    assert.deepEqual(sent.at(-1).params, { role: 'user', content: [{ type: 'text', text: '明确提交的脚本检查请求' }] });
    const calls = [];
    window.openai = { async sendFollowUpMessage(data) { calls.push(data); } };
    await host.send('继续修改');
    assert.equal(calls[0].prompt, '继续修改');
  } finally { delete globalThis.window; }
});

test('standalone App preview cannot claim a GPT connection or send a request', async () => {
  const messages = [];
  const fake = { addEventListener() {} }; fake.parent = fake;
  globalThis.window = fake;
  try {
    const host = connectCheckerHost(() => assert.fail(), (connected, message) => messages.push({ connected, message }));
    await assert.rejects(host.send('脚本'), /请在 ChatGPT/);
    assert.equal(messages[0].connected, false);
    assert.ok(messages[0].message.includes('预览'));
  } finally { delete globalThis.window; }
});
