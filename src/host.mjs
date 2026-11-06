export function connectCheckerHost(onResult, onState) {
  let nextId = 0, initialized = false;
  const pending = new Map();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ChatGPT 连接没有响应，请重新打开自检器。')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
  const apply = value => {
    if (value?.isError) { onState(initialized, '结果未能显示，请让 GPT 检查返回的错误并重新提交完整结果。'); return; }
    const data = value?.structuredContent;
    if (data?.source === 'chatgpt') onResult(data);
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message || 'ChatGPT 连接请求失败。'));
      else item.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-result') apply(message.params);
  });
  window.addEventListener('openai:set_globals', event => {
    const data = event.detail?.globals?.toolOutput;
    if (data?.source === 'chatgpt') onResult(data);
  });
  const ready = (async () => {
    if (window.parent === window) { onState(false, '这是 App 界面预览。实际 GPT 自检需要在 ChatGPT 中连接并打开续镜插件。'); return; }
    await request('ui/initialize', { appInfo: { name: '续镜', version: '0.2.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
    initialized = true; onState(true, '已连接 ChatGPT。当前对话中的 GPT 会完成自检，不需要 API 密钥。');
    if (window.openai?.toolOutput?.source === 'chatgpt') onResult(window.openai.toolOutput);
  })();
  ready.catch(e => onState(false, e.message));
  return {
    async call(name, args) {
      await ready;
      if (!initialized) throw new Error('请在 ChatGPT 内打开已连接的续镜插件。');
      const result = await request('tools/call', { name, arguments: args });
      if (result?.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '同步失败。');
      return result.structuredContent;
    },
    async send(prompt) {
      await ready;
      if (!initialized) throw new Error('请在 ChatGPT 内打开已连接的续镜插件。');
      if (window.openai?.sendFollowUpMessage) await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
      else await request('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] });
    }
  };
}
