import { connectCheckerHost } from './host.mjs';
import { createHistoryStore } from './history.mjs';
import { CHECK_PROMPT, TYPES, MAX_CHARS, PROVIDERS, validApiKey, SAMPLE_SCRIPT, SAMPLE_REPORT, validateScript, validateReport, lineRange } from './core.mjs';

const appMode = document.documentElement.dataset.chatgptApp === 'true';
let checkerHost = null, hostReady = false, hostSending = false;
let syncReportStamp = '';
let syncTaskId = '', syncOriginal = '', syncTimer = null, syncSubmitting = false, syncErrors = 0, syncEpoch = 0;
const syncMode = () => appMode || $('checkMethod').value === 'gpt';
const $ = id => document.getElementById(id);
const scriptInput = $('script');
const dialog = $('connectionDialog');
let apiKey = '', activeProvider = 'deepseek', activeModel = PROVIDERS.deepseek.models[0], connections = {}, report = null, checkedScript = '', pendingCheck = false, controller = null;
const historyStore = createHistoryStore(() => window.localStorage);
let selectedHistoryId = '';
let resultView = 'revision', toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

function selectResultView(view, focus = false) {
  const views = ['revision', 'changes', 'issues'];
  if (!views.includes(view)) return;
  resultView = view;
  $('resultTabs').style.setProperty('--tab-index', views.indexOf(view));
  for (const name of views) {
    const tab = $(`tab-${name}`);
    tab.setAttribute('aria-selected', String(name === view));
    tab.tabIndex = name === view ? 0 : -1;
  }
  $('resultArea').setAttribute('aria-labelledby', `tab-${view}`);
  document.querySelectorAll('[data-result-section]').forEach(section => {
    const name = section.dataset.resultSection;
    section.hidden = name !== view && !(view === 'revision' && name === 'changes');
  });
  $('resultArea').scrollTop = 0;
  if (focus) $(`tab-${view}`).focus();
}

function renderHistory() {
  $('historyCount').textContent = historyStore.entries.length;
  $('historyNotice').textContent = historyStore.warning || '最近 10 次 · 仅保存在当前浏览器 · 不保存 API 密钥';
  const busy = !!controller || syncSubmitting || hostSending;
  $('clearHistory').disabled = busy || !historyStore.entries.length;
  $('historyList').replaceChildren();
  if (!historyStore.entries.length) $('historyList').append(node('p', 'history-empty', '完成一次自检后，原稿、修正稿和修改说明会自动保存在这里。'));
  for (const entry of historyStore.entries) {
    const row = node('div', 'history-row');
    const open = node('button', 'history-open'); open.type = 'button'; open.disabled = busy;
    open.setAttribute('aria-pressed', String(selectedHistoryId === entry.id));
    open.append(node('strong', '', entry.script.trim().split('\n')[0].slice(0, 48)));
    const source = entry.report.source === 'chatgpt' ? 'ChatGPT' : PROVIDERS[entry.report.provider].name;
    open.append(node('span', '', `${new Date(entry.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${source} · ${entry.report.issues.length} 项问题`));
    open.addEventListener('click', () => {
      if (controller || syncSubmitting || hostSending) return;
      if (scriptInput.value.trim() && scriptInput.value !== entry.script && !window.confirm('回看历史会替换左侧输入，请先复制保留尚未检查的改动。继续吗？')) return;
      stopSyncPoll();
      scriptInput.value = entry.script; checkedScript = entry.script; report = entry.report; selectedHistoryId = entry.id; resultView = 'revision';
      $('locationFeedback').textContent = '已载入历史版本';
      updateEditor(); renderReport(); renderHistory();
      showToast('已载入历史版本，原稿与修正稿已恢复');
    });
    const remove = node('button', 'text-button', '删除'); remove.type = 'button'; remove.disabled = busy;
    remove.setAttribute('aria-label', `删除历史记录：${entry.script.trim().split('\n')[0].slice(0, 48)}`);
    remove.addEventListener('click', () => {
      if (!window.confirm('删除这条本机历史记录？当前显示的脚本仍会保留。')) return;
      historyStore.remove(entry.id); if (selectedHistoryId === entry.id) selectedHistoryId = ''; renderHistory();
      showToast(historyStore.warning || '这条历史已删除');
    });
    row.append(open, remove); $('historyList').append(row);
  }
}

function rememberReport() {
  selectedHistoryId = historyStore.add(checkedScript, report) || '';
  renderHistory();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function updateEditor() {
  const lines = scriptInput.value.split('\n').length;
  $('charCount').textContent = scriptInput.value.length.toLocaleString();
  $('lineCount').textContent = `${lines} 行`;
  $('lineNumbers').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  $('lineNumbers').scrollTop = scriptInput.scrollTop;
  $('checkButton').disabled = !scriptInput.value.trim() || scriptInput.value.length > MAX_CHARS || !!controller || syncSubmitting || (appMode && (!hostReady || hostSending));
  renderHistory();
}

function drawDimensions(checked = false) {
  $('dimensions').replaceChildren(...TYPES.map(type => {
    const chip = node('span', `dimension${checked ? ' checked' : ''}`);
    chip.append(node('span', '', checked ? '✓' : '·'), document.createTextNode(type));
    return chip;
  }));
}

function emptyState(title, description, symbol = '✳', kind = '') {
  $('resultTabs').hidden = true;
  $('resultStats').hidden = true;
  $('resultArea').removeAttribute('role');
  $('resultArea').removeAttribute('aria-labelledby');
  const wrapper = node('div', `empty ${kind}`);
  const icon = node('div', 'empty-icon', symbol);
  if (kind === 'loading') { icon.replaceChildren(node('span', 'spinner')); icon.setAttribute('aria-hidden', 'true'); }
  wrapper.append(icon, node('h3', '', title), node('p', '', description));
  $('resultArea').replaceChildren(wrapper);
  return wrapper;
}

function locate(issue, card) {
  if (scriptInput.value !== checkedScript) return;
  const { start, end } = lineRange(checkedScript, issue.startLine, issue.endLine);
  scriptInput.focus();
  scriptInput.setSelectionRange(start, end);
  scriptInput.scrollTop = Math.max(0, (issue.startLine - 2) * 28);
  $('lineNumbers').scrollTop = scriptInput.scrollTop;
  document.querySelectorAll('.is-located').forEach(item => item.classList.remove('is-located'));
  card.classList.add('is-located');
  $('locationFeedback').textContent = `已定位第 ${issue.startLine}${issue.endLine === issue.startLine ? '' : `–${issue.endLine}`} 行`;
  showToast($('locationFeedback').textContent + '，原文已选中');
  if (window.matchMedia('(max-width:760px)').matches) scriptInput.scrollIntoView({ behavior: 'auto', block: 'center' });
}

function renderReport() {
  $('resultTabs').hidden = true;
  $('resultStats').hidden = true;
  $('resultArea').removeAttribute('role');
  $('resultArea').removeAttribute('aria-labelledby');
  $('resultCount').hidden = true;
  drawDimensions(false);
  if (!report) {
    $('resultMode').textContent = '等待检查';
    const empty = emptyState('先给故事做一次连续性检查', '粘贴左侧脚本，点击「自检并修正」。这里会显示完整修正稿和问题列表。');
    const sample = node('button', 'text-button', '还没有脚本？试试示例 →');
    sample.type = 'button'; sample.addEventListener('click', loadSample); empty.append(sample);
    return;
  }
  if (scriptInput.value !== checkedScript) {
    $('resultMode').textContent = '脚本已修改';
    emptyState('这版脚本需要重新检查', '上次结果对应修改前的脚本。点击「自检并修正」获取当前版本的修正稿和问题列表。', '↻');
    return;
  }
  const demo = report.source === 'demo';
  const chat = report.source === 'chatgpt';
  drawDimensions(true);
  $('resultMode').textContent = demo ? '示例演示' : chat ? 'ChatGPT · 对话自检' : `${PROVIDERS[report.provider || activeProvider].name} · ${report.model || activeModel}`;
  $('resultCount').hidden = false;
  $('resultCount').textContent = `${report.issues.length} 项`;
  $('resultTabs').hidden = false;
  $('resultStats').hidden = false;
  $('resultArea').setAttribute('role', 'tabpanel');
  $('issueTotal').textContent = report.issues.length;
  $('changeTotal').textContent = report.changes?.length ?? '—';
  $('confirmationTotal').textContent = report.issues.filter(issue => issue.status === 'needs_confirmation').length;
  $('resultArea').replaceChildren();
  if (demo) $('resultArea').append(node('div', 'demo-notice', '示例结果 · 固定演示数据，未经实时 AI 检查。设置模型后可检查你自己的脚本。'));
  $('resultArea').append(node('p', 'report-summary', report.summary));
  const revision = node('section', 'revision-panel');
  revision.dataset.resultSection = 'revision';
  revision.setAttribute('aria-labelledby', 'revisionTitle');
  const revisionTop = node('div', 'revision-top');
  const revisionTitle = node('h3', '', demo ? '修正后的完整脚本 · 示例' : '修正后的完整脚本');
  revisionTitle.id = 'revisionTitle';
  const copy = node('button', 'text-button', '复制修正稿'); copy.type = 'button';
  revisionTop.append(revisionTitle, copy);
  const label = node('label', 'sr-only', '修正后的完整脚本'); label.htmlFor = 'revisedScript';
  const field = node('textarea', 'revised-script');
  field.id = 'revisedScript'; field.readOnly = true; field.value = report.revisedScript;
  const status = node('p', 'revision-note', '原稿保留在左侧；待确认内容请核实后再用于生成。');
  status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = '完整修正稿已复制。';
      copy.textContent = '✓ 已复制';
      showToast('完整修正稿已复制');
    } catch {
      field.focus(); field.select();
      status.textContent = '自动复制不可用，已选中修正稿，请按 ⌘C 或 Ctrl+C 复制。';
      showToast('修正稿已选中，请按 ⌘C 或 Ctrl+C 复制');
    }
  });
  revision.append(revisionTop, label, field, status);
  $('resultArea').append(revision);
  const changesPanel = node('section', 'changes-panel');
  changesPanel.dataset.resultSection = 'changes';
  const changes = report.changes;
  changesPanel.append(node('h3', 'issues-heading', `改了哪里 · 为什么改${changes ? `（${changes.length} 处）` : ''}`));
  if (!changes) changesPanel.append(node('p', 'revision-note', '这份旧结果未包含修改对照。重新检查后可查看逐条修改说明。'));
  else if (!changes.length) changesPanel.append(node('p', 'revision-note', '本次保留原稿，没有实际修改。'));
  else for (const change of changes) {
    const card = node('article', 'change-card');
    const position = node('button', 'location', `原稿第 ${change.startLine}${change.startLine === change.endLine ? '' : `–${change.endLine}`} 行 ↗`);
    position.type = 'button'; position.addEventListener('click', () => locate(change, card));
    card.append(position);
    for (const [title, text, style] of [['修改前', change.before, 'before'], ['修改后', change.after || '（删除此片段）', 'after'], ['为什么改', change.reason, 'reason']]) {
      const row = node('div', `change-${style}`); row.append(node('h4', '', title), node('p', '', text)); card.append(row);
    }
    changesPanel.append(card);
  }
  const issuesPanel = node('section', 'issues-panel');
  issuesPanel.dataset.resultSection = 'issues';
  issuesPanel.append(node('h3', 'issues-heading', '原稿问题列表'));
  $('resultArea').append(changesPanel, issuesPanel);
  if (!report.issues.length) {
    const wrapper = node('div', 'empty');
    wrapper.append(node('div', 'empty-icon', '✓'), node('h3', '', '本次未发现有依据的问题'), node('p', '', '六个维度均已检查。仍建议结合人物设定、产品说明和实际生成画面复核。'));
    issuesPanel.append(wrapper);
  }
  report.issues.forEach((issue, index) => {
    const card = node('article', 'issue');
    card.style.setProperty('--enter-delay', `${Math.min(index, 6) * 30}ms`);
    const top = node('div', 'issue-top');
    const title = node('div', 'issue-title');
    title.append(node('span', 'issue-number', String(index + 1).padStart(2, '0')), node('h3', '', issue.type));
    if (issue.status === 'needs_confirmation') title.append(node('span', 'status-tag', '待确认'));
    const label = issue.startLine === issue.endLine ? `第 ${issue.startLine} 行 ↗` : `第 ${issue.startLine}–${issue.endLine} 行 ↗`;
    const position = node('button', 'location', label);
    position.type = 'button'; position.setAttribute('aria-label', `定位脚本第 ${issue.startLine} 至 ${issue.endLine} 行`);
    position.addEventListener('click', () => locate(issue, card));
    top.append(title, position);
    card.append(top, node('blockquote', '', issue.quote), node('p', 'issue-description', issue.description));
    for (const [label, field, style] of [['AI 生成风险', 'risk', ''], ['修改建议', 'suggestion', 'suggestion']]) {
      const row = node('dl', `issue-field ${style}`);
      row.append(node('dt', '', label), node('dd', '', issue[field])); card.append(row);
    }
    issuesPanel.append(card);
  });
  selectResultView(resultView);
}

function loadSample() {
  if (controller) return;
  if (scriptInput.value.trim() && scriptInput.value !== SAMPLE_SCRIPT && !window.confirm('使用示例会替换当前输入的脚本。继续吗？')) return;
  scriptInput.value = SAMPLE_SCRIPT;
  $('locationFeedback').textContent = '';
  checkedScript = SAMPLE_SCRIPT;
  selectedHistoryId = '';
  resultView = 'revision';
  report = { ...validateReport(SAMPLE_REPORT, SAMPLE_SCRIPT), source: 'demo' };
  updateEditor(); renderReport();
}

function openConnection(startAfterSaving = false) {
  pendingCheck = startAfterSaving;
  $('keyError').textContent = '';
  $('providerSelect').value = activeProvider;
  updateModelFields();
  dialog.showModal();
}

function stopSyncPoll() {
  clearTimeout(syncTimer); syncTimer = null; syncEpoch++;
}

async function syncRequest(action, values = {}) {
  if (appMode) {
    const name = action === 'read' ? 'get_script_check_status' : action === 'create' ? 'queue_script_check' : 'clear_script_check';
    return checkerHost.call(name, values);
  }
  const response = await fetch('/api/sync', action === 'read' ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values })
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('同步服务未返回有效结果，请重新登录网页后重试。'); }
  if (!response.ok) throw new Error(data.error || '同步未完成。');
  return data;
}

function waitForGPT() {
  $('openGPT').hidden = appMode; $('openGPT').textContent = '去 GPT 检查 ↗';
  $('resultMode').textContent = '等待 GPT 返回';
  $('resultCount').hidden = true;
  drawDimensions(false);
  emptyState('原稿已提交，等待 GPT 自检', '在已连接续镜插件的 GPT 对话中说：检查续镜网页中待检查的脚本，把完整修正稿和问题写回网页。完成后这里会自动更新。', '↻');
  $('syncStatus').textContent = '已提交。点击“去 GPT 检查”，由当前 GPT 对话完成修改；本页会自动接收写回的完整结果。';
}

async function readSyncStatus(restore = false, watch = false) {
  stopSyncPoll();
  if (!syncMode()) return;
  const epoch = syncEpoch;
  try {
    const data = await syncRequest('read');
    if (epoch !== syncEpoch || !syncMode()) return;
    syncErrors = 0;
    if (data.status === 'empty') {
      syncTaskId = ''; syncOriginal = '';
      $('syncClear').hidden = true; $('openGPT').hidden = true;
      $('syncStatus').textContent = '当前没有网页任务。粘贴脚本，点击“提交给 GPT”。';
      return;
    }
    if (syncTaskId && data.taskId !== syncTaskId && !restore) {
      $('syncStatus').textContent = '另一处页面已提交新任务，已停止接收旧任务，当前原稿未被覆盖。';
      return;
    }
    if (restore && !scriptInput.value.trim()) scriptInput.value = data.originalScript;
    if (scriptInput.value !== data.originalScript) {
      $('syncStatus').textContent = '暂存任务对应另一版原稿，当前输入未被覆盖。需要检查当前版本请重新提交。';
      return;
    }
    syncTaskId = data.taskId; syncOriginal = data.originalScript;
    $('syncClear').hidden = false;
    if (data.status === 'completed') {
      $('openGPT').hidden = appMode; $('openGPT').textContent = '去 GPT 继续修改 ↗';
      const stamp = JSON.stringify(data.report);
      if (stamp !== syncReportStamp || checkedScript !== data.originalScript || !report) {
        report = { ...validateReport(data.report, data.originalScript), source: 'chatgpt' };
        checkedScript = data.originalScript; syncReportStamp = stamp;
        rememberReport();
        updateEditor(); renderReport();
      }
      $('syncStatus').textContent = 'GPT 的完整修正稿已回到当前网页右侧。继续修改时，让 GPT 读取当前任务并写回新的完整结果。';
    } else { updateEditor(); waitForGPT(); }
    if (watch) syncTimer = setTimeout(() => readSyncStatus(false, true), document.visibilityState === 'hidden' ? 15000 : 5000);
  } catch (e) {
    if (epoch !== syncEpoch) return;
    syncErrors++;
    $('syncStatus').textContent = e.message + (syncErrors >= 3 ? ' 自动接收已暂停，点击“检查同步状态”重试。' : '');
    if (watch && syncErrors < 3) syncTimer = setTimeout(() => readSyncStatus(false, true), 10000);
  }
}

async function startSyncCheck(script) {
  if (syncSubmitting) return;
  syncSubmitting = true; updateEditor(); stopSyncPoll();
  const epoch = syncEpoch;
  try {
    const data = await syncRequest('create', { script, taskId: crypto.randomUUID() });
    if (epoch !== syncEpoch || !syncMode()) return;
    syncTaskId = data.taskId; syncOriginal = data.originalScript;
    scriptInput.value = data.originalScript; report = null; checkedScript = ''; syncReportStamp = '';
    $('syncClear').hidden = false; waitForGPT();
    if (appMode) {
      try { await checkerHost.send('请调用续镜 read_pending_script 读取我刚提交的网页原稿，用当前对话模型按六类 AI 视频生成风险检查并修正，再调用 show_script_check_result，传回读取到的 taskId、逐字完整 originalScript 和完整 report，把结果写回同一网页。保留剧情和对白，不输出省略片段。'); }
      catch (e) { $('syncStatus').textContent = '原稿已提交，但未能自动发起对话：' + e.message + ' 请在聊天区说“检查续镜网页中的脚本并写回结果”。'; }
    }
    syncErrors = 0;
    syncTimer = setTimeout(() => readSyncStatus(false, true), 5000);
  } catch (e) { $('syncStatus').textContent = e.message; }
  finally { syncSubmitting = false; updateEditor(); }
}

function updateCheckMethod() {
  stopSyncPoll();
  const synced = syncMode();
  $('syncControls').hidden = !synced;
  $('connectionButton').hidden = appMode;
  $('checkLabel').textContent = synced ? '提交给 GPT' : '自检并修正';
  $('privacyNote').textContent = synced ? '为同页同步，服务器暂存当前原稿和结果；新任务替换旧任务，可点击“清除暂存”。不保存 API 密钥。' : '脚本转发给所选模型；最近 10 次结果保存在当前浏览器，可删除。密钥仅在本页内存中，刷新后清除。';
  if (synced && (!appMode || hostReady)) readSyncStatus(true, true);
  updateEditor();
}
$('checkMethod').addEventListener('change', updateCheckMethod);
$('syncRefresh').addEventListener('click', () => { syncErrors = 0; readSyncStatus(true, true); });
$('syncClear').addEventListener('click', async () => {
  if (!syncTaskId || syncSubmitting) return;
  stopSyncPoll();
  const epoch = syncEpoch;
  try {
    await syncRequest('clear', { taskId: syncTaskId });
    if (epoch !== syncEpoch) return;
    syncTaskId = ''; syncOriginal = ''; report = null; checkedScript = '';
    $('syncClear').hidden = true; $('openGPT').hidden = true; renderReport();
    $('syncStatus').textContent = '服务器暂存的原稿和结果已清除。左侧输入仍保留。';
  } catch (e) { $('syncStatus').textContent = e.message; }
});
window.addEventListener('pagehide', stopSyncPoll);

async function startCheck() {
  if (controller) return;
  let script;
  try { script = validateScript(scriptInput.value); }
  catch (error) { emptyState('还不能开始检查', error.message, '!', 'error'); return; }
  if (syncMode()) { await startSyncCheck(script); return; }
  if (!apiKey) { openConnection(true); return; }
  scriptInput.value = script;
  controller = new AbortController();
  const active = controller;
  const timeout = setTimeout(() => active.abort(), 95000);
  scriptInput.readOnly = true;
  $('sampleButton').disabled = true;
  $('connectionButton').disabled = true;
  $('checkMethod').disabled = true;
  $('cancelButton').hidden = false;
  $('checkLabel').textContent = '正在自检并修正…';
  $('resultArea').setAttribute('aria-busy', 'true');
  $('resultMode').textContent = `${PROVIDERS[activeProvider].name} · 检查中`;
  $('resultCount').hidden = true;
  drawDimensions(false);
  emptyState('正在梳理镜头之间的关系', '正在检查六类生成风险，并生成完整修正稿。通常需要几十秒；较长脚本可能需要更久。', '', 'loading');
  updateEditor();
  try {
    const response = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script, apiKey, provider: activeProvider, model: activeModel }), signal: active.signal });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('检查服务没有返回可用结果，请稍后重试。'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '检查失败，请稍后重试。');
    if (data.source !== 'ai') throw new Error('检查服务返回的结果来源不正确。');
    report = { ...validateReport(data, script), source: 'ai', provider: activeProvider, model: activeModel };
    checkedScript = script;
    resultView = 'revision';
    rememberReport();
    renderReport();
  } catch (error) {
    report = null; checkedScript = '';
    drawDimensions(false);
    $('resultMode').textContent = active.signal.aborted ? '已停止检查' : '检查未完成';
    const message = active.signal.aborted ? '本次检查已取消或等待超时。脚本仍在左侧，可以再次检查。' : error.message;
    const empty = emptyState('这次检查没有完成', message, '!', 'error');
    const retry = node('button', 'text-button', '重新检查 →');
    retry.type = 'button'; retry.addEventListener('click', startCheck); empty.append(retry);
  } finally {
    clearTimeout(timeout);
    controller = null;
    scriptInput.readOnly = false;
    $('sampleButton').disabled = false;
    $('connectionButton').disabled = false;
    $('checkMethod').disabled = false;
    $('cancelButton').hidden = true;
    $('checkLabel').textContent = '自检并修正';
    $('resultArea').setAttribute('aria-busy', 'false');
    updateEditor();
  }
}

function updateModelFields() {
  const id = $('providerSelect').value;
  const provider = PROVIDERS[id];
  const saved = connections[id];
  $('modelSelect').replaceChildren(...provider.models.map(model => {
    const option = node('option', '', model); option.value = model; return option;
  }));
  $('modelSelect').value = saved?.model || provider.models[0];
  $('apiKey').value = saved?.key || '';
  $('apiKey').placeholder = id === 'zhipu' ? '填写智谱 API 密钥' : 'sk-…';
  $('apiKeyLabel').textContent = `${provider.name} API 密钥`;
  $('keyError').textContent = '';
}
$('providerSelect').addEventListener('change', updateModelFields);

$('connectionButton').addEventListener('click', () => {
  if (!appMode) { $('checkMethod').value = 'api'; updateCheckMethod(); }
  openConnection();
});
$('closeDialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { $('apiKey').value = ''; pendingCheck = false; });
$('connectionForm').addEventListener('submit', event => {
  event.preventDefault();
  const key = $('apiKey').value.trim();
  if (!validApiKey(key)) { $('keyError').textContent = '请填写当前服务的完整 API 密钥，不要包含空格。'; return; }
  activeProvider = $('providerSelect').value;
  activeModel = $('modelSelect').value;
  apiKey = key;
  connections[activeProvider] = { key, model: activeModel };
  $('connectionText').textContent = `${PROVIDERS[activeProvider].name} API · 已配置`;
  $('connectionDot').classList.add('ready');
  const shouldStart = pendingCheck;
  dialog.close();
  if (shouldStart) startCheck();
});
$('forgetKey').addEventListener('click', () => {
  const selected = $('providerSelect').value;
  delete connections[selected];
  if (selected === activeProvider) {
    apiKey = '';
    $('connectionText').textContent = 'API 模型设置'; $('connectionDot').classList.remove('ready');
  }
  $('apiKey').value = ''; $('keyError').textContent = '';
  dialog.close();
});
scriptInput.addEventListener('input', () => { if (syncOriginal && scriptInput.value !== syncOriginal) { stopSyncPoll(); $('syncStatus').textContent = '原稿已修改，旧任务结果不会覆盖当前输入。请重新提交当前版本。'; } $('locationFeedback').textContent = ''; updateEditor(); renderReport(); });
scriptInput.addEventListener('scroll', () => { $('lineNumbers').scrollTop = scriptInput.scrollTop; });
$('sampleButton').addEventListener('click', () => { stopSyncPoll(); loadSample(); });
$('checkButton').addEventListener('click', startCheck);
$('cancelButton').addEventListener('click', () => controller?.abort());
$('clearHistory').addEventListener('click', () => {
  if (!window.confirm('清空当前浏览器中的全部检查历史？当前显示的脚本仍会保留。')) return;
  historyStore.clear(); selectedHistoryId = ''; renderHistory(); showToast(historyStore.warning || '本机检查历史已清空');
});
for (const view of ['revision', 'changes', 'issues']) {
  $(`tab-${view}`).addEventListener('click', () => selectResultView(view));
  $(`tab-${view}`).addEventListener('keydown', event => {
    const views = ['revision', 'changes', 'issues'], index = views.indexOf(view);
    const target = { ArrowLeft: (index + 2) % 3, ArrowRight: (index + 1) % 3, Home: 0, End: 2 }[event.key];
    if (target !== undefined) { event.preventDefault(); selectResultView(views[target], true); }
  });
}
updateCheckMethod(); updateEditor(); renderReport();
if (appMode) {
  $('connectionButton').hidden = true;
  $('checkMethod').value = 'gpt'; $('methodPicker').hidden = true;
  checkerHost = connectCheckerHost(data => {
    try {
      const original = data.originalScript === '' ? '' : validateScript(data.originalScript);
      if (scriptInput.value.trim() && scriptInput.value !== original) {
        $('hostStatus').textContent = '返回结果对应另一版原稿，未覆盖当前输入。请查看 GPT 返回的新结果窗口。';
        return;
      }
      const result = data.report ? validateReport(data.report, original) : null;
      scriptInput.value = original; checkedScript = original;
      report = result ? { ...result, source: 'chatgpt' } : null;
      if (result) rememberReport();
      updateEditor(); renderReport();
      if (result) $('hostStatus').textContent = '完整修正稿已显示。可在聊天区继续提出修改要求，让 GPT 再次返回完整结果。';
    } catch { $('hostStatus').textContent = '返回结果缺少完整脚本或有效原文证据，请让 GPT 重新提交。'; }
  }, (connected, message) => {
    hostReady = connected; $('hostStatus').textContent = message; if (connected) updateCheckMethod(); else updateEditor();
  });
}

// shortcut: 浏览器支持 WebMCP 时，仅暴露读取结果；发起付费检查仍由用户按钮触发。
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'read_script_check_result', title: '读取脚本检查结果',
      description: '读取当前页面已完成且对应当前脚本的检查结果。不会发起 AI 调用或读取 API 密钥。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('此工具不接受参数。');
        if (controller || !report || scriptInput.value !== checkedScript) throw new Error('当前没有可读取的检查结果。');
        return { source: report.source, checkedTypes: report.checkedTypes, summary: report.summary, revisedScript: report.revisedScript, issues: report.issues, changes: report.changes };
      }
    }, { signal: lifecycle.signal })).catch(() => {});
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  } catch { /* 不支持时继续正常使用网页。 */ }
}
