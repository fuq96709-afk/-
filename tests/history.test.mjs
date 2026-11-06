import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStore, HISTORY_KEY, HISTORY_LIMIT } from '../src/history.mjs';
import { SAMPLE_SCRIPT, SAMPLE_REPORT, TYPES } from '../src/core.mjs';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const report = () => ({ ...structuredClone(SAMPLE_REPORT), source: 'ai', provider: 'deepseek', model: 'deepseek-flash' });

test('history survives reload with original, complete revision and reasons, excluding credential fields', () => {
  const disk = storage(), store = createHistoryStore(() => disk);
  const id = store.add(SAMPLE_SCRIPT, { ...report(), apiKey: 'secret-never-store', connections: { key: 'secret-never-store' } });
  assert.ok(!disk.getItem(HISTORY_KEY).includes('secret-never-store'));
  const reloaded = createHistoryStore(() => disk);
  assert.equal(reloaded.entries[0].id, id);
  assert.equal(reloaded.entries[0].script, SAMPLE_SCRIPT);
  assert.equal(reloaded.entries[0].report.revisedScript, SAMPLE_REPORT.revisedScript);
  assert.deepEqual(reloaded.entries[0].report.changes, SAMPLE_REPORT.changes);
  assert.equal(store.add(SAMPLE_SCRIPT, report()), id);
  assert.equal(store.entries.length, 1);
});

test('retain newest ten real checks; demo is not a real historical check; deletion persists', () => {
  const disk = storage(), store = createHistoryStore(() => disk);
  assert.equal(store.add(SAMPLE_SCRIPT, { ...report(), source: 'demo' }), null);
  for (let i = 0; i < 12; i++) {
    const script = `原稿 ${i}`;
    store.add(script, { checkedTypes: TYPES, summary: '未修改', revisedScript: script, issues: [], changes: [], source: 'ai', provider: 'zhipu', model: 'glm-4.7' });
  }
  assert.equal(store.entries.length, HISTORY_LIMIT);
  assert.equal(store.entries[0].script, '原稿 11');
  const id = store.entries[0].id; store.remove(id);
  assert.ok(!createHistoryStore(() => disk).entries.some(entry => entry.id === id));
  store.clear(); assert.equal(createHistoryStore(() => disk).entries.length, 0);
});

test('corrupt storage and denied/full storage do not lose the in-memory result or claim persistence', () => {
  const disk = storage(); disk.setItem(HISTORY_KEY, 'not-json');
  assert.match(createHistoryStore(() => disk).warning, /无法读取/);
  const denied = createHistoryStore(() => { throw new Error('denied'); });
  assert.doesNotThrow(() => denied.add(SAMPLE_SCRIPT, report()));
  assert.equal(denied.entries.length, 1);
  assert.match(denied.warning, /未能保存/);
  const full = createHistoryStore(() => ({ ...disk, setItem() { throw new Error('quota'); } }));
  assert.doesNotThrow(() => full.add(SAMPLE_SCRIPT, report()));
  assert.match(full.warning, /未能保存/);
});

test('invalid saved records are skipped while valid records remain readable', () => {
  const disk = storage(), store = createHistoryStore(() => disk);
  store.add(SAMPLE_SCRIPT, report());
  const valid = JSON.parse(disk.getItem(HISTORY_KEY))[0];
  disk.setItem(HISTORY_KEY, JSON.stringify([{ ...valid, report: { ...valid.report, provider: '__proto__' } }, valid]));
  const loaded = createHistoryStore(() => disk);
  assert.equal(loaded.entries.length, 1);
  assert.match(loaded.warning, /损坏/);
});
