import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSyncRequest, syncContext, createSyncTask, readSyncTask, writeSyncResult, clearSyncTask } from '../src/sync.mjs';
import { handleMCP } from '../src/mcp.mjs';
import { SAMPLE_SCRIPT, SAMPLE_REPORT } from '../src/core.mjs';

class Bucket {
  records = new Map(); sequence = 0;
  async get(key) { const r = this.records.get(key); return r ? { etag: r.etag, json: async () => JSON.parse(r.text) } : null; }
  async put(key, text, options) {
    if (options?.onlyIf?.etagMatches && this.records.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    const etag = String(++this.sequence); this.records.set(key, { text, etag }); return { etag };
  }
}
const req = (body, user = 'owner') => new Request('https://checker.example/api/sync', {
  method: body ? 'POST' : 'GET', headers: { ...(user ? { 'oai-authenticated-user-id': user } : {}), 'Content-Type': 'application/json', Origin: 'https://checker.example' }, ...(body ? { body: JSON.stringify(body) } : {})
});
const context = (bucket, user = 'owner') => syncContext(req(null, user), { BUCKET: bucket });

test('web submits original, connected GPT reads it, writes result and same web receives full script', async () => {
  const env = { BUCKET: new Bucket() }, taskId = crypto.randomUUID();
  const created = await handleSyncRequest(req({ action: 'create', script: SAMPLE_SCRIPT, taskId }), env);
  assert.equal(created.status, 200);
  const mcp = (name, args = {}) => new Request('https://checker.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'owner' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const pending = await (await handleMCP(mcp('read_pending_script'), '', env)).json();
  assert.equal(pending.result.structuredContent.originalScript, SAMPLE_SCRIPT);
  assert.equal(pending.result.structuredContent.taskId, taskId);
  const written = await (await handleMCP(mcp('show_script_check_result', { taskId, originalScript: SAMPLE_SCRIPT, report: SAMPLE_REPORT }), '', env)).json();
  assert.equal(written.result.structuredContent.status, 'completed');
  const received = await (await handleSyncRequest(req(), env)).json();
  assert.equal(received.status, 'completed');
  assert.equal(received.originalScript, SAMPLE_SCRIPT);
  assert.equal(received.report.revisedScript, SAMPLE_REPORT.revisedScript);
  const other = await (await handleSyncRequest(req(null, 'other-user'), env)).json();
  assert.equal(other.status, 'empty');
});

test('identity and origin checks prevent unauthorized data access and foreign submissions', async () => {
  const env = { BUCKET: new Bucket() };
  assert.equal((await handleSyncRequest(req(null, null), env)).status, 401);
  const foreign = req({ action: 'create', script: SAMPLE_SCRIPT, taskId: crypto.randomUUID() });
  foreign.headers.set('Origin', 'https://attacker.example');
  assert.equal((await handleSyncRequest(foreign, env)).status, 403);
  assert.equal((await handleSyncRequest(req(), {})).status, 503);
});

test('new jobs, different scripts and invalid reports cannot overwrite the current job', async () => {
  const bucket = new Bucket(), c = await context(bucket), first = crypto.randomUUID(), second = crypto.randomUUID();
  await createSyncTask(c, SAMPLE_SCRIPT, first);
  await createSyncTask(c, SAMPLE_SCRIPT, second);
  await assert.rejects(writeSyncResult(c, first, SAMPLE_SCRIPT, SAMPLE_REPORT), /任务已被替换/);
  await assert.rejects(writeSyncResult(c, second, SAMPLE_SCRIPT + '新行', SAMPLE_REPORT), /原稿不一致/);
  await assert.rejects(writeSyncResult(c, second, SAMPLE_SCRIPT, { ...SAMPLE_REPORT, revisedScript: '' }));
  assert.equal((await readSyncTask(c)).status, 'waiting');
  await clearSyncTask(c, second);
  assert.equal((await readSyncTask(c)).status, 'empty');
  await assert.rejects(writeSyncResult(c, second, SAMPLE_SCRIPT, SAMPLE_REPORT));
  assert.ok(![...bucket.records.values()][0].text.includes(SAMPLE_SCRIPT));
});

test('conditional writes reject a task changed during result submission', async () => {
  const bucket = new Bucket(), c = await context(bucket), id = crypto.randomUUID();
  await createSyncTask(c, SAMPLE_SCRIPT, id);
  const originalPut = bucket.put.bind(bucket);
  bucket.put = async (key, text, options) => {
    if (options?.onlyIf) await originalPut(key, JSON.stringify({ taskId: crypto.randomUUID(), originalScript: 'new', status: 'waiting', expiresAt: Date.now() + 10000 }));
    return originalPut(key, text, options);
  };
  await assert.rejects(writeSyncResult(c, id, SAMPLE_SCRIPT, SAMPLE_REPORT), /提交期间任务已变更/);
  assert.equal((await readSyncTask(c)).originalScript, 'new');
});

test('duplicate submission is stable and expired content is cleared on access', async () => {
  const bucket = new Bucket(), c = await context(bucket), id = crypto.randomUUID();
  const first = await createSyncTask(c, SAMPLE_SCRIPT, id);
  assert.deepEqual(await createSyncTask(c, SAMPLE_SCRIPT, id), first);
  await assert.rejects(createSyncTask(c, 'changed', id), /不能替换原稿/);
  await bucket.put(c.key, JSON.stringify({ ...first, expiresAt: 1 }));
  assert.equal((await readSyncTask(c)).status, 'empty');
  assert.ok(![...bucket.records.values()][0].text.includes(SAMPLE_SCRIPT));
});
