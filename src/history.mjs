import { validateScript, validateReport, PROVIDERS } from './core.mjs';

export const HISTORY_KEY = 'script-checker.history.v1';
export const HISTORY_LIMIT = 10;

function cleanHistoryEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || entry.id.length > 80 ||
      !Number.isFinite(entry.savedAt) || entry.savedAt < 0 || entry.savedAt > 8640000000000000) throw new Error('Invalid history');
  const script = validateScript(entry.script);
  const source = entry.report?.source;
  if (!['ai', 'chatgpt'].includes(source)) throw new Error('Invalid source');
  const provider = entry.report.provider;
  if (source === 'ai' && (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider) ||
      typeof entry.report.model !== 'string' || entry.report.model.length > 100)) throw new Error('Invalid provider');
  // Whitelist fields so connection settings and credentials never enter history.
  const report = { ...validateReport(entry.report, script), source,
    ...(source === 'ai' ? { provider, model: entry.report.model } : {}) };
  return { id: entry.id, savedAt: entry.savedAt, script, report };
}

export function createHistoryStore(getStorage) {
  let entries = [], warning = '';
  try {
    const raw = getStorage().getItem(HISTORY_KEY);
    if (raw) {
      if (raw.length > 2000000) throw new Error('Too large');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid history');
      for (const entry of parsed.slice(0, HISTORY_LIMIT)) {
        try { entries.push(cleanHistoryEntry(entry)); }
        catch { warning = '部分历史记录已损坏，无法显示。'; }
      }
    }
  } catch { warning = '无法读取本机历史记录；当前检查仍可正常使用。'; }
  function persist() {
    try {
      getStorage().setItem(HISTORY_KEY, JSON.stringify(entries));
      warning = '';
    } catch { warning = '浏览器未能保存历史变更；当前记录仅在本页有效，刷新后可能丢失或恢复旧记录。'; }
  }
  return {
    get entries() { return entries; },
    get warning() { return warning; },
    add(script, report) {
      if (report.source === 'demo') return null;
      const entry = cleanHistoryEntry({ id: crypto.randomUUID(), savedAt: Date.now(), script, report });
      if (entries[0]?.script === script && JSON.stringify(entries[0].report) === JSON.stringify(entry.report)) return entries[0].id;
      entries = [entry, ...entries].slice(0, HISTORY_LIMIT);
      while (entries.length > 1 && JSON.stringify(entries).length > 2000000) entries.pop();
      persist();
      return entry.id;
    },
    remove(id) { entries = entries.filter(entry => entry.id !== id); persist(); },
    clear() {
      entries = [];
      try { getStorage().removeItem(HISTORY_KEY); warning = ''; }
      catch { warning = '浏览器未能删除本机历史，请在浏览器设置中清除此网站数据。'; }
    }
  };
}
