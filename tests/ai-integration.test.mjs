// 实际页面函数 + 隔离存储/DOM/网络，不发送真实 AI 请求。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
function setupData() {
  const values = new Map(); let failWrite = false; let seq = 0;
  const scope = {
    localStorage: { getItem: k => values.get(k) ?? null, setItem(k, v) { if (failWrite) throw Error('quota'); values.set(k, v); }, removeItem: k => values.delete(k) },
    navigator: { locks: { request: async (_name, fn) => fn() } },
    crypto: { randomUUID: () => String(++seq) }, addEventListener() {},
  };
  const source = read('js/data.js');
  const names = [...source.matchAll(/export (?:class|const|function) (\w+)/g)].map(m => m[1]);
  const api = new Function('globalThis', 'navigator', source.replace(/export /g, '') + `\nreturn {${names}};`)(scope, scope.navigator);
  return { api, values, fail(value) { failWrite = value; } };
}
function page(name, api, extra, fetcher = async () => { throw Error('Unexpected network call'); }) {
  const make = () => ({ value: '', disabled: false, hidden: false, innerHTML: '', textContent: '', style: {}, dataset: {}, events: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener(k, f) { this.events[k] = f; },
    setAttribute() {}, reset() {}, focus() {},
  });
  const elements = new Map([...read(`${name}.html`).matchAll(/id="([^"]+)"/g)].map(m => [m[1], make()]));
  const document = { body: make(), getElementById(id) { assert(elements.has(id), id); return elements.get(id); }, querySelectorAll: () => [], addEventListener() {} };
  const window = make();
  const timers = new Map(); let next = 0;
  const source = read(`${name}.js`);
  const imports = source.match(/^import\s*\{([^}]+)\}/)[1].split(',').map(s => s.trim()).filter(Boolean);
  const code = new Function('document', 'window', 'fetch', 'setTimeout', 'clearTimeout', ...imports,
    source.replace(/^import[\s\S]*?;\s*/, '') + `\nreturn {${extra}};`)(document, window, fetcher,
    (fn, ms) => { assert.equal(ms, 65000); timers.set(++next, fn); return next; }, id => timers.delete(id), ...imports.map(n => api[n]));
  return { code, elements, window, timers };
}
const draft = { type: 'assignment', course: '程序设计', title: '提交报告', content: '提交课程报告', deadline: null, deadlineText: '本周五前', confidence: 0.95 };

// Manual tasks share persistence, stats and ordering without creating a notice.
{
  const env = setupData();
  const extraction = { ...draft, deadlineDate: '2027-01-03', deadlineText: ' 3号之前\n',
    dateWarning: '推断日期，待确认：省略年月，涉及跨年。', referenceTime: '2026-12-31T10:00:00+08:00' };
  const n = await env.api.addNotification({ sender: '教师', source: '课程群', content: '3号交作业', extraction, extractionStatus: 'pending' });
  const p = page('task', env.api, 'openExtractModal,submitExtract');
  p.code.openExtractModal();
  assert.equal(p.elements.get('taskDeadlineInput').value, '2027-01-03');
  assert.equal(p.elements.get('taskTimeInput').value, '', 'date-only suggestion must not invent a time');
  assert.equal(p.elements.get('taskDateHint').hidden, false);
  assert.match(p.elements.get('taskDateHint').textContent, /推断日期，待确认/);
  assert.equal(env.api.getTasks().length, 0, 'prefill is not confirmation');
  assert.equal(env.api.getNotificationById(n.id).extractionStatus, 'pending');
  p.elements.get('taskTitleInput').value = '';
  await p.code.submitExtract();
  assert.match(p.elements.get('taskDateHint').textContent, /推断日期，待确认/, 'validation errors do not remove provenance');
  p.elements.get('taskTitleInput').value = '已核对的作业';
  p.elements.get('taskDeadlineInput').value = '2026-12-03';
  await p.code.submitExtract();
  assert.equal(env.api.getTasks()[0].deadlineDate, '2026-12-03');
  assert.equal(env.api.getTasks()[0].deadline, null);
  assert.equal(env.api.getTasks()[0].deadlineText, extraction.deadlineText);
  assert.deepEqual(env.api.getNotificationById(n.id).extraction, extraction, 'original inference and text remain intact');
  assert.equal(env.api.getNotificationById(n.id).extractionStatus, 'confirmed');
  p.elements.get('manualEntry').events.click();
  assert.equal(p.elements.get('taskDateHint').hidden, true, 'new manual form does not inherit previous inference warning');
  console.log('PASS 推断日期预填、持续提示、人工修改确认和原始草稿保留');
}

{
  const env = setupData();
  const p = page('task', env.api, 'submitExtract,sortTasks,fillExtractionFields,buildDeadline');
  p.elements.get('manualEntry').events.click();
  await p.code.submitExtract();
  assert.equal(env.api.getTasks().length, 0, 'blank title rejected');
  p.elements.get('taskTitleInput').value = '自学计划';
  p.elements.get('taskDeadlineInput').value = '2026-11-28';
  p.elements.get('taskTypeInput').value = 'assignment';
  await p.code.submitExtract();
  const task = env.api.getTasks()[0];
  assert.equal(task.deadlineDate, '2026-11-28');
  assert.equal(task.deadline, null);
  assert.equal(task.sourceNotificationId, null);
  assert.equal(task.sourceKind, 'manual');
  assert.equal(env.api.getNotifications().length, 0);
  assert.equal(env.api.getDashboardStats().pendingTaskCount, 1);
  await env.api.updateTask(task.id, { status: 'completed' });
  assert.equal(env.api.getDashboardStats().pendingTaskCount, 0);
  await env.api.updateTask(task.id, { status: 'pending' });
  await assert.rejects(env.api.createManualTask({ title: '错误', sourceNotificationId: 'fake' }));
  await assert.rejects(env.api.createManualTask({ title: '错误', deadlineDate: '2026-02-30' }));
  await assert.rejects(env.api.createManualTask({ title: '错误', deadlineDate: '0000-01-01' }));
  await assert.rejects(env.api.createManualTask({ title: '错误', deadline: '2026-02-30T10:00:00+08:00' }));
  await assert.rejects(env.api.createManualTask({ title: '错误', deadlineDate: '2026-11-28', deadline: '2026-11-28T20:00:00Z' }));
  const late = await env.api.createManualTask({ title: '逾期', deadline: '2000-01-01T20:00:00Z' });
  const last = await env.api.createManualTask({ title: '无日期' });
  const ordered = p.code.sortTasks(env.api.getTasks());
  assert.equal(ordered[0].id, late.id);
  assert.equal(ordered.at(-1).id, last.id);
  assert.deepEqual(env.api.getRecentTasks().map(t => t.id), ordered.map(t => t.id));
  const tied = [ { ...task, id: 'b' }, { ...task, id: 'a' } ];
  assert.deepEqual(p.code.sortTasks(tied).map(t => t.id), ['a', 'b']);
  assert.equal(env.api.isTaskOverdue(task, Date.parse('2026-11-28T23:59:59+08:00')), false);
  assert.equal(env.api.isTaskOverdue(task, Date.parse('2026-11-29T00:00:00+08:00')), true);
  p.code.fillExtractionFields({ ...draft, deadlineDate: '2026-11-28', dateWarning: '请确认' });
  assert.equal(p.code.buildDeadline().deadlineDate, '2026-11-28');
  const n = await env.api.addNotification({ sender: '教师', source: '群', content: '明天', extraction: { ...draft, deadlineDate: '2026-11-28', dateWarning: '请确认', referenceTime: '2026-11-27T12:00:00+08:00' } });
  assert.equal(env.api.getNotificationById(n.id).extraction.deadlineDate, '2026-11-28');
  // Recreate page against the same serialized store.
  const refreshed = page('task', env.api, '');
  assert.match(refreshed.elements.get('taskList').innerHTML, /自学计划/);
  console.log('PASS 手动任务、日期精度、历史接口兼容、完成重开、持久化及两页统一排序');
}
const response = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
function fill(p) {
  for (const [id, value] of Object.entries({ senderInput: '教师', sourceInput: '班级群', contentInput: '本周五前提交课程报告', aiTokenInput: 'fake-test-token' })) p.elements.get(id).value = value;
}

// Input limits count Unicode code points and never silently truncate.
{
  const env = setupData(); let calls = 0;
  const p = page('notification', env.api, 'recognizeWithAI', async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal([...request.content].length, 10000);
    assert.match(request.referenceTime, /^2026-11-23T\d{2}:\d{2}:\d{2}\+08:00$/);
    return response(200, { success: true, data: draft });
  });
  fill(p);
  p.elements.get('contentInput').value = '😀'.repeat(10001);
  p.elements.get('contentInput').events.input();
  assert.match(p.elements.get('contentCount').textContent, /10001.*超出/);
  await p.code.recognizeWithAI();
  assert.equal(calls, 0);
  assert.equal([...p.elements.get('contentInput').value].length, 10001);
  p.elements.get('contentInput').value = '😀'.repeat(10000);
  p.elements.get('referenceDateInput').value = '2026-11-23';
  await p.code.recognizeWithAI();
  assert.equal(calls, 1);
  assert.equal([...env.api.getNotifications()[0].content].length, 10000);
  await assert.rejects(env.api.addNotification({sender:'教师',source:'群',content:'中'.repeat(10001)}));
  const saved = await env.api.addNotification({sender:'教师',source:'群',content:'中'.repeat(10000)});
  assert.equal(env.api.getNotificationById(saved.id).content.length, 10000);
  console.log('PASS 10000 字符/emoji 边界、实时计数、不截断和用户修正参考日期');
}

// Deadline mapping, including JavaScript's normalized invalid dates.
{
  const env = setupData();
  const c = page('task', env.api, 'fillExtractionFields,buildDeadline,toLocalInputValue,openExtractModal,selectNotification,submitExtract,receiveExtraction');
  for (const deadline of [null, undefined, '', ' ', 'not-a-date', '2026-02-30T10:00:00Z', '2026-11-24T24:00:00Z', '2026-11-24T10:00:00']) {
    c.code.fillExtractionFields({ ...draft, deadline });
    assert.equal(c.elements.get('taskDeadlineInput').value, '');
    assert.deepEqual(c.code.buildDeadline(), { deadline: null, deadlineDate: null, deadlineText: draft.deadlineText });
  }
  c.elements.get('taskDeadlineInput').value = '2026-02-30T10:00';
  assert.equal(c.code.buildDeadline().deadline, null);
  const iso = '2028-02-29T18:30:25+08:00';
  c.code.fillExtractionFields({ ...draft, deadline: iso });
  assert.equal(Date.parse(c.code.buildDeadline().deadline), Date.parse(iso));
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    c.code.fillExtractionFields({ ...draft, deadline: iso });
    assert.equal(c.elements.get('taskDeadlineInput').value, '2028-02-29');
    assert.equal(c.elements.get('taskTimeInput').value, '18:30:25');
    assert.equal(Date.parse(c.code.buildDeadline().deadline), Date.parse(iso), 'device timezone must not shift Beijing input');
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
  const n = await env.api.addNotification({ sender: '教师', source: '群', content: '报告', extraction: draft, extractionStatus: 'pending' });
  c.code.openExtractModal(); c.code.selectNotification(n.id); await c.code.submitExtract();
  assert.equal(env.api.getTasks()[0].deadline, null);
  assert.equal(env.api.getTasks()[0].deadlineText, draft.deadlineText);
  assert.equal(env.api.getNotifications()[0].extractionStatus, 'confirmed');
  assert.equal(env.api.getNotifications()[0].isRead, true);
  // Retained development fixture exercises mapping only in isolated DOM/storage.
  const { MOCK_AI_RESULT } = await import(`data:text/javascript;base64,${Buffer.from(read('mock-ai.js')).toString('base64')}`);
  c.code.fillExtractionFields(MOCK_AI_RESULT);
  assert.equal(c.elements.get('taskTitleInput').value, MOCK_AI_RESULT.title);
  assert.doesNotMatch(read('task.js'), /import\(['"]\.\/mock-ai/);
  assert.doesNotMatch(read('task.html'), /id="loadMockAi"/);
  console.log('PASS 空值/非法日期、有效时区、人工确认 null 和模拟入口隔离');
}

// Only our exact legacy error contract identifies an outdated service.
for (const [status, payload, expected] of [
  [400, { success: false, error: { code: 'INVALID_CONTENT', message: '请提供非空的 content 字符串，且不要包含额外字段。' } }, /AI 服务版本尚未更新，请联系管理员/],
  [400, { success: false, error: { code: 'INVALID_CONTENT', message: '其他输入错误' } }, /检查填写内容/],
  [400, { success: false, error: { code: 'INVALID_REFERENCE_TIME' } }, /参考日期无效/],
  [400, { success: false, error: { code: 'CONTENT_TOO_LONG' } }, /超过服务允许的长度/],
  [400, { success: true, error: { code: 'INVALID_CONTENT', message: '请提供非空的 content 字符串，且不要包含额外字段。' } }, /检查填写内容/],
  [400, {}, /检查填写内容/],
  [500, { success: false, error: { code: 'INVALID_CONTENT', message: '请提供非空的 content 字符串，且不要包含额外字段。' } }, /HTTP 500/],
]) {
  const env = setupData(); let calls = 0;
  const p = page('notification', env.api, 'recognizeWithAI', async () => { calls++; return response(status, payload); });
  fill(p); await p.code.recognizeWithAI();
  assert.match(p.elements.get('formStatus').textContent, expected);
  assert.equal(calls, 1, 'no automatic downgrade or retry');
  assert.equal(p.elements.get('contentInput').value, '本周五前提交课程报告');
  assert.equal(p.elements.get('aiRecognize').disabled, false);
  assert.equal(env.api.getNotifications().length, 0);
}
console.log('PASS 精确识别旧后端、普通 400 不误判、输入保留且无降级重试');

// HTTP errors must not create notifications, even if a server sends success:true.
for (const status of [401, 403, 429, 500, 503, 504]) {
  const env = setupData();
  const p = page('notification', env.api, 'recognizeWithAI', async () => response(status, { success: true, data: draft }));
  fill(p); await p.code.recognizeWithAI();
  assert.match(p.elements.get('formStatus').textContent, new RegExp(String(status)));
  assert.equal(env.api.getNotifications().length, 0);
  assert.equal(p.elements.get('aiRecognize').disabled, false);
  assert.equal(p.elements.get('submitMessage').disabled, false);
  assert.equal(p.timers.size, 0);
}
for (const fetcher of [async () => { throw new TypeError('network'); },
  async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }),
  async () => response(200, { success: false }), async () => response(200, { success: true, data: null }),
  async () => response(200, { success: true, data: { ...draft, confidence: 'invalid' } })]) {
  const env = setupData(); const p = page('notification', env.api, 'recognizeWithAI', fetcher);
  fill(p); await p.code.recognizeWithAI();
  assert.match(p.elements.get('formStatus').textContent, /识别失败|识别结果字段不合法/);
  assert.equal(env.api.getNotifications().length, 0);
  assert.equal(p.elements.get('aiRecognize').disabled, false);
}
console.log('PASS HTTP 状态、网络异常、非 JSON、无效响应及按钮恢复');

// Deadline includes receiving the response body, not only receiving headers.
for (const duringBody of [false, true]) {
  const env = setupData();
  const p = page('notification', env.api, 'recognizeWithAI', async (_url, options) => {
    const wait = () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    return duringBody ? { ok: true, status: 200, json: wait } : wait();
  });
  fill(p); const running = p.code.recognizeWithAI();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(p.elements.get('aiRecognize').disabled, true);
  for (const callback of p.timers.values()) callback();
  await running;
  assert.match(p.elements.get('formStatus').textContent, /65 秒/);
  assert.equal(p.elements.get('aiRecognize').disabled, false);
  assert.equal(p.elements.get('submitMessage').disabled, false);
  assert.equal(p.timers.size, 0);
}
console.log('PASS 请求/响应体超时、计时器清理和按钮恢复');

{
  const env = setupData(); let calls = 0;
  const p = page('notification', env.api, 'recognizeWithAI,retrySaveExtraction', async (url, options) => {
    calls++;
    assert.equal(url, 'https://zhixing-ai.vercel.app/api/extract');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
    assert.deepEqual({ content: JSON.parse(options.body).content }, { content: '本周五前提交课程报告' });
    return response(200, { success: true, data: draft });
  });
  fill(p); env.fail(true); await p.code.recognizeWithAI();
  assert.match(p.elements.get('formStatus').textContent, /未保存.*当前页面/);
  assert.equal(env.api.getNotifications().length, 0, 'atomic save leaves no half notification');
  assert.equal(p.elements.get('aiRetrySave').hidden, false);
  let prevented = false;
  p.window.events.beforeunload({ preventDefault() { prevented = true; } });
  assert(prevented);
  p.elements.get('contentInput').value = 'another notice';
  await p.code.recognizeWithAI();
  assert.equal(calls, 1, 'new recognition cannot overwrite pending draft');
  await p.code.retrySaveExtraction();
  assert.match(p.elements.get('formStatus').textContent, /重试保存失败/);
  env.fail(false); await p.code.retrySaveExtraction(); await p.code.retrySaveExtraction();
  assert.equal(calls, 1, 'retry never calls model');
  assert.equal(env.api.getNotifications().length, 1, 'retry saves exactly one notification');
  const stored = env.api.getNotifications()[0];
  assert.equal(stored.content, '本周五前提交课程报告');
  assert.deepEqual(stored.extraction, draft);
  assert.equal(stored.extractionStatus, 'pending');
  assert.equal(stored.isRead, true, '主动识别并展示结果后已读，但仍待确认');
  assert.equal(env.api.getTasks().length, 0);
  assert.equal(p.elements.get('aiRecognize').disabled, false);
  assert.equal(p.elements.get('aiRetrySave').hidden, true);
  assert(!JSON.stringify([...env.values]).includes('fake-test-token'));
  const refreshed = page('notification', env.api, '');
  assert.equal(refreshed.elements.get('allCount').textContent, 1);
  assert.deepEqual(env.api.getNotifications()[0].extraction, draft);
  console.log('PASS 保存失败、草稿保护、离页提醒、无付费重试、刷新持久化及令牌不入存储');
}

{
  const env = setupData();
  const n = await env.api.addNotification({ sender: '老师', source: '班群', content: '通知', extraction: draft, extractionStatus: 'pending' });
  assert.equal(n.isRead, false, '普通新增默认为未读');
  const c = page('task', env.api, 'openExtractModal,submitExtract,selectNotification');
  c.code.openExtractModal();
  assert.equal(c.elements.get('taskTitleInput').value, draft.title, '唯一候选自动预填');
  await Promise.resolve();
  assert.equal(env.api.getNotifications()[0].isRead, true, '查看草稿后已读');
  assert.equal(env.api.getNotifications()[0].extractionStatus, 'pending');
  assert.equal(env.api.getTasks().length, 0);
  assert.equal(env.api.getDashboardStats().unreadCount, 0);
  await c.code.submitExtract();
  const t = env.api.getTasks()[0];
  await env.api.updateNotification(n.id, { isRead: false });
  await env.api.updateTask(t.id, { status: 'completed' });
  assert.equal(env.api.getNotifications()[0].isRead, false, '任务完成不改已读状态');
  assert.equal(env.api.getNotifications()[0].extractionStatus, 'confirmed');
  await env.api.updateNotification(n.id, { isRead: true });
  assert.equal(env.api.getTasks()[0].status, 'completed', '已读不影响任务状态');
  const first = await env.api.addNotification({ sender: '老师', source: '群', content: '另一条', extraction: draft, extractionStatus: 'pending' });
  await env.api.addNotification({ sender: '老师', source: '群', content: '第二条', extraction: draft, extractionStatus: 'pending' });
  const multi = page('task', env.api, 'openExtractModal,selectNotification');
  multi.code.openExtractModal();
  assert.equal(multi.elements.get('taskTitleInput').value, '', '多个候选不擅自选择');
  assert.equal(multi.elements.get('extractSubmit').disabled, true);
  multi.code.selectNotification(first.id);
  assert.equal(multi.elements.get('taskTitleInput').value, draft.title);
  console.log('PASS 唯一候选自动预填、多候选手选、已读/确认/完成状态独立');
}
