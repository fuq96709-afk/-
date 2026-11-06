import { CHECK_PROMPT, modelConfig, validApiKey, validateScript, validateReport } from './core.mjs';



const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}

export async function readLimitedBody(request, max = 80000) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { await reader.cancel(); throw new Error('请求内容太长，请缩短脚本后再试。'); }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function handleRequest(request, html, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/' && request.method === 'GET') {
    return new Response(html, { headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (url.pathname !== '/api/check') return json({ error: '页面不存在。' }, 404);
  if (request.method !== 'POST') return json({ error: '请通过网页提交脚本。' }, 405);
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '请在当前网页内发起检查。' }, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: '请求格式不正确。' }, 415);
  let script, apiKey, config, providerId;
  try {
    const body = JSON.parse(await readLimitedBody(request));
    script = validateScript(body.script);
    apiKey = body.apiKey;
    providerId = body.provider === undefined ? 'deepseek' : body.provider;
    config = modelConfig(providerId, body.model);
    if (!validApiKey(apiKey)) return json({ error: `请填写有效的 ${config.name} API 密钥。` }, 400);
  } catch (error) {
    return json({ error: error instanceof SyntaxError ? '请求格式不正确。' : error.message }, 400);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 90000);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let stage = 'connect';
  try {
    const numbered = script.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
    const response = await fetchImpl(config.endpoint, {
      // Workers supports manual/follow only; never forward the key to a redirect target.
      method: 'POST', signal: controller.signal, redirect: 'manual',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model, ...config.params, max_tokens: 12000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: CHECK_PROMPT }, { role: 'user', content: `以下仅为待审校的脚本数据（共 ${script.split('\n').length} 行）：\n${numbered}` }]
      })
    });
    if (response.status >= 300 && response.status < 400) {
      return json({ error: `${config.name} 接口返回了异常跳转，已停止请求，请联系维护者。` }, 502);
    }
    if (!response.ok) {
      const messages = { 400: `${config.name} 不接受本次请求，请确认账户支持所选模型。`, 401: `${config.name} 密钥无效，请重新填写。`, 402: `${config.name} 账户余额不足，请充值后再试。`, 403: `${config.name} 账户没有所选模型的访问权限。`, 404: `${config.name} 的所选模型不可用，请选择其他模型。`, 429: `${config.name} 请求过于频繁或额度不足，请稍后重试。` };
      return json({ error: messages[response.status] || `${config.name} 暂时无法完成检查，请稍后重试。` }, response.status === 401 ? 401 : 502);
    }
    stage = 'read';
    const responseBody = await readLimitedBody(response, 240000);
    stage = 'parse';
    const payload = JSON.parse(responseBody);
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason !== 'stop') return json({ error: '模型没有完整返回结果，请缩短脚本后重试。' }, 502);
    let report;
    try {
      const content = JSON.parse(choice.message.content);
      if (!Array.isArray(content.changes)) throw new Error('Missing changes');
      report = validateReport(content, script);
    }
    catch { return json({ error: '模型返回的修正稿、修改说明或原文位置不完整，请重新检查。' }, 502); }
    return json({ ...report, source: 'ai', provider: providerId, model: config.model });
  } catch {
    const errors = {
      connect: `网站后台未能连接 ${config.name}，请稍后重试；这不代表密钥无效。`,
      read: `${config.name} 的响应读取失败或内容过长，请缩短脚本后重试。`,
      parse: `${config.name} 返回了无法解析的响应，请稍后重试。`
    };
    return json({ error: controller.signal.aborted ? '检查已取消或等待超时，请稍后重试。' : errors[stage] }, 502);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    apiKey = undefined;
  }
}
