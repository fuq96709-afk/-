import { validateScript, validateReport } from './core.mjs';
import { readLimitedBody } from './checker.mjs';

const TASK_TTL = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function syncError(message, status = 400) { return Object.assign(new Error(message), { status }); }
export async function syncContext(request, env) {
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) throw syncError('请使用同一个 ChatGPT 账户登录网页并连接续镜插件。', 401);
  if (!env?.BUCKET) throw syncError('同页同步服务尚未就绪，请稍后重试。', 503);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user));
  const key = `current-script/${Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')}.json`;
  return { bucket: env.BUCKET, key };
}

async function current(context) {
  const object = await context.bucket.get(context.key);
  if (!object) return null;
  const data = await object.json();
  if (data.expiresAt <= Date.now() && data.status !== 'cleared') {
    await context.bucket.put(context.key, JSON.stringify({ status: 'cleared', expiresAt: 0 }), { onlyIf: { etagMatches: object.etag } });
    return null;
  }
  if (data.status === 'cleared') return null;
  return { data, etag: object.etag };
}

export async function createSyncTask(context, script, taskId) {
  const originalScript = validateScript(script);
  if (!UUID.test(taskId)) throw syncError('任务标识不正确，请重新提交。');
  const previous = await current(context);
  if (previous?.data.taskId === taskId) {
    if (previous.data.originalScript !== originalScript) throw syncError('同一任务不能替换原稿。', 409);
    return previous.data;
  }
  const data = { taskId, originalScript, status: 'waiting', report: null, expiresAt: Date.now() + TASK_TTL };
  await context.bucket.put(context.key, JSON.stringify(data));
  return data;
}

export async function readSyncTask(context) {
  const record = await current(context);
  return record?.data || { status: 'empty' };
}

export async function writeSyncResult(context, taskId, originalScript, report) {
  if (!UUID.test(taskId)) throw syncError('任务标识不正确。');
  const record = await current(context);
  if (!record || record.data.taskId !== taskId) throw syncError('任务已被替换、清除或过期。请重新读取当前网页任务。', 409);
  if (validateScript(originalScript) !== record.data.originalScript) throw syncError('返回结果与提交的原稿不一致，请使用读取到的完整原稿。', 409);
  const validated = validateReport(report, originalScript);
  const data = { ...record.data, report: validated, status: 'completed' };
  const written = await context.bucket.put(context.key, JSON.stringify(data), { onlyIf: { etagMatches: record.etag } });
  if (!written) throw syncError('提交期间任务已变更。请读取最新任务，不要覆盖新脚本。', 409);
  return data;
}

export async function clearSyncTask(context, taskId) {
  const record = await current(context);
  if (!record) return { status: 'empty' };
  if (record.data.taskId !== taskId) throw syncError('当前任务已改变，未清除新任务。', 409);
  const written = await context.bucket.put(context.key, JSON.stringify({ status: 'cleared', expiresAt: 0 }), { onlyIf: { etagMatches: record.etag } });
  if (!written) throw syncError('任务刚刚发生变化，未清除。请检查最新状态。', 409);
  return { status: 'empty' };
}

export async function handleSyncRequest(request, env) {
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  try {
    const context = await syncContext(request, env);
    if (request.method === 'GET') return response(await readSyncTask(context));
    if (request.method !== 'POST') return response({ error: '不支持该操作。' }, 405);
    if (request.headers.get('Origin') !== new URL(request.url).origin) return response({ error: '请在当前网页内提交。' }, 403);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return response({ error: '请求格式不正确。' }, 415);
    const body = JSON.parse(await readLimitedBody(request, 80000));
    if (body.action === 'clear') return response(await clearSyncTask(context, body.taskId));
    if (body.action !== 'create') return response({ error: '操作不正确。' }, 400);
    return response(await createSyncTask(context, body.script, body.taskId));
  } catch (e) { return response({ error: e.status ? e.message : '无法完成同步操作，请稍后重试。' }, e.status || 400); }
}
