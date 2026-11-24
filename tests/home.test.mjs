// node tests/home.test.mjs — 隔离的内存数据与最小 DOM，不访问浏览器存储。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.events = {};
    this.open = false;
    this.hidden = false;
    this.value = '';
    this.parentElement = null;
    this.listenerCounts = {};
  }
  set textContent(value) { this.replaceChildren(); this.value = String(value); }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('不允许使用 innerHTML'); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === 'fragment') this.append(...Array.from(child.children));
      else this.insertBefore(child, null);
    }
  }
  replaceChildren(...children) {
    for (const child of Array.from(this.children)) child.remove();
    this.value = '';
    this.append(...children);
  }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  remove() {
    if (this.parentElement) {
      if (this.contains(document.activeElement)) document.activeElement = null;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  insertBefore(child, reference) {
    child.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    assert.ok(index >= 0);
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }
  focus(options) { document.activeElement = this; this.focusOptions = options; }
  matches(selector) {
    if (selector === '[data-notification-id]') return this.dataset.notificationId !== undefined;
    if (selector === '[data-action]') return this.dataset.action !== undefined;
    if (selector.startsWith('input,')) return ['input', 'textarea', 'select'].includes(this.tagName) || this.attributes.contenteditable === 'true';
    return selector === this.tagName || (selector === 'details[open]' && this.tagName === 'details' && this.open);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, callback) { this.listenerCounts[key] = (this.listenerCounts[key] ?? 0) + 1; this.events[key] = callback; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, 'HTML ID 唯一');
const elements = new Map(ids.map(id => [id, new Element()]));
const links = ['#overview', '#highlights', '#notifications', '#tasks'].map(href => {
  const link = new Element('a');
  link.setAttribute('href', href);
  return link;
});
const document = {
  hidden: false,
  activeElement: null,
  listenerCounts: {},
  events: {},
  createElement: tag => new Element(tag),
  createDocumentFragment: () => new Element('fragment'),
  getElementById: id => { assert.ok(elements.has(id), `存在 DOM 元素 ${id}`); return elements.get(id); },
  querySelectorAll: () => links,
  addEventListener(key, callback) { this.listenerCounts[key] = (this.listenerCounts[key] ?? 0) + 1; this.events[key] = callback; },
};
const window = {
  events: {}, location: { hash: '' }, intervals: new Map(), sequence: 0,
  listenerCounts: {},
  addEventListener(key, callback) { this.listenerCounts[key] = (this.listenerCounts[key] ?? 0) + 1; this.events[key] = callback; },
  setInterval(callback) { const id = ++this.sequence; this.intervals.set(id, callback); return id; },
  clearInterval(id) { this.intervals.delete(id); },
};
const values = new Map();
let writes = 0;
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem(key, value) { writes++; values.set(key, value); },
};
let externalChange;
let sequence = 0;
const scope = {
  localStorage: storage,
  navigator: { locks: { request: async (_, callback) => callback() } },
  crypto: { randomUUID: () => `home-test-${++sequence}` },
  addEventListener: (_, callback) => { externalChange = callback; },
};
const dataSource = readFileSync(new URL('../js/data.js', import.meta.url), 'utf8');
const exports = [...dataSource.matchAll(/export (?:class|const|function) (\w+)/g)].map(match => match[1]);
const api = new Function('globalThis', 'navigator', `${dataSource.replace(/export /g, '')}\nreturn {${exports.join(',')}};`)(scope, scope.navigator);
const homeSource = readFileSync(new URL('../js/home.js', import.meta.url), 'utf8');
assert.doesNotMatch(homeSource, /localStorage|innerHTML|insertAdjacentHTML/);
const names = [...homeSource.match(/import \{([^}]+)\}/)[1].matchAll(/\w+/g)].map(match => match[0]);
let activeSubscriptions = 0;
const subscribe = api.subscribe;
api.subscribe = callback => {
  activeSubscriptions++;
  const stop = subscribe(callback);
  return () => { activeSubscriptions--; stop(); };
};
new Function('document', 'window', ...names, homeSource.replace(/^import .+;\r?\n/, ''))(document, window, ...names.map(name => api[name]));
const text = id => elements.get(id).textContent;
assert.equal(text('notification-count'), '0');
assert.match(text('highlight-list'), /今天还没有新通知/);
assert.equal(writes, 0, '初始化不写入存储');
console.log('PASS 首次加载空态与只读初始化');

const content = '<img src=x onerror="alert(1)">\n通知原文 & 保留换行';
const important = await api.addNotification({ sender: '教务处', source: '班级群', content, isImportant: true });
await api.addNotification({ sender: '老师', source: '课程群', content: '普通通知', time: new Date(Date.now() + 1000).toISOString() });
await api.addTask({ title: '待办测试', deadline: new Date(Date.now() - 3600_000).toISOString() });
await api.addTask({ title: '时间未知的任务', deadlineText: '下周讨论后确定' });
assert.equal(text('notification-count'), '2');
assert.equal(text('unread-count'), '2');
assert.equal(text('pending-count'), '2');
assert.match(elements.get('highlight-list').children[0].textContent, /通知原文/);
assert.match(elements.get('notification-list').children[0].textContent, /普通通知/);
assert.ok(text('highlight-list').includes(content), '原文安全按纯文本展示');
assert.match(text('task-list'), /已逾期/);
assert.match(text('task-list'), /截止待确认 · 下周讨论后确定/);
const details = elements.get('highlight-list').querySelectorAll('details')[0];
const markingRead = details.children[0].events.click();
details.open = true;
await markingRead;
assert.equal(text('unread-count'), '1');
assert.equal(api.getNotificationById(important.id).extractionStatus, 'none', '查看原文不确认 AI');
assert.equal(elements.get('highlight-list').querySelectorAll('details')[0].open, true);
console.log('PASS 实际公共接口订阅重读、排序、原文安全与展开状态保留');

const notificationKey = api.STORAGE_KEYS.notifications;
const original = values.get(notificationKey);
values.set(notificationKey, '{broken');
const beforeFailure = writes;
externalChange({ storageArea: storage, key: notificationKey });
assert.equal(text('notification-count'), '—');
assert.match(text('highlight-list'), /读取失败/);
assert.match(text('notification-list'), /原始数据已保留/);
assert.match(text('task-list'), /待办测试/);
assert.equal(writes, beforeFailure, '错误处理不得写入');
assert.equal(values.get(notificationKey), '{broken');
values.set(notificationKey, original);
elements.get('refresh').events.click();
assert.equal(text('notification-count'), '2');
assert.equal(elements.get('stats-error').hidden, true);
console.log('PASS 损坏数据分区隔离、保留原值、刷新恢复');

const oldRead = storage.getItem;
storage.getItem = () => { throw new Error('permission denied'); };
elements.get('refresh').events.click();
assert.match(text('task-list'), /浏览器存储权限/);
storage.getItem = oldRead;
elements.get('refresh').events.click();
assert.equal(window.intervals.size, 1);
window.events.pagehide();
assert.equal(window.intervals.size, 0);
await api.addTask({ title: '页面离开后新增' });
assert.equal(text('pending-count'), '2', '离开后已退订');
window.events.pageshow();
assert.equal(text('pending-count'), '3');
assert.equal(window.intervals.size, 1);
console.log('PASS 存储权限失败、页面退订与返回重连');

const latest = elements.get('notification-list');
const highlight = elements.get('highlight-list');
const cardById = (container, id) => container.children.find(child => child.dataset.notificationId === id);
const card = cardById(latest, important.id);
const originalDetails = card.querySelector('details');
const summary = originalDetails.children[0];
originalDetails.open = true;
summary.focus();
const tick = () => Array.from(window.intervals.values())[0]();
tick();
assert.equal(cardById(latest, important.id), card, '定时刷新复用卡片');
assert.equal(document.activeElement, summary, '定时刷新保留原焦点节点');
assert.equal(originalDetails.open, true);
await api.updateNotification(important.id, { summary: '更新后的摘要', time: new Date(Date.now() + 2000).toISOString() });
assert.equal(latest.children[0], card, '更新发布时间后排序正确');
assert.equal(document.activeElement, summary, '移动卡片导致失焦后恢复');
assert.equal(summary.focusOptions.preventScroll, true);
assert.equal(card.querySelector('details'), originalDetails);
assert.match(card.textContent, /更新后的摘要/);
assert.equal(originalDetails.open, true);
assert.notEqual(cardById(highlight, important.id), card, '两个列表独立复用节点');
console.log('PASS 定时与订阅刷新复用节点、保留展开状态并恢复排序后的焦点');

// 模拟一个需要重建的同 ID 卡片，不依赖生产代码的内部 WeakMap。
function copyElement(element) {
  const copy = new Element(element.tagName);
  copy.dataset = { ...element.dataset };
  copy.open = element.open;
  copy.value = element.value;
  copy.append(...element.children.map(copyElement));
  return copy;
}
const replacement = copyElement(card);
latest.insertBefore(replacement, card);
card.remove();
replacement.querySelector('summary').focus();
tick();
const rebuilt = cardById(latest, important.id);
assert.notEqual(rebuilt, replacement);
assert.equal(rebuilt.querySelector('details').open, true);
assert.equal(document.activeElement, rebuilt.querySelector('summary'), '按 ID + action 恢复重建后的焦点');
assert.equal(document.activeElement.focusOptions.preventScroll, true);

const refresh = elements.get('refresh');
refresh.focus();
tick();
assert.equal(document.activeElement, refresh, '不抢走列表外按钮焦点');
const input = new Element('input');
input.value = '正在输入的草稿';
rebuilt.append(input);
input.focus();
await api.updateNotification(important.id, { summary: '输入结束后更新' });
tick();
assert.equal(document.activeElement, input);
assert.equal(input.value, '正在输入的草稿');
assert.doesNotMatch(rebuilt.textContent, /输入结束后更新/);
refresh.focus();
document.events.focusout({ target: input });
await Promise.resolve();
assert.match(rebuilt.textContent, /输入结束后更新/);
assert.equal(document.activeElement, refresh);
assert.equal(input.value, '正在输入的草稿');
console.log('PASS 卡片重建焦点回退、按钮焦点保护和输入期间延后刷新');

for (let i = 0; i < 3; i++) {
  refresh.events.click();
  window.events.pageshow();
}
assert.equal(window.intervals.size, 1);
assert.equal(activeSubscriptions, 1);
for (const counts of [document.listenerCounts, window.listenerCounts, refresh.listenerCounts]) {
  assert.ok(Object.values(counts).every(count => count === 1), '没有重复事件监听');
}
rebuilt.querySelector('summary').focus();
await api.deleteNotification(important.id);
assert.equal(cardById(latest, important.id), undefined);
assert.equal(document.activeElement, latest, '通知删除后焦点留在原分区');
assert.equal(latest.focusOptions.preventScroll, true);
window.events.pagehide();
assert.equal(activeSubscriptions, 0);
assert.equal(window.intervals.size, 0);
window.events.pageshow();
assert.equal(activeSubscriptions, 1);
console.log('PASS 无重复监听/订阅/定时器，删除通知后焦点合理回退');

// 保存完成就应更新只读标签；输入保护只延后正文，不能延后已读反馈。
const latencyNotice = await api.addNotification({ sender: '测试', source: '班群', content: '即时已读检查' });
const latencyCard = cardById(latest, latencyNotice.id);
const latencyInput = new Element('input');
latencyInput.value = '未提交的输入';
latencyCard.append(latencyInput);
latencyInput.focus();
const hasUnread = card => card.children[0].children.some(child => child.className === 'unread');
assert.equal(hasUnread(latencyCard), true);
const unreadBefore = api.getDashboardStats().unreadCount;
const started = performance.now();
await api.updateNotification(latencyNotice.id, { isRead: true });
const savedIn = performance.now() - started;
assert.equal(hasUnread(latencyCard), false, '输入期间保存成功也立即移除未读标签，无需 tick/失焦');
assert.equal(text('unread-count'), String(unreadBefore - 1));
assert.equal(document.activeElement, latencyInput);
assert.equal(latencyInput.value, '未提交的输入');
assert.equal(api.getNotificationById(latencyNotice.id).isRead, true);
console.log(`PASS 保存及订阅立即更新已读标签（隔离内存耗时 ${savedIn.toFixed(2)}ms，非真实浏览器基准）`);

// 锁尚未取得或写入失败时，不允许提前展示已读。
refresh.focus();
await api.updateNotification(latencyNotice.id, { isRead: false });
const normalLock = scope.navigator.locks.request;
let release;
scope.navigator.locks.request = (_name, callback) => new Promise((resolve, reject) => {
  release = () => { try { resolve(callback()); } catch (error) { reject(error); } };
});
const pendingDetails = cardById(latest, latencyNotice.id).querySelector('details');
pendingDetails.open = false;
const pendingRead = pendingDetails.children[0].events.click();
assert.equal(api.getNotificationById(latencyNotice.id).isRead, false);
assert.equal(hasUnread(cardById(latest, latencyNotice.id)), true);
assert.equal(text('unread-count'), String(unreadBefore));
release();
await pendingRead;
assert.equal(hasUnread(cardById(latest, latencyNotice.id)), false);
assert.equal(text('unread-count'), String(unreadBefore - 1));
scope.navigator.locks.request = normalLock;
await api.updateNotification(latencyNotice.id, { isRead: false });
const setItem = storage.setItem;
storage.setItem = () => { throw new Error('quota'); };
await pendingDetails.children[0].events.click();
assert.equal(api.getNotificationById(latencyNotice.id).isRead, false);
assert.equal(hasUnread(cardById(latest, latencyNotice.id)), true);
assert.equal(text('unread-count'), String(unreadBefore));
assert.match(text('subscription-error'), /已读状态保存失败/);
storage.setItem = setItem;
await pendingDetails.children[0].events.click();
window.events.pagehide(); window.events.pageshow();
assert.equal(api.getNotificationById(latencyNotice.id).isRead, true);
assert.equal(hasUnread(cardById(latest, latencyNotice.id)), false);
assert.equal(text('unread-count'), String(unreadBefore - 1));
console.log('PASS 锁等待与写入失败不伪造已读，保存后立即更新，页面恢复仍正确');
