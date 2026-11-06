import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, PROVIDERS, SAMPLE_SCRIPT, SAMPLE_REPORT, validateReport, validateScript, lineRange } from '../src/core.mjs';
import { handleRequest } from '../src/checker.mjs';

const key = 'sk-test-only-not-a-real-key';
const request = (body = { script: SAMPLE_SCRIPT, apiKey: key }, headers = {}) => new Request('https://checker.example/api/check', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});
const completion = (report = SAMPLE_REPORT, finish = 'stop') => Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(report) } }] });
const clone = () => structuredClone(SAMPLE_REPORT);

test('the six-category example has valid literal evidence and selectable positions', () => {
  const result = validateReport(SAMPLE_REPORT, SAMPLE_SCRIPT);
  assert.equal(result.issues.length, 6);
  assert.deepEqual(result.issues.map(issue => issue.type), TYPES);
  for (const issue of result.issues) {
    const range = lineRange(SAMPLE_SCRIPT, issue.startLine, issue.endLine);
    assert.ok(SAMPLE_SCRIPT.slice(range.start, range.end).includes(issue.quote));
  }
  assert.equal(result.issues.find(issue => issue.type === '产品用法').status, 'needs_confirmation');
});

test('empty and oversized scripts fail, CRLF line positions normalize correctly', () => {
  assert.throws(() => validateScript(' \n '));
  assert.throws(() => validateScript('a'.repeat(16001)));
  assert.equal(validateScript('甲\r\n\r\n乙'), '甲\n\n乙');
  assert.deepEqual(lineRange('甲\r\n\r\n乙', 3, 3), { start: 3, end: 4 });
});

test('reject invented evidence, out-of-bounds positions, missing fields and unsupported categories', () => {
  for (const change of [
    r => { r.issues[0].quote = '根本不存在的剧情'; },
    r => { r.issues[0].endLine = 100; },
    r => { r.issues[0].startLine = 0; },
    r => { r.issues[0].type = '审美评分'; },
    r => { delete r.issues[0].risk; },
    r => { r.issues[0].status = 'guaranteed'; },
    r => { r.checkedTypes.pop(); }
  ]) {
    const report = clone(); change(report); assert.throws(() => validateReport(report, SAMPLE_SCRIPT));
  }
});

test('a valid empty report is accepted without inventing issues', () => {
  assert.deepEqual(validateReport({ checkedTypes: TYPES, summary: '未发现有依据的问题。', revisedScript: '一个连续镜头。', issues: [] }, '一个连续镜头。').issues, []);
});

test('one check makes exactly one DeepSeek request with six checks and JSON mode', async () => {
  let calls = 0;
  const response = await handleRequest(request(), '', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.thinking.type, 'disabled');
    assert.ok(TYPES.every(type => body.messages[0].content.includes(type)));
    assert.ok(body.messages[1].content.includes('4 | 镜头 02'));
    assert.ok(!body.messages.some(message => message.content.includes(key)));
    assert.equal(options.redirect, 'manual');
    return completion();
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'ai');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('invalid input never calls the model', async () => {
  for (const body of [{ script: '', apiKey: key }, { script: SAMPLE_SCRIPT, apiKey: 'bad' }, { script: 'a'.repeat(16001), apiKey: key }]) {
    const response = await handleRequest(request(body), '', () => assert.fail('must not call DeepSeek'));
    assert.equal(response.status, 400);
  }
});

test('Workers-compatible requests stop redirects without forwarding credentials', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const response = await handleRequest(request(), '', async (_url, options) => {
      calls++;
      if (!['follow', 'manual'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://untrusted.example/' } });
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.match(result.error, /异常跳转/);
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('connection, response size and parsing failures have distinct safe messages', async () => {
  for (const [mock, phrase] of [
    [async () => { throw new Error(key); }, '网站后台未能连接'],
    [async () => new Response('x'.repeat(240001)), '响应读取失败或内容过长'],
    [async () => new Response(`<html>${key}</html>`), '无法解析的响应']
  ]) {
    const response = await handleRequest(request(), '', mock);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.ok(result.error.includes(phrase));
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!result.error.includes('检查网络'));
  }
});

test('cross-origin requests and non-JSON submissions are rejected before calling DeepSeek', async () => {
  const response = await handleRequest(request(undefined, { Origin: 'https://untrusted.example' }), '', () => assert.fail());
  assert.equal(response.status, 403);
  const wrongType = await handleRequest(request(undefined, { 'Content-Type': 'text/plain' }), '', () => assert.fail());
  assert.equal(wrongType.status, 415);
});

test('upstream authentication, billing and throttling failures are explained without leaking secrets', async () => {
  for (const [code, phrase] of [[401, '密钥无效'], [402, '余额不足'], [429, '过于频繁'], [500, '暂时无法']]) {
    const response = await handleRequest(request(), '', async () => new Response(key, { status: code }));
    const data = await response.json();
    assert.ok(data.error.includes(phrase));
    assert.ok(!JSON.stringify(data).includes(key));
  }
});

test('malformed, partial and ungrounded model outputs cannot become misleading results', async () => {
  const hallucinated = clone(); hallucinated.issues[0].quote = '虚构的证据';
  for (const mock of [completion(SAMPLE_REPORT, 'length'), completion(hallucinated), Response.json({ choices: [] }), new Response('not json')]) {
    const response = await handleRequest(request(), '', async () => mock);
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
  }
});

test('cancelled requests propagate an aborted signal and return no partial report', async () => {
  const abortController = new AbortController();
  abortController.abort();
  const req = new Request(request(), { signal: abortController.signal });
  const response = await handleRequest(req, '', async (_url, options) => {
    assert.ok(options.signal.aborted);
    throw new Error('aborted');
  });
  assert.equal(response.status, 502);
  assert.ok((await response.json()).error.includes('取消'));
});

test('body limits and malformed JSON fail safely', async () => {
  const large = await handleRequest(request({ script: '字'.repeat(80000), apiKey: key }), '', () => assert.fail());
  assert.equal(large.status, 400);
  const bad = new Request('https://checker.example/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await handleRequest(bad, '', () => assert.fail())).status, 400);
});

test('the app is served without login and unknown routes do not expose source files', async () => {
  const response = await handleRequest(new Request('https://checker.example/'), '<html>test</html>');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>test</html>');
  assert.equal((await handleRequest(new Request('https://checker.example/.env'), '')).status, 404);
});

test('every model routes once to its own official endpoint with compatible parameters', async () => {
  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    for (const model of provider.models) {
      let calls = 0;
      const selectedKey = providerId === 'zhipu' ? 'test-key-id.test-key-secret' : `sk-test-${providerId}-only`;
      const response = await handleRequest(request({ script: SAMPLE_SCRIPT, apiKey: selectedKey, provider: providerId, model }), '', async (url, options) => {
        calls++;
        assert.equal(url, provider.endpoint);
        assert.equal(options.headers.Authorization, `Bearer ${selectedKey}`);
        const body = JSON.parse(options.body);
        assert.equal(body.model, model);
        assert.equal(body.response_format.type, 'json_object');
        if (providerId === 'kimi') assert.equal(body.temperature, undefined);
        if (model === 'kimi-k3') { assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, 'low'); }
        else assert.equal(body.thinking.type, 'disabled');
        return completion();
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.provider, providerId); assert.equal(result.model, model); assert.equal(calls, 1);
    }
  }
});

test('unsupported providers, cross-provider models and injected endpoints cannot receive credentials', async () => {
  for (const selection of [
    { provider: 'gpt' }, { provider: '__proto__' }, { provider: ['kimi'] },
    { provider: 'kimi', model: 'glm-4.7' }, { provider: 'zhipu', model: 'https://attacker.example' }
  ]) {
    const response = await handleRequest(request({ script: SAMPLE_SCRIPT, apiKey: key, ...selection }), '', () => assert.fail('must not forward credentials'));
    assert.equal(response.status, 400);
  }
});

test('model permission errors name the selected service and never expose upstream content', async () => {
  for (const provider of ['kimi', 'zhipu']) {
    const response = await handleRequest(request({ script: SAMPLE_SCRIPT, apiKey: key, provider }), '', async () => new Response(key, { status: 403 }));
    const result = await response.json();
    assert.ok(result.error.includes(PROVIDERS[provider].name));
    assert.ok(result.error.includes('访问权限'));
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('complete revised script survives the API response unchanged, with original issue positions', async () => {
  const response = await handleRequest(request(), '', async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    assert.ok(prompt.includes('修正后的完整脚本'));
    assert.ok(prompt.includes('保留原剧情'));
    assert.ok(prompt.includes('待确认'));
    return completion();
  });
  const result = await response.json();
  assert.equal(result.revisedScript, SAMPLE_REPORT.revisedScript);
  assert.deepEqual(result.issues.map(i => i.startLine), SAMPLE_REPORT.issues.map(i => i.startLine));
  assert.notEqual(result.revisedScript, SAMPLE_SCRIPT);
});

test('missing, blank, oversized and unsolicited revised scripts are rejected', async () => {
  for (const revisedScript of [undefined, '', '  ', {}, '字'.repeat(32001)]) {
    const report = { ...clone(), revisedScript };
    assert.throws(() => validateReport(report, SAMPLE_SCRIPT));
    const response = await handleRequest(request(), '', async () => completion(report));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).revisedScript, undefined);
  }
  assert.throws(() => validateReport({ checkedTypes: TYPES, summary: '没有问题', issues: [], revisedScript: '删掉剧情的缩写' }, SAMPLE_SCRIPT));
  const unchanged = validateReport({ checkedTypes: TYPES, summary: '没有问题', issues: [], revisedScript: SAMPLE_SCRIPT }, SAMPLE_SCRIPT);
  assert.equal(unchanged.revisedScript, SAMPLE_SCRIPT);
});

test('change explanations are grounded in both scripts and round-trip through the API', async () => {
  const response = await handleRequest(request(), '', async () => completion());
  assert.deepEqual((await response.json()).changes, SAMPLE_REPORT.changes);
  for (const mutate of [
    r => { r.changes[0].before = '原稿没有这句话'; },
    r => { r.changes[0].after = '修正稿没有这句话'; },
    r => { r.changes[0].startLine = 999; },
    r => { r.changes[0].reason = ''; },
    r => { r.changes = []; },
    r => { delete r.changes; }
  ]) {
    const result = clone(); mutate(result);
    assert.equal((await handleRequest(request(), '', async () => completion(result))).status, 502);
  }
  const script = '小林坐在窗边。';
  const unchanged = { checkedTypes: TYPES, summary: '未发现问题。', revisedScript: script, issues: [], changes: [] };
  assert.equal((await handleRequest(request({ script, apiKey: key }), '', async () => completion(unchanged))).status, 200);
});
