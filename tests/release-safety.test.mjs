// Validate an actual frozen recovery package against mixed old/new in-memory data.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecovery, verifyRecovery, FRONTEND_FILES } from '../scripts/frontend-recovery.mjs';

const destination = await buildRecovery(await mkdtemp(join(tmpdir(), 'zhixing-recovery-test-')));
await verifyRecovery(destination);
const read = name => readFile(join(destination, 'public', name), 'utf8');
const values = new Map(); let seq = 0;
const scope = {
  localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
  navigator: { locks: { request: async (_name, fn) => fn() } }, crypto: { randomUUID: () => String(++seq) }, addEventListener() {},
};
function load(source) {
  const names = [...source.matchAll(/export (?:class|const|function) (\w+)/g)].map(m => m[1]);
  return new Function('globalThis', 'navigator', source.replace(/export /g, '') + `;return {${names}}`)(scope, scope.navigator);
}
const current = load(await readFile(new URL('../js/data.js', import.meta.url), 'utf8'));
const draft = { type: 'assignment', course: '程序设计', title: '报告', content: '任务说明', deadline: null,
  deadlineDate: '2027-01-03', deadlineText: ' 3号之前\n', dateWarning: '推断日期，待确认', referenceTime: '2026-12-31T10:00:00+08:00', confidence: 0.9 };
const n = await current.addNotification({ sender: '老师', source: '班群', content: '3号之前提交报告', extraction: draft, extractionStatus: 'pending' });
const legacy = await current.addNotification({ sender: '老师', source: '群', content: '旧通知' });
const tasks = [await current.createManualTask({ title: '手动任务', deadlineDate: '2027-01-03' }),
  await current.addTask({ title: '旧任务' })];
// Construct the historical schema in this isolated test store only.
const oldNotices = current.getNotifications(); delete oldNotices.find(x => x.id === legacy.id).extraction;
values.set(current.STORAGE_KEYS.notifications, JSON.stringify(oldNotices));
const oldTasks = current.getTasks();
for (const key of ['deadlineDate', 'type', 'sourceKind']) delete oldTasks[1][key];
values.set(current.STORAGE_KEYS.tasks, JSON.stringify(oldTasks));
const before = JSON.stringify([...values]);
const recovery = load(await read('js/data.js'));
assert.equal(recovery.getNotifications().length, 2);
assert.equal(recovery.getTasks().length, 2);
assert.equal(recovery.getDashboardStats().pendingTaskCount, 2);
assert.deepEqual(recovery.getRecentTasks().map(x => x.id), current.getRecentTasks().map(x => x.id));
assert.equal(JSON.stringify([...values]), before, 'recovery reads do not migrate or overwrite data');
assert.deepEqual(recovery.getNotificationById(n.id).extraction, draft);
await recovery.updateTask(tasks[0].id, { status: 'completed' });
await recovery.updateTask(tasks[0].id, { status: 'pending' });
assert.equal(recovery.getTaskById(tasks[0].id).sourceNotificationId, null);
assert.equal(recovery.getTaskById(tasks[0].id).deadlineDate, '2027-01-03');
await recovery.createTaskFromNotification(n.id, { title: '人工确认', deadlineDate: '2027-01-04', deadlineText: draft.deadlineText });
await assert.rejects(recovery.createTaskFromNotification(n.id, { title: '重复' }), error => error.code === 'DUPLICATE_TASK');
assert.deepEqual(recovery.getNotificationById(n.id).extraction, draft);
for (const html of ['index.html', 'notification.html', 'task.html']) {
  for (const match of (await read(html)).matchAll(/(?:src|href)="([^"#]+)(?:#[^"]*)?"/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    assert(FRONTEND_FILES.includes(match[1].replace(/^\.\//, '')), `recovery resource ${match[1]}`);
  }
}
assert.match(await read('task.js'), /extraction\.deadlineDate/);
assert.match(await read('js/home.js'), /item\.deadlineDate/);
assert.match(await read('notification.js'), /data\.dateWarning/);
// Tampering invalidates the package; never use an unverified mixed-version bundle.
await writeFile(join(destination, 'public', 'task.js'), '// changed test fixture');
await assert.rejects(verifyRecovery(destination), /checksum mismatch/);
const app = await readFile(new URL('../backend/app.py', import.meta.url), 'utf8');
assert.match(app, /MAX_CONTENT_LENGTH = 10000\b/);
assert.match(app, /"max_tokens": 2048\b/);
console.log('PASS recovery package completeness, mixed-schema reads without writes, task lifecycle, deduplication, original draft, tamper detection and unchanged AI limits');
