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
const response = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
function fill(p) {
  for (const [id, value] of Object.entries({ senderInput: '教师', sourceInput: '班级群', contentInput: '本周五前提交课程报告', aiTokenInput: 'fake-test-token' })) p.elements.get(id).value = value;
}

// Deadline mapping, including JavaScript's normalized invalid dates.
{
  const env = setupData();
  const c = page('task', env.api, 'fillExtractionFields,buildDeadline,toLocalInputValue,openExtractModal,selectNotification,submitExtract,receiveExtraction');
  for (const deadline of [null, undefined, '', ' ', 'not-a-date', '2026-02-30T10:00:00Z', '2026-11-24T24:00:00Z', '2026-11-24T10:00:00']) {
    c.code.fillExtractionFields({ ...draft, deadline });
    assert.equal(c.elements.get('taskDeadlineInput').value, '');
    assert.deepEqual(c.code.buildDeadline(), { deadline: null, deadlineText: draft.deadlineText });
  }
  c.elements.get('taskDeadlineInput').value = '2026-02-30T10:00';
  assert.equal(c.code.buildDeadline().deadline, null);
  const iso = '2028-02-29T18:30:00+08:00';
  c.code.fillExtractionFields({ ...draft, deadline: iso });
  assert.equal(Date.parse(c.code.buildDeadline().deadline), Date.parse(iso));
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
    assert.deepEqual(JSON.parse(options.body), { content: '本周五前提交课程报告' });
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
