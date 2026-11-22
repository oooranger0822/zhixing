// 无依赖测试：node tests/data.test.mjs。隔离存储，不触碰用户浏览器数据。
export async function runTests(source) {
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  async function rejects(action, code) {
    try { await action(); } catch (error) { assert(error.code === code, `预期 ${code}，实际 ${error.code}`); return; }
    throw new Error(`预期抛出 ${code}`);
  }
  function setup() {
    const values = new Map();
    let failKey = null;
    const localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem(key, value) { if (key === failKey) throw new Error('quota'); values.set(key, String(value)); },
      removeItem: key => values.delete(key),
    };
    let queue = Promise.resolve();
    const navigator = { locks: { request(name, fn) {
      const next = queue.then(fn);
      queue = next.catch(() => {});
      return next;
    } } };
    let uuid = 0;
    const crypto = { randomUUID: () => `test-${++uuid}` };
    function tab() {
      let onStorage;
      const scope = { localStorage, navigator, crypto, addEventListener(type, fn) { onStorage = fn; } };
      const exports = [...source.matchAll(/export (?:class|const|function) (\w+)/g)].map(match => match[1]);
      const api = new Function('globalThis', 'navigator', 'console', `${source.replace(/export /g, '')}\nreturn {${exports.join(',')}};`)(scope, navigator, { error() {} });
      return { api, dispatch: event => onStorage({ storageArea: localStorage, ...event }) };
    }
    return { ...tab(), tab, values, localStorage, fail(key) { failKey = key; } };
  }
  const notice = { sender: '教务处', source: '班级群', content: '原始通知：周五提交报告', type: 'assignment' };
  async function test(name, action) { await action(); results.push(`PASS ${name}`); }
  await test('通知增读改删、校验、原文和 ID 保护', async () => {
    const { api: a } = setup();
    await rejects(() => a.addNotification({ ...notice, sender: '' }), 'VALIDATION');
    await rejects(() => a.addNotification({ ...notice, extractionStatus: 'confirmed' }), 'VALIDATION');
    assert(a.getNotifications().length === 0, '新增时不能伪造 confirmed');
    const n = await a.addNotification(notice);
    const events = [];
    const unsubscribe = a.subscribe(event => events.push(event));
    await rejects(() => a.updateNotification(n.id, { extractionStatus: 'confirmed', summary: '非法修改' }), 'VALIDATION');
    assert(a.getNotificationById(n.id).extractionStatus === 'none' && a.getNotificationById(n.id).summary === '', '拒绝修改不改变数据');
    assert(events.length === 0 && a.getTasks().length === 0, '拒绝修改不触发事件或创建任务');
    await a.updateNotification(n.id, { extractionStatus: 'pending' });
    await rejects(() => a.updateNotification(n.id, { extractionStatus: 'confirmed' }), 'VALIDATION');
    assert(a.getNotificationById(n.id).extractionStatus === 'pending', 'pending 不能直接确认');
    await a.updateNotification(n.id, { extractionStatus: 'none' });
    assert(a.getNotificationById(n.id).extractionStatus === 'none', '保留 none/pending 切换');
    unsubscribe();
    assert(a.getNotifications().length === 1 && a.getNotificationById(n.id).content === notice.content, '读取');
    await a.updateNotification(n.id, { isRead: true, summary: '报告' });
    assert(a.getNotificationById(n.id).isRead, '更新');
    await rejects(() => a.updateNotification(n.id, { id: 'changed' }), 'VALIDATION');
    await rejects(() => a.updateNotification(n.id, { content: '改原文' }), 'VALIDATION');
    assert(await a.deleteNotification(n.id), '删除');
    assert(a.getNotificationById(n.id) === null && !(await a.deleteNotification(n.id)), '删除不存在记录');
  });
  await test('任务 CRUD、可空截止时间、完成与取消完成', async () => {
    const { api: a } = setup();
    await rejects(() => a.addTask({ title: '' }), 'VALIDATION');
    const t = await a.addTask({ title: '报告', deadline: null });
    assert(t.deadline === null && a.getTasks().length === 1, '新增');
    const completed = await a.updateTask(t.id, { status: 'completed' });
    assert(completed.completedAt !== null, '完成时间');
    assert((await a.updateTask(t.id, { title: '新报告' })).completedAt === completed.completedAt, '保留完成时间');
    assert((await a.updateTask(t.id, { status: 'pending' })).completedAt === null, '取消完成');
    await rejects(() => a.updateTask(t.id, { sourceNotificationId: 'changed' }), 'VALIDATION');
    await a.deleteTask(t.id);
    assert(a.getTaskById(t.id) === null, '删除');
  });
  await test('多标签并发提取、防重复、删除通知保留任务', async () => {
    const env = setup(); const a = env.api; const b = env.tab().api;
    const n = await a.addNotification(notice);
    const outcomes = await Promise.allSettled([
      a.createTaskFromNotification(n.id, { title: '报告' }),
      b.createTaskFromNotification(n.id, { title: '重复报告' }),
    ]);
    assert(outcomes.filter(result => result.status === 'fulfilled').length === 1, '只生成一次');
    assert(outcomes.find(result => result.status === 'rejected').reason.code === 'DUPLICATE_TASK', '重复错误');
    const t = a.getTasks()[0];
    assert(t.sourceNotificationId === n.id && t.content === notice.content, '来源与内容');
    assert(a.getNotificationById(n.id).extractionStatus === 'confirmed', '确认');
    for (const extractionStatus of ['none', 'pending', 'confirmed']) {
      await rejects(() => a.updateNotification(n.id, { extractionStatus }), 'VALIDATION');
    }
    await a.updateNotification(n.id, { isRead: true });
    assert(a.getNotificationById(n.id).extractionStatus === 'confirmed', '正常编辑保留 confirmed');
    await rejects(() => a.addTask({ title: '绕过', sourceNotificationId: n.id }), 'DUPLICATE_TASK');
    await a.deleteTask(t.id);
    assert(a.getNotificationById(n.id).extractionStatus === 'confirmed', '删除任务保留 confirmed');
    await rejects(() => a.createTaskFromNotification(n.id, { title: '再次提取' }), 'DUPLICATE_TASK');
    const n2 = await a.addNotification(notice);
    const t2 = await a.createTaskFromNotification(n2.id, { title: '保留' });
    await a.deleteNotification(n2.id);
    assert(a.getTaskById(t2.id) !== null, '保留关联任务');
  });
  await test('同页/跨标签事件、退订及回调故障隔离', async () => {
    const env = setup(); const a = env.api; const events = [];
    a.subscribe(() => { throw new Error('页面渲染故障'); });
    const unsubscribe = a.subscribe(event => events.push(event));
    await a.addNotification(notice);
    assert(events.length === 1 && events[0].source === 'local', '同页事件');
    env.dispatch({ key: a.STORAGE_KEYS.tasks });
    env.dispatch({ key: 'unrelated' });
    assert(events.length === 2 && events[1].source === 'external', '跨页事件过滤');
    env.dispatch({ key: null });
    assert(events.length === 3, '跨页清空事件');
    unsubscribe(); await a.addTask({ title: '退订' });
    assert(events.length === 3, '退订');
  });
  await test('损坏数据保留、键隔离、写入失败与提取回滚', async () => {
    const env = setup(); const a = env.api; const keys = a.STORAGE_KEYS;
    env.values.set(keys.notifications, '{broken');
    await rejects(() => a.getNotifications(), 'CORRUPT_DATA');
    await rejects(() => a.addNotification(notice), 'CORRUPT_DATA');
    assert(env.values.get(keys.notifications) === '{broken', '损坏原文保留');
    await a.addTask({ title: '独立任务' });
    assert(a.getTasks().length === 1, '其他键可用');
    env.values.delete(keys.notifications);
    const n = await a.addNotification(notice);
    const before = env.values.get(keys.tasks);
    env.fail(keys.notifications);
    await rejects(() => a.createTaskFromNotification(n.id, { title: '失败提取' }), 'STORAGE_WRITE_FAILED');
    assert(env.values.get(keys.tasks) === before, '回滚任务');
    assert(a.getNotificationById(n.id).extractionStatus === 'none', '通知未改动');
    env.fail(keys.tasks);
    await rejects(() => a.addTask({ title: '空间不足' }), 'STORAGE_WRITE_FAILED');
  });
  await test('首页统计、今日通知、近期任务排序', async () => {
    const { api: a } = setup();
    await a.addNotification({ ...notice, isImportant: true });
    await a.addNotification({ ...notice, isImportant: true, isRead: true });
    await a.addNotification({ ...notice, time: '2000-01-01T00:00:00Z' });
    await a.addTask({ title: '未知日期' });
    const overdue = await a.addTask({ title: '逾期', deadline: '2000-01-01T00:00:00Z' });
    await a.addTask({ title: '已完成', status: 'completed' });
    assert(JSON.stringify(a.getDashboardStats()) === JSON.stringify({ notificationCount: 3, unreadCount: 2, pendingTaskCount: 2, importantCount: 1 }), '统计');
    assert(a.getTodayHighlights().length === 2, '今日');
    const today = new Date();
    const atHour = hour => { const time = new Date(today); time.setHours(hour, 0, 0, 0); return time.toISOString(); };
    const early = await a.addNotification({ ...notice, isImportant: true, time: atHour(8) });
    const late = await a.addNotification({ ...notice, isImportant: true, time: atHour(9) });
    const ordinary = await a.addNotification({ ...notice, time: atHour(23) });
    const highlights = a.getTodayHighlights();
    const position = id => highlights.findIndex(row => row.id === id);
    assert(highlights.length === 5 && position(ordinary.id) >= 0, '今日包含普通通知');
    assert(position(late.id) < position(early.id) && position(early.id) < position(ordinary.id), '重要优先，同类时间倒序');
    assert(a.getRecentTasks().length === 2 && a.getRecentTasks()[0].id === overdue.id, '近期排序');
  });
  return results;
}

// CLI runner
if (typeof process !== 'undefined' && process.versions?.node) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
  for (const result of await runTests(source)) console.log(result);
}
