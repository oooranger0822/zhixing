// node tests/integration.test.mjs：隔离页面脚本回归，不访问真实存储。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
for (const page of ['index', 'notification', 'task']) {
  const html = read(`${page}.html`);
  for (const destination of ['notification.html', 'task.html']) {
    assert.ok(html.includes(`href="./${destination}"`), `${page} 可进入 ${destination}`);
  }
  if (page !== 'index') assert.ok(html.includes('href="./index.html"'));
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+|(?:notification|task)\.(?:js|css))"/g)) {
    assert.ok(existsSync(new URL(`../${match[1]}`, import.meta.url)), `资源存在：${match[1]}`);
  }
}
for (const script of ['notification.js', 'task.js', 'js/home.js']) {
  const specifier = read(script).match(/from\s+['"]([^'"]+)['"]/)[1];
  const resolved = new URL(specifier, `https://example.test/zhixing/${script}`);
  assert.equal(resolved.pathname, '/zhixing/js/data.js', `${script} 子目录导入正确`);
}
console.log('PASS 三页导航目标、资源存在及子目录模块导入路径');

function environment(page) {
  const make = () => ({
    events: {}, dataset: {}, style: {}, disabled: false, hidden: false,
    innerHTML: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { this.events[name] = fn; },
    setAttribute() {}, reset() {}, focus() {},
  });
  const html = read(`${page}.html`);
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], make()]));
  const tabs = ['all', page === 'task' ? 'pending' : 'course'].map(category => {
    const tab = make(); tab.dataset = { category, filter: category }; return tab;
  });
  const document = {
    body: make(),
    getElementById(id) { assert.ok(elements.has(id), `DOM ID 存在：${id}`); return elements.get(id); },
    querySelectorAll: selector => selector === '.tab' ? tabs : [],
    addEventListener() {},
  };
  return { elements, tabs, document, window: { addEventListener() {} } };
}

function run(page, env, api) {
  const source = read(`${page}.js`);
  const imports = source.match(/^import\s*\{([^}]+)\}/)[1].split(',').map(name => name.trim()).filter(Boolean);
  new Function('document', 'window', ...imports, source.replace(/^import[\s\S]*?;\s*/, ''))(
    env.document, env.window, ...imports.map(name => api[name]),
  );
}

const noticeEnv = environment('notification');
let broken = true;
let noticeSubscriber;
const notice = { id: 'n1', sender: '测试', content: '<文本>', type: 'course', time: new Date().toISOString(), isRead: false };
run('notification', noticeEnv, {
  getNotifications() { if (broken) throw new Error('读取权限异常'); return [notice]; },
  subscribe(fn) { noticeSubscriber = fn; },
  async addNotification() {}, async updateNotification() {},
});
const list = noticeEnv.elements.get('notificationList');
assert.match(list.innerHTML, /通知加载失败/);
noticeEnv.tabs[1].events.click();
assert.match(list.innerHTML, /通知加载失败/);
assert.doesNotMatch(list.innerHTML, /暂无通知/);
assert.equal(noticeEnv.elements.get('allCount').textContent, '—');
assert.equal(noticeEnv.elements.get('loadMore').disabled, true);
broken = false;
await list.events.click({ target: { closest: selector => selector === '[data-action="retry"]' ? {} : null } });
assert.doesNotMatch(list.innerHTML, /通知加载失败/);
assert.match(list.innerHTML, /&lt;文本&gt;/);
assert.equal(noticeEnv.elements.get('allCount').textContent, 1);
broken = true;
noticeSubscriber();
assert.match(list.innerHTML, /通知加载失败/);
broken = false;
noticeSubscriber();
assert.doesNotMatch(list.innerHTML, /通知加载失败/);
console.log('PASS 通知读取错误不被分类空态覆盖，重试及订阅恢复正常');

const taskEnv = environment('task');
const task = { id: 't1', title: '任务', status: 'pending', sourceNotificationId: null, deadline: null, createdAt: new Date().toISOString() };
let updates = 0;
run('task', taskEnv, {
  getTasks: () => [task], getNotifications: () => [], subscribe: () => () => {},
  async updateTask(id, changes) { assert.equal(id, task.id); updates++; Object.assign(task, changes); },
  async createTaskFromNotification() {}, DataError: class extends Error {},
});
const taskList = taskEnv.elements.get('taskList');
const card = { dataset: { id: task.id }, closest: selector => selector === '.task-card' ? card : null };
const button = { dataset: { id: task.id }, disabled: false, closest: selector => selector === '.task-card' ? card : selector === '.toggle-btn' ? button : null };
for (const key of ['Enter', ' ']) {
  let prevented = false;
  taskList.events.keydown({ target: button, key, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, `${key} 保留按钮默认行为`);
  taskList.events.keydown({ target: card, key, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, `${key} 激活卡片详情`);
}
taskList.events.click({ target: button, stopPropagation() {} });
await Promise.resolve();
assert.equal(updates, 1);
assert.equal(task.status, 'completed');
console.log('PASS 卡片键盘激活与内部按钮互不干扰，原点击完成逻辑保留');
