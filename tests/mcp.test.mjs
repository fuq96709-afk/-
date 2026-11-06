import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMCP, WIDGET_URI } from '../src/mcp.mjs';
import { SAMPLE_SCRIPT, SAMPLE_REPORT } from '../src/core.mjs';
const req = (method, params = {}, authenticated = false, id = 1) => new Request('https://checker.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'oai-authenticated-user-id': 'test-user' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });

test('MCP discovery and widget expose sync and UI tools without scripts or credentials', async () => {
  const initialize = await (await handleMCP(req('initialize', { protocolVersion: '2025-06-18' }), '')).json();
  assert.equal(initialize.result.protocolVersion, '2025-06-18');
  assert.ok(initialize.result.capabilities.tools);
  const list = await (await handleMCP(req('tools/list'), '')).json();
  assert.deepEqual(list.result.tools.map(t => t.name), ['read_pending_script', 'queue_script_check', 'get_script_check_status', 'clear_script_check', 'open_script_checker', 'show_script_check_result']);
  for (const tool of list.result.tools) {
    if (['open_script_checker', 'show_script_check_result'].includes(tool.name)) assert.equal(tool._meta.ui.resourceUri, WIDGET_URI);
    assert.ok(tool.outputSchema);
    assert.ok(!JSON.stringify(tool).includes('apiKey'));
  }
  const resource = await (await handleMCP(req('resources/read', { uri: WIDGET_URI }), '<html>safe</html>')).json();
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(resource.result.contents[0].text, '<html>safe</html>');
});

test('data-bearing MCP calls require platform-authenticated identity', async () => {
  const response = await handleMCP(req('tools/call', { name: 'open_script_checker', arguments: { script: SAMPLE_SCRIPT } }), '');
  assert.equal(response.status, 401);
  assert.ok(!JSON.stringify(await response.json()).includes(SAMPLE_SCRIPT));
});

test('connected conversation can open script and display complete validated result without model calls', async () => {
  const open = await (await handleMCP(req('tools/call', { name: 'open_script_checker', arguments: { script: SAMPLE_SCRIPT } }, true), '')).json();
  assert.equal(open.result.structuredContent.originalScript, SAMPLE_SCRIPT);
  assert.equal(open.result.structuredContent.report, null);
  assert.ok(open.result.structuredContent.checkInstructions.includes('修正后的完整脚本'));
  const result = await (await handleMCP(req('tools/call', { name: 'show_script_check_result', arguments: { originalScript: SAMPLE_SCRIPT, report: SAMPLE_REPORT } }, true), '')).json();
  assert.equal(result.result.structuredContent.report.revisedScript, SAMPLE_REPORT.revisedScript);
  assert.equal(result.result.structuredContent.source, 'chatgpt');
  const clean = await (await handleMCP(req('tools/call', { name: 'open_script_checker' }, true), '')).json();
  assert.equal(clean.result.structuredContent.originalScript, '');
  assert.equal(clean.result.structuredContent.report, null);
});

test('bad tools, invented evidence, missing revisions, oversized scripts and secret parameters fail', async () => {
  const badReport = structuredClone(SAMPLE_REPORT); badReport.issues[0].quote = '虚构证据';
  for (const args of [
    { originalScript: SAMPLE_SCRIPT, report: badReport },
    { originalScript: SAMPLE_SCRIPT, report: { ...SAMPLE_REPORT, revisedScript: '' } },
    { originalScript: '字'.repeat(16001), report: SAMPLE_REPORT },
    { originalScript: SAMPLE_SCRIPT, report: SAMPLE_REPORT, apiKey: 'secret' }
  ]) {
    const result = await (await handleMCP(req('tools/call', { name: 'show_script_check_result', arguments: args }, true), '')).json();
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent, undefined);
  }
  const unknown = await (await handleMCP(req('tools/call', { name: 'call_gpt_api' }, true), '')).json();
  assert.equal(unknown.error.code, -32602);
  assert.equal((await handleMCP(new Request('https://checker.example/mcp'), '')).status, 405);
  const notification = new Request('https://checker.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal((await handleMCP(notification, '')).status, 202);
});
