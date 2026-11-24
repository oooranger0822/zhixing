import { getDashboardStats, getTodayHighlights, getNotifications, getRecentTasks, subscribe, updateNotification } from './data.js';

const byId = id => document.getElementById(id);
const typeLabels = { course: '课程', assignment: '作业', exam: '考试', activity: '活动', class: '班级', other: '通知' };
const numberFormat = new Intl.NumberFormat('zh-CN');
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
let unsubscribe = null;
let timer = null;
const notificationViews = new WeakMap();
const editingSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

// 外部内容仅写入 textContent，通知原文不参与 HTML 解析。
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function emptyState(title, description, failed = false) {
  const state = node('div', `empty-state${failed ? ' error-state' : ''}`);
  const symbol = node('span', 'empty-symbol', failed ? '!' : '✓');
  symbol.setAttribute('aria-hidden', 'true');
  state.append(symbol, node('h3', '', title), node('p', '', description));
  if (failed) state.setAttribute('role', 'alert');
  return state;
}

function errorText(error) {
  if (error?.code === 'CORRUPT_DATA') return '数据格式异常，原始数据已保留。请修复后点击“刷新概览”。';
  if (error?.code === 'STORAGE_UNAVAILABLE') return '无法读取本地数据，请检查浏览器存储权限后重试。';
  return '暂时无法读取数据，请点击“刷新概览”重试。';
}

function notificationCard(item, highlight) {
  const article = node('article', `notice ${highlight ? 'highlight-notice' : 'latest-notice'}${item.isImportant ? ' important' : ''}`);
  article.dataset.notificationId = item.id;
  const meta = node('div', 'notice-meta');
  meta.append(node('span', 'tag', typeLabels[item.type] ?? '通知'));
  if (item.isImportant) meta.append(node('span', 'tag tag-important', '重要'));
  if (!item.isRead) meta.append(node('span', 'unread', '未读'));
  const time = node('time', '', dateFormat.format(new Date(item.time)));
  time.dateTime = item.time;
  meta.append(time);
  const heading = item.summary.trim() || (item.content.length > 80 ? `${item.content.slice(0, 80)}…` : item.content);
  const details = node('details');
  details.dataset.notificationId = item.id;
  const summary = node('summary', '', '查看通知原文');
  summary.dataset.action = 'toggle-original';
  summary.addEventListener('click', async () => {
    if (details.open) return; // Only actively opening the original marks it read.
    try {
      const current = getNotifications().find(row => row.id === item.id);
      if (current && !current.isRead) await updateNotification(item.id, { isRead: true });
    } catch (error) {
      const banner = byId('subscription-error');
      banner.hidden = false;
      banner.textContent = `已读状态保存失败：${error?.message || '请重试'}`;
    }
  });
  details.append(summary, node('p', 'original', item.content));
  article.append(meta, node('h3', '', heading), node('p', 'notice-source', `${item.sender} · ${item.source}`), details);
  notificationViews.set(article, JSON.stringify(item));
  return article;
}

function captureFocus(container) {
  const element = document.activeElement;
  if (!element || !container.contains(element)) return null;
  return {
    element,
    id: element.closest('[data-notification-id]')?.dataset.notificationId,
    action: element.dataset.action,
  };
}

function restoreFocus(container, focus) {
  if (!focus || document.activeElement === focus.element) return;
  const card = Array.from(container.children).find(child => child.dataset.notificationId === focus.id);
  // 先恢复原节点；必须重建时按通知 ID + 操作标识查找，不拼接外部内容为选择器。
  const target = container.contains(focus.element) ? focus.element
    : Array.from(card?.querySelectorAll('[data-action]') ?? []).find(element => element.dataset.action === focus.action);
  if (target) target.focus({ preventScroll: true });
  else {
    // 通知被删除或退出当前列表时，将焦点留在原分区而不是跳回页面顶部。
    container.tabIndex = -1;
    container.focus({ preventScroll: true });
  }
}

function renderNotifications(container, rows, render, emptyTitle, emptyDescription) {
  const focus = captureFocus(container);
  const existing = new Map(Array.from(container.children)
    .filter(child => child.dataset.notificationId)
    .map(child => [child.dataset.notificationId, child]));
  const cards = rows.map(row => {
    let card = existing.get(row.id);
    const snapshot = JSON.stringify(row);
    if (card && notificationViews.has(card)) {
      if (notificationViews.get(card) !== snapshot) {
        const fresh = render(row);
        card.className = fresh.className;
        // 仅更新展示字段；details、summary 和原文节点保持身份与展开状态。
        card.children[0].replaceChildren(...Array.from(fresh.children[0].children));
        for (const index of [1, 2]) {
          if (card.children[index].textContent !== fresh.children[index].textContent) {
            card.children[index].textContent = fresh.children[index].textContent;
          }
        }
        const original = card.children[3].children[1];
        if (original.textContent !== row.content) original.textContent = row.content;
        notificationViews.set(card, snapshot);
      }
    } else {
      const previous = card;
      card = render(row);
      if (previous) card.children[3].open = previous.querySelector('details')?.open ?? false;
    }
    return card;
  });
  const retained = new Set(cards);
  for (const child of Array.from(container.children)) {
    if (!retained.has(child)) child.remove();
  }
  cards.forEach((card, index) => {
    const current = container.children[index] ?? null;
    if (current !== card) container.insertBefore(card, current);
  });
  if (!cards.length) container.replaceChildren(emptyState(emptyTitle, emptyDescription));
  restoreFocus(container, focus);
}

function taskCard(item, index) {
  const article = node('article', 'task-item');
  const body = node('div', 'task-body');
  body.append(node('h3', '', item.title));
  if (item.course) body.append(node('p', 'task-course', item.course));
  let deadlineText = item.deadlineText ? `截止待确认 · ${item.deadlineText}` : '截止时间待确认';
  let deadlineClass = '';
  if (item.deadline !== null) {
    const deadline = new Date(item.deadline);
    const now = new Date();
    const overdue = deadline.getTime() < now.getTime();
    const today = deadline.toDateString() === now.toDateString();
    deadlineText = `${overdue ? '已逾期 · ' : today ? '今日截止 · ' : '截止 · '}${dateFormat.format(deadline)}`;
    deadlineClass = overdue ? ' overdue' : today ? ' due-today' : '';
  }
  const deadlineLabel = node(item.deadline === null ? 'span' : 'time', `deadline${deadlineClass}`, deadlineText);
  if (item.deadline !== null) deadlineLabel.dateTime = item.deadline;
  body.append(deadlineLabel);
  if (item.content) body.append(node('p', 'task-content', item.content));
  article.append(node('span', 'task-index', String(index + 1).padStart(2, '0')), body);
  return article;
}

function renderList(id, read, render, emptyTitle, emptyDescription) {
  const container = byId(id);
  const editing = container.contains(document.activeElement) && document.activeElement?.closest(editingSelector);
  const focus = captureFocus(container);
  try {
    const rows = read();
    // 只延后可能干扰输入的正文/排序；已保存的已读状态立即同步。
    if (editing) {
      if (id !== 'task-list') {
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const card of container.children) {
          const row = byId.get(card.dataset.notificationId);
          if (!row) continue;
          const meta = card.children[0];
          const badge = Array.from(meta.children).find(child => child.className === 'unread');
          if (row.isRead) badge?.remove();
          else if (!badge) meta.insertBefore(node('span', 'unread', '未读'), meta.children[meta.children.length - 1] ?? null);
          if (notificationViews.has(card)) {
            const shown = JSON.parse(notificationViews.get(card));
            shown.isRead = row.isRead;
            notificationViews.set(card, JSON.stringify(shown));
          }
        }
      }
      return true;
    }
    if (id !== 'task-list') {
      renderNotifications(container, rows, render, emptyTitle, emptyDescription);
      return true;
    }
    const fragment = document.createDocumentFragment();
    if (!rows.length) fragment.append(emptyState(emptyTitle, emptyDescription));
    rows.forEach((row, index) => fragment.append(render(row, index)));
    container.replaceChildren(fragment);
    return true;
  } catch (error) {
    container.replaceChildren(emptyState('读取失败', errorText(error), true));
    restoreFocus(container, focus);
    return false;
  }
}

function renderStats() {
  const fields = { notificationCount: 'notification-count', unreadCount: 'unread-count', pendingTaskCount: 'pending-count' };
  try {
    const stats = getDashboardStats();
    for (const [key, id] of Object.entries(fields)) byId(id).textContent = numberFormat.format(stats[key]);
    byId('stats-error').hidden = true;
    return true;
  } catch (error) {
    for (const id of Object.values(fields)) byId(id).textContent = '—';
    byId('stats-error').textContent = `统计读取失败：${errorText(error)}`;
    byId('stats-error').hidden = false;
    return false;
  }
}

function reload() {
  const today = new Date();
  byId('today-date').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(today);
  byId('today-date').dateTime = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // 分区独立处理读取异常：损坏的通知数据不遮挡仍可正常读取的任务。
  const results = [
    renderStats(),
    renderList('highlight-list', getTodayHighlights, row => notificationCard(row, true), '今天还没有新通知', '新的通知到来后会显示在这里，重要通知优先呈现。'),
    renderList('notification-list', () => getNotifications().sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 6), row => notificationCard(row, false), '还没有收到通知', '已收录的通知会在这里汇总，方便随时回看。'),
    renderList('task-list', getRecentTasks, taskCard, '暂无待办，步调刚刚好', '新的待办任务会按截止时间排列在这里。'),
  ];
  byId('sync-status').textContent = results.every(Boolean)
    ? `已更新于 ${today.toLocaleTimeString('zh-CN', { hour12: false })} · ${unsubscribe ? '数据变化时自动更新' : '可手动刷新'}`
    : '部分数据读取失败 · 可点击“刷新概览”重试';
}

function attach() {
  if (unsubscribe === null) {
    try {
      unsubscribe = subscribe(reload);
      byId('subscription-error').hidden = true;
    } catch (error) {
      byId('subscription-error').textContent = `自动更新暂不可用，请手动刷新。${errorText(error)}`;
      byId('subscription-error').hidden = false;
    }
  }
  reload();
  // 日期跨天及截止状态也应更新；页面恢复可见时立即重读。
  if (timer === null) timer = window.setInterval(() => { if (!document.hidden) reload(); }, 60_000);
}

byId('refresh').addEventListener('click', attach);
window.addEventListener('pagehide', () => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  window.clearInterval(timer);
  timer = null;
});
window.addEventListener('pageshow', attach);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
// 仅注册一次；等待焦点落到新元素后，再补上输入期间延后的刷新。
document.addEventListener('focusout', event => {
  if (event.target.closest(editingSelector)) queueMicrotask(() => { if (!document.hidden) reload(); });
});

function updateNavigation() {
  const current = window.location.hash || '#overview';
  for (const link of document.querySelectorAll('.navigation a')) {
    if (link.getAttribute('href') === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', updateNavigation);
updateNavigation();
attach();
