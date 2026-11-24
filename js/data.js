/** 知行唯一数据入口。读取同步，写入异步；页面须 await 写入并处理 DataError。 */
export const STORAGE_KEYS = Object.freeze({
  notifications: 'zhixing_notifications',
  tasks: 'zhixing_tasks',
  settings: 'zhixing_settings',
});
const TYPES = ['course', 'assignment', 'exam', 'activity', 'class', 'other'];
const EXTRACTION = ['none', 'pending', 'confirmed'];
const listeners = new Set();

export class DataError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}
function fail(code, message) { throw new DataError(code, message); }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VALIDATION', '数据必须为对象');
}
function string(value, field, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) fail('VALIDATION', `${field} 必须为${required ? '非空' : ''}字符串`);
}
function date(value, field, nullable = false) {
  if (nullable && value === null) return;
  string(value, field, true);
  // 要求带时区的 ISO 时间，避免不同页面对中文时间或无时区字符串解析不同。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('VALIDATION', `${field} 必须为带时区的 ISO 日期时间`);
  }
}
function enumValue(value, choices, field) {
  if (!choices.includes(value)) fail('VALIDATION', `${field} 值无效`);
}
function validateExtraction(value) {
  if (value === null) return;
  const required = ['type', 'course', 'title', 'content', 'deadline', 'deadlineText', 'confidence'];
  fields(value, required);
  if (required.some(field => !Object.hasOwn(value, field))) fail('VALIDATION', 'extraction 必须包含完整识别字段');
  enumValue(value.type, TYPES, 'extraction.type');
  for (const [field, limit] of Object.entries({ course: 200, title: 300, content: 5000, deadlineText: 5000 })) {
    string(value[field], `extraction.${field}`);
    if (value[field].length > limit) fail('VALIDATION', `extraction.${field} 超过长度限制`);
  }
  date(value.deadline, 'extraction.deadline', true);
  if (value.deadline !== null) {
    // Date.parse 会将 2 月 30 日等日期归一化；识别结果不能接受这种无效日期。
    const [year, month, day] = value.deadline.slice(0, 10).split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year === 0 || day > days[month - 1]) fail('VALIDATION', 'extraction.deadline 日期无效');
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    fail('VALIDATION', 'extraction.confidence 必须是 0 到 1 的有限数字');
  }
}
function validate(kind, item) {
  object(item);
  string(item.id, 'id', true);
  if (kind === 'notifications') {
    for (const field of ['sender', 'source', 'content']) string(item[field], field, true);
    string(item.summary, 'summary');
    enumValue(item.type, TYPES, 'type');
    enumValue(item.extractionStatus, EXTRACTION, 'extractionStatus');
    // 兼容旧记录；显式提供 extraction 时必须是 null 或完整合法对象。
    if (Object.hasOwn(item, 'extraction')) validateExtraction(item.extraction);
    date(item.time, 'time');
    for (const field of ['isImportant', 'isRead']) {
      if (typeof item[field] !== 'boolean') fail('VALIDATION', `${field} 必须为布尔值`);
    }
  } else {
    string(item.title, 'title', true);
    for (const field of ['course', 'content', 'deadlineText']) string(item[field], field);
    enumValue(item.status, ['pending', 'completed'], 'status');
    date(item.deadline, 'deadline', true);
    date(item.createdAt, 'createdAt');
    date(item.completedAt, 'completedAt', true);
    if (item.sourceNotificationId !== null) string(item.sourceNotificationId, 'sourceNotificationId', true);
    if ((item.status === 'pending') !== (item.completedAt === null)) fail('VALIDATION', '任务状态与完成时间不一致');
  }
}
function storage() {
  try { return globalThis.localStorage; }
  catch (cause) { throw new DataError('STORAGE_UNAVAILABLE', '无法访问本地存储', cause); }
}
function read(kind) {
  let raw;
  try { raw = storage().getItem(STORAGE_KEYS[kind]); }
  catch (cause) { throw new DataError('STORAGE_UNAVAILABLE', '无法读取本地存储', cause); }
  if (raw === null) return [];
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('数据不是数组');
    const ids = new Set();
    const sources = new Set();
    for (const row of rows) {
      validate(kind, row);
      if (ids.has(row.id)) throw new Error('重复 ID');
      ids.add(row.id);
      if (kind === 'tasks' && row.sourceNotificationId !== null) {
        if (sources.has(row.sourceNotificationId)) throw new Error('重复关联任务');
        sources.add(row.sourceNotificationId);
      }
    }
    return rows;
  } catch (cause) {
    // 不删除、不初始化覆盖损坏键；其他键仍可单独读取。
    throw new DataError('CORRUPT_DATA', `${STORAGE_KEYS[kind]} 数据损坏，原始内容已保留`, cause);
  }
}
function emit(source, keys) {
  for (const callback of [...listeners]) {
    try { callback({ source, keys: [...keys] }); }
    catch (error) { console.error('知行数据订阅回调失败', error); }
  }
}
function write(kind, rows) {
  try { storage().setItem(STORAGE_KEYS[kind], JSON.stringify(rows)); }
  catch (cause) { throw new DataError('STORAGE_WRITE_FAILED', '保存失败，请检查存储权限或空间', cause); }
  emit('local', [STORAGE_KEYS[kind]]);
}
function mutate(action) {
  // 所有标签页共享同一把锁；锁内重新读取，防止丢失更新和重复提取。
  if (!globalThis.navigator?.locks?.request) {
    return Promise.reject(new DataError('LOCK_UNAVAILABLE', '请在支持 Web Locks 的浏览器通过 HTTPS 或 localhost 使用'));
  }
  return navigator.locks.request('zhixing:data:write', action);
}
function id(prefix) { return `${prefix}_${globalThis.crypto.randomUUID()}`; }
function fields(data, allowed) {
  object(data);
  for (const field of Object.keys(data)) {
    if (!allowed.includes(field)) fail('VALIDATION', `不允许设置字段 ${field}`);
  }
}
function notification(data) {
  fields(data, ['sender', 'source', 'content', 'type', 'summary', 'time', 'isImportant', 'isRead', 'extractionStatus', 'extraction']);
  const row = { id: id('notification'), type: 'other', summary: '', time: new Date().toISOString(), isImportant: false, isRead: false, extractionStatus: 'none', extraction: null, ...data };
  validate('notifications', row);
  if (row.extractionStatus === 'confirmed') fail('VALIDATION', 'confirmed 只能由任务生成流程设置');
  return row;
}
function task(data) {
  fields(data, ['title', 'course', 'content', 'deadline', 'deadlineText', 'status', 'sourceNotificationId']);
  const row = { id: id('task'), course: '', content: '', deadline: null, deadlineText: '', status: 'pending', sourceNotificationId: null, ...data, createdAt: new Date().toISOString(), completedAt: null };
  if (row.status === 'completed') row.completedAt = new Date().toISOString();
  validate('tasks', row);
  return row;
}
function find(rows, id) { return rows.find(row => row.id === id) ?? null; }
function requireRow(rows, id) {
  const row = find(rows, id);
  if (!row) fail('NOT_FOUND', `未找到记录 ${id}`);
  return row;
}
function checkSource(rows, sourceId) {
  if (sourceId === null) return;
  const source = requireRow(read('notifications'), sourceId);
  if (source.extractionStatus === 'confirmed' || rows.some(row => row.sourceNotificationId === sourceId)) {
    fail('DUPLICATE_TASK', '此通知已经生成任务');
  }
}

export function getNotifications() { return read('notifications'); }
export function getNotificationById(id) { return find(getNotifications(), id); }
export function getTasks() { return read('tasks'); }
export function getTaskById(id) { return find(getTasks(), id); }

export function addNotification(data) {
  return mutate(() => {
    const rows = getNotifications();
    const row = notification(data);
    write('notifications', [...rows, row]);
    return row;
  });
}
export function addTask(data) {
  // 关联任务统一走提取流程，保证 confirmed 状态和防重复规则一致。
  if (data?.sourceNotificationId != null) {
    const { sourceNotificationId, ...rest } = data;
    return createTaskFromNotification(sourceNotificationId, rest);
  }
  return mutate(() => {
    const rows = getTasks();
    const row = task(data);
    write('tasks', [...rows, row]);
    return row;
  });
}
function update(kind, id, changes) {
  return mutate(() => {
    const rows = read(kind);
    const original = requireRow(rows, id);
    const allowed = kind === 'notifications'
      ? ['sender', 'source', 'type', 'summary', 'time', 'isImportant', 'isRead', 'extractionStatus', 'extraction']
      : ['title', 'course', 'content', 'deadline', 'deadlineText', 'status'];
    // ID、原始通知 content、任务来源及系统时间不可由页面改写。
    fields(changes, allowed);
    // confirmed 只能在关联任务成功保存的流程中设置，普通页面不可直接赋值。
    if (kind === 'notifications' && changes.extractionStatus === 'confirmed') {
      fail('VALIDATION', 'confirmed 只能由任务生成流程设置');
    }
    if (kind === 'notifications' && original.extractionStatus === 'confirmed' && changes.extractionStatus !== undefined && changes.extractionStatus !== 'confirmed') {
      fail('VALIDATION', '已确认的提取状态不可撤销');
    }
    const row = { ...original, ...changes };
    if (kind === 'tasks') {
      row.completedAt = row.status === 'completed' ? (original.completedAt ?? new Date().toISOString()) : null;
    }
    validate(kind, row);
    write(kind, rows.map(item => item.id === id ? row : item));
    return row;
  });
}
export function updateNotification(id, changes) { return update('notifications', id, changes); }
export function updateTask(id, changes) { return update('tasks', id, changes); }
function remove(kind, id) {
  return mutate(() => {
    const rows = read(kind);
    if (!find(rows, id)) return false;
    write(kind, rows.filter(row => row.id !== id));
    return true;
  });
}
export function deleteNotification(id) { return remove('notifications', id); }
export function deleteTask(id) { return remove('tasks', id); }

export function createTaskFromNotification(id, taskData) {
  return mutate(() => {
    const notifications = getNotifications();
    const source = requireRow(notifications, id);
    const tasks = getTasks();
    checkSource(tasks, id);
    fields(taskData, ['title', 'course', 'content', 'deadline', 'deadlineText', 'status']);
    const row = task({ content: source.content, ...taskData, sourceNotificationId: id });
    const next = notifications.map(item => item.id === id ? { ...item, extractionStatus: 'confirmed', isRead: true } : item);
    const store = storage();
    const oldTasks = store.getItem(STORAGE_KEYS.tasks);
    // LocalStorage 无多键事务：失败时回滚任务键，完成两次写入后再通知本页。
    try {
      store.setItem(STORAGE_KEYS.tasks, JSON.stringify([...tasks, row]));
      try { store.setItem(STORAGE_KEYS.notifications, JSON.stringify(next)); }
      catch (cause) {
        try {
          if (oldTasks === null) store.removeItem(STORAGE_KEYS.tasks);
          else store.setItem(STORAGE_KEYS.tasks, oldTasks);
        } catch (rollbackError) {
          emit('local', [STORAGE_KEYS.tasks]);
          throw new DataError('PARTIAL_WRITE', '部分保存成功，回滚失败，请重新读取数据', rollbackError);
        }
        throw cause;
      }
    } catch (cause) {
      if (cause instanceof DataError) throw cause;
      throw new DataError('STORAGE_WRITE_FAILED', '生成任务保存失败', cause);
    }
    emit('local', [STORAGE_KEYS.tasks, STORAGE_KEYS.notifications]);
    return row;
  });
}

export function getDashboardStats() {
  const notifications = getNotifications();
  return {
    notificationCount: notifications.length,
    unreadCount: notifications.filter(row => !row.isRead).length,
    pendingTaskCount: getTasks().filter(row => row.status === 'pending').length,
    // V1 关注口径：未读且重要的通知；已读、普通通知以及任务不重复计入。
    importantCount: notifications.filter(row => row.isImportant && !row.isRead).length,
  };
}
export function getTodayHighlights() {
  // 今日全部通知（不限重要通知），按浏览器本地日期判断；重要优先，其次发布时间倒序。
  const today = new Date().toDateString();
  return getNotifications().filter(row => new Date(row.time).toDateString() === today)
    .sort((a, b) => Number(b.isImportant) - Number(a.isImportant) || Date.parse(b.time) - Date.parse(a.time));
}
export function getRecentTasks() {
  // 最多五条待办：已知截止时间升序（含逾期），未知时间排末尾，同序按创建时间倒序。
  return getTasks().filter(row => row.status === 'pending').sort((a, b) => {
    const left = a.deadline === null ? Infinity : Date.parse(a.deadline);
    const right = b.deadline === null ? Infinity : Date.parse(b.deadline);
    return (left === right ? 0 : left - right) || Date.parse(b.createdAt) - Date.parse(a.createdAt);
  }).slice(0, 5);
}
export function subscribe(callback) {
  if (typeof callback !== 'function') fail('VALIDATION', '订阅者必须为函数');
  listeners.add(callback);
  return () => listeners.delete(callback);
}
globalThis.addEventListener?.('storage', event => {
  // storage 事件只在其他同源标签页触发；当前页由 write/提取流程主动通知。
  if (event.storageArea !== storage()) return;
  const keys = Object.values(STORAGE_KEYS);
  if (event.key === null) emit('external', keys);
  else if (keys.includes(event.key)) emit('external', [event.key]);
});
