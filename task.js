import {
  getTasks,
  getNotifications,
  getNotificationById,
  updateTask,
  createTaskFromNotification,
  subscribe,
  DataError,
} from './js/data.js';

const typeNames = { course: '课程', assignment: '作业', exam: '考试', activity: '活动', class: '班级', other: '其他' };

const listEl = document.getElementById('taskList');
const detailColumnEl = document.getElementById('detailColumn');
const detailEl = document.getElementById('taskDetail');
const statusBannerEl = document.getElementById('statusBanner');
const extractEntryEl = document.getElementById('extractEntry');
const tabs = document.querySelectorAll('.tab');
const countEls = {
  all: document.getElementById('allCount'),
  pending: document.getElementById('pendingCount'),
  completed: document.getElementById('completedCount'),
};

const extractModalEl = document.getElementById('extractModal');
const extractCloseEl = document.getElementById('extractClose');
const extractCancelEl = document.getElementById('extractCancel');
const extractSubmitEl = document.getElementById('extractSubmit');
const extractStatusEl = document.getElementById('extractStatus');
const extractFormEl = document.getElementById('extractForm');
const extractNotificationListEl = document.getElementById('extractNotificationList');
const loadMockAiEl = document.getElementById('loadMockAi');
const taskTitleInput = document.getElementById('taskTitleInput');
const taskCourseInput = document.getElementById('taskCourseInput');
const taskContentInput = document.getElementById('taskContentInput');
const taskDeadlineInput = document.getElementById('taskDeadlineInput');
const taskDeadlineTextInput = document.getElementById('taskDeadlineTextInput');

const extractState = {
  notifications: [],
  selectedId: null,
  submitting: false,
};

// 页面状态
const state = {
  tasks: [],           // 最近一次成功读取的任务数组
  tasksLoaded: false,  // 任务读取是否成功
  notifications: null, // Map<id, 通知>；读取失败时为 null，重要程度不展示
  activeFilter: 'all',
  selectedId: null,
  saving: false,
  stop: null,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDateTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return escapeHtml(value);
  const pad = n => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

// 截止时间文案与提醒状态（none / due / overdue）
function deadlineInfo(task) {
  if (!task.deadline) {
    return {
      text: task.deadlineText ? `截止：${task.deadlineText}` : '截止时间待定',
      state: 'none',
    };
  }
  const t = Date.parse(task.deadline);
  if (!Number.isFinite(t)) return { text: '时间格式异常', state: 'none' };
  const fmt = formatDateTime(task.deadline);
  if (task.status !== 'completed') {
    const now = Date.now();
    if (t < now) return { text: `已逾期 · ${fmt}`, state: 'overdue' };
    if (t - now < 24 * 60 * 60 * 1000) return { text: `即将截止 · ${fmt}`, state: 'due' };
  }
  return { text: `截止 ${fmt}`, state: 'none' };
}

// 重要程度：仅当任务有来源通知，且来源通知 isImportant 为真时派生展示
function isImportant(task) {
  if (task.sourceNotificationId == null || !state.notifications) return false;
  const source = state.notifications.get(task.sourceNotificationId);
  return source ? source.isImportant === true : false;
}

function filteredTasks() {
  if (state.activeFilter === 'all') return state.tasks;
  return state.tasks.filter(task => task.status === state.activeFilter);
}

function sortTasks(list) {
  return [...list].sort((a, b) => {
    const aDone = a.status === 'completed' ? 1 : 0;
    const bDone = b.status === 'completed' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const aD = a.deadline ? Date.parse(a.deadline) : Infinity;
    const bD = b.deadline ? Date.parse(b.deadline) : Infinity;
    return (aD - bD) || (Date.parse(b.createdAt) - Date.parse(a.createdAt));
  });
}

function updateCounts() {
  countEls.all.textContent = state.tasks.length;
  countEls.pending.textContent = state.tasks.filter(t => t.status === 'pending').length;
  countEls.completed.textContent = state.tasks.filter(t => t.status === 'completed').length;
}

function renderCard(task) {
  const important = isImportant(task);
  const info = deadlineInfo(task);
  const course = task.course ? `<span class="course-tag">${escapeHtml(task.course)}</span>` : '';
  const importantTag = important ? '<span class="important-tag">重要</span>' : '';
  const tags = course || importantTag
    ? `<div class="task-tags">${course}${importantTag}</div>`
    : '<div class="task-tags"></div>';
  const statusText = task.status === 'completed' ? '已完成' : '待完成';
  const toggleLabel = task.status === 'completed' ? '撤销完成' : '标记完成';

  return `
    <article class="task-card ${task.status} ${task.id === state.selectedId ? 'selected' : ''}"
      data-id="${escapeHtml(task.id)}" tabindex="0" role="button"
      aria-label="${escapeHtml(task.title)}">
      <div class="task-top">
        ${tags}
        <span class="status-badge ${task.status}">${statusText}</span>
      </div>
      <h2 class="task-title">${escapeHtml(task.title)}</h2>
      ${task.content ? `<p class="task-content">${escapeHtml(task.content)}</p>` : ''}
      <div class="task-bottom">
        <time class="task-deadline ${info.state}">${escapeHtml(info.text)}</time>
        <button class="toggle-btn ${task.status}" type="button" data-id="${escapeHtml(task.id)}"
          aria-label="${toggleLabel}">${task.status === 'completed' ? '✓ 已完成' : '✓ 完成'}</button>
      </div>
    </article>`;
}

function renderList() {
  if (!state.tasksLoaded) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div><strong>任务加载失败</strong>${escapeHtml(state.readError?.message || '无法读取任务数据')}</div>
      </div>`;
    return;
  }

  const rows = sortTasks(filteredTasks());
  if (rows.length === 0) {
    const hint = state.activeFilter === 'all'
      ? '暂无任务'
      : state.activeFilter === 'pending' ? '没有待完成的任务' : '还没有已完成的任务';
    listEl.innerHTML = `
      <div class="empty-state">
        <div><strong>${hint}</strong>${state.activeFilter === 'all' ? '任务会显示在这里' : ''}</div>
      </div>`;
    return;
  }

  listEl.innerHTML = rows.map(renderCard).join('');
}

function renderDetail() {
  if (!state.selectedId) {
    detailEl.innerHTML = `
      <div class="detail-placeholder">
        <div>
          <div class="placeholder-icon" aria-hidden="true">📋</div>
          <strong>未选择任务</strong>点击左侧任务卡片查看详情
        </div>
      </div>`;
    detailColumnEl.classList.remove('open');
    return;
  }

  const task = state.tasks.find(t => t.id === state.selectedId);
  if (!task) {
    state.selectedId = null;
    renderDetail();
    return;
  }

  const info = deadlineInfo(task);
  const statusText = task.status === 'completed' ? '已完成' : '待完成';
  const important = isImportant(task);
  const source = task.sourceNotificationId != null && state.notifications
    ? state.notifications.get(task.sourceNotificationId)
    : null;
  const sourceLine = source
    ? `<div class="source-link">来源于通知：${escapeHtml(source.sender)} — ${escapeHtml(source.summary || source.content)}</div>`
    : '';

  detailEl.innerHTML = `
    <div class="detail-header">
      <button class="detail-close" type="button" data-action="close" aria-label="关闭详情">×</button>
    </div>
    <h2 class="detail-title">${escapeHtml(task.title)}</h2>
    <div class="detail-meta">
      <span class="status-badge ${task.status}">${statusText}</span>
      ${important ? '<span class="important-tag">重要</span>' : ''}
    </div>
    <div class="detail-body">
      ${task.course ? `
        <div class="detail-field">
          <span class="detail-field-label">课程</span>
          <span class="detail-field-value">${escapeHtml(task.course)}</span>
        </div>` : ''}
      ${task.content ? `
        <div class="detail-field">
          <span class="detail-field-label">内容</span>
          <span class="detail-field-value">${escapeHtml(task.content)}</span>
        </div>` : ''}
      <div class="detail-field">
        <span class="detail-field-label">截止时间</span>
        <span class="detail-field-value ${info.state}">${escapeHtml(info.text)}</span>
        ${task.deadlineText && task.deadline ? `<span class="detail-field-value">${escapeHtml(task.deadlineText)}</span>` : ''}
      </div>
      <div class="detail-field">
        <span class="detail-field-label">创建时间</span>
        <span class="detail-field-value">${formatDateTime(task.createdAt)}</span>
      </div>
      ${sourceLine}
    </div>`;

  detailColumnEl.classList.add('open');
}

function render() {
  updateCounts();
  renderList();
  renderDetail();
}

// ---------- 写入 ----------
function setSaving(saving) {
  state.saving = saving;
  document.querySelectorAll('.toggle-btn').forEach(btn => { btn.disabled = saving; });
}

function showBanner(message, kind) {
  statusBannerEl.hidden = false;
  statusBannerEl.className = `status-banner ${kind || ''}`;
  statusBannerEl.textContent = message;
}

function hideBanner() {
  statusBannerEl.hidden = true;
  statusBannerEl.textContent = '';
}

async function toggleTask(id) {
  if (state.saving) return;
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const next = task.status === 'pending' ? 'completed' : 'pending';

  setSaving(true);
  try {
    await updateTask(id, { status: next });
    hideBanner();
  } catch (error) {
    showBanner(error instanceof DataError ? `${error.code}：${error.message}` : '操作失败，请重试', 'error');
    console.error(error);
  } finally {
    setSaving(false);
    // 写入可能部分成功，一律重新读取；不自动重试。
    load();
  }
}

// ---------- 读取 ----------
function load() {
  // 任务为主数据，读取失败则进入错误态并禁用交互。
  try {
    state.tasks = getTasks();
    state.tasksLoaded = true;
    state.readError = null;
  } catch (error) {
    state.tasks = [];
    state.tasksLoaded = false;
    state.readError = error;
    state.selectedId = null;
  }

  // 通知仅用于「重要程度」派生与来源展示，读取失败不阻塞任务展示。
  try {
    const rows = getNotifications();
    state.notifications = new Map(rows.map(n => [n.id, n]));
  } catch (error) {
    state.notifications = null;
  }

  setTabsEnabled(state.tasksLoaded);
  render();
}

function setTabsEnabled(enabled) {
  tabs.forEach(tab => { tab.disabled = !enabled; });
}

// ---------- 事件绑定 ----------
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    state.activeFilter = tab.dataset.filter;
    renderList();
  });
});

listEl.addEventListener('click', event => {
  const toggle = event.target.closest('.toggle-btn');
  if (toggle && !toggle.disabled) {
    event.stopPropagation();
    void toggleTask(toggle.dataset.id);
    return;
  }
  const card = event.target.closest('.task-card');
  if (card) selectTask(card.dataset.id);
});

listEl.addEventListener('keydown', event => {
  const card = event.target.closest('.task-card');
  // 只处理卡片本身的键盘激活，内部按钮保留浏览器原生 Enter / 空格行为。
  if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    selectTask(card.dataset.id);
  }
});

detailEl.addEventListener('click', event => {
  if (event.target.closest('[data-action="close"]')) deselectTask();
});

function selectTask(id) {
  state.selectedId = id;
  renderDetail();
}

function deselectTask() {
  state.selectedId = null;
  renderDetail();
  renderList(); // 清除卡片 selected 高亮
}

// ---------- 生命周期 ----------
function attach() {
  if (state.stop === null) state.stop = subscribe(() => load());
  load();
}

window.addEventListener('pagehide', () => {
  if (state.stop !== null) {
    state.stop();
    state.stop = null;
  }
});
window.addEventListener('pageshow', attach);

// ---------- 从通知生成任务 ----------
function suggestedTitle(notification) {
  const summary = (notification.summary || '').trim();
  if (summary) return summary;
  const content = (notification.content || '').trim();
  if (content) return content.length > 24 ? `${content.slice(0, 24)}…` : content;
  return `${notification.sender} 的通知`;
}

function renderNotificationPicker() {
  if (extractState.notifications.length === 0) {
    extractNotificationListEl.innerHTML = '<div class="picker-empty">暂无通知</div>';
    return;
  }
  const selectable = extractState.notifications.filter(n => n.extractionStatus !== 'confirmed');
  const items = extractState.notifications.map(n => {
    const confirmed = n.extractionStatus === 'confirmed';
    const selected = n.id === extractState.selectedId;
    const status = confirmed
      ? '<span class="notice-status">已生成任务</span>'
      : selected ? '<span class="notice-status">已选择</span>' : '';
    return `
      <button type="button" class="notice-option ${confirmed ? 'confirmed' : ''} ${selected ? 'selected' : ''}"
        data-id="${escapeHtml(n.id)}" ${confirmed ? 'disabled' : ''}>
        <span class="notice-option-main">
          <span class="notice-sender">${escapeHtml(n.sender)}</span>
          <span class="notice-content">${escapeHtml(n.content)}</span>
          <span class="notice-meta">${escapeHtml(typeNames[n.type] || '其他')} · ${escapeHtml(formatDateTime(n.time))}</span>
        </span>
        ${status}
      </button>`;
  }).join('');
  extractNotificationListEl.innerHTML = items + (selectable.length === 0 ? '<div class="picker-empty">所有通知均已生成任务</div>' : '');
}

function refreshExtractSubmit() {
  extractSubmitEl.disabled = extractState.submitting || !extractState.selectedId;
  extractSubmitEl.textContent = extractState.submitting ? '生成中…' : '生成任务';
}

function showExtractError(message) {
  extractStatusEl.hidden = false;
  extractStatusEl.textContent = message;
}

function hideExtractError() {
  extractStatusEl.hidden = true;
  extractStatusEl.textContent = '';
}

function resetExtractForm() {
  extractFormEl.reset();
  extractState.selectedId = null;
  hideExtractError();
  refreshExtractSubmit();
}

function openExtractModal() {
  extractState.submitting = false;
  resetExtractForm();
  let rows;
  try {
    rows = getNotifications();
  } catch (error) {
    extractState.notifications = [];
    renderNotificationPicker();
    showExtractError(error instanceof DataError ? `${error.code}：${error.message}` : '读取通知失败');
    extractModalEl.hidden = false;
    document.body.classList.add('modal-open');
    return;
  }
  extractState.notifications = rows;
  renderNotificationPicker();
  extractModalEl.hidden = false;
  document.body.classList.add('modal-open');
}

function closeExtractModal() {
  extractModalEl.hidden = true;
  document.body.classList.remove('modal-open');
}

function selectNotification(id) {
  const notification = extractState.notifications.find(n => n.id === id);
  if (!notification) return;
  extractState.selectedId = id;
  taskTitleInput.value = suggestedTitle(notification);
  taskContentInput.value = notification.content || '';
  taskCourseInput.value = '';
  taskDeadlineInput.value = '';
  taskDeadlineTextInput.value = '';
  hideExtractError();
  renderNotificationPicker();
  refreshExtractSubmit();
}

function buildDeadline() {
  const raw = taskDeadlineInput.value;
  const text = taskDeadlineTextInput.value.trim();
  if (!raw) return { deadline: null, deadlineText: text };
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return { deadline: null, deadlineText: text };
  return { deadline: d.toISOString(), deadlineText: text };
}

// ---------- 模拟 AI 识别结果接入（C 模块开发测试） ----------
// 归一化的 AI 识别结果接收入口。未来 B 模块真实结果同样走本函数，仅替换数据来源。
async function loadAiExtraction() {
  // 开发阶段：返回模拟 JSON 中的识别结果（不含 notificationId）。
  const { MOCK_AI_RESULT } = await import('./mock-ai.js');
  return MOCK_AI_RESULT;
}

// ISO 时间字符串 → datetime-local 输入框所需格式（YYYY-MM-DDTHH:mm，浏览器本地时间）。
function toLocalInputValue(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 接收 AI 识别结果并映射到任务确认表单；notificationId 必须对应真实存在的通知。
async function receiveExtraction(payload) {
  const { notificationId, extractionResult } = payload ?? {};
  if (!notificationId || !extractionResult || typeof extractionResult !== 'object' || Array.isArray(extractionResult)) {
    throw new Error('AI 识别数据缺少 notificationId 或 extractionResult');
  }
  if (!extractionResult.title || !String(extractionResult.title).trim()) {
    throw new Error('AI 识别数据缺少任务标题（extractionResult.title）');
  }

  // 校验原通知真实存在；不存在则拒绝预填，避免生成孤立任务。
  const source = getNotificationById(notificationId);
  if (!source) {
    throw new Error(`识别结果对应的通知不存在：${notificationId}`);
  }
  // 已生成任务的通知不可重复接收。
  if (source.extractionStatus === 'confirmed') {
    throw new Error('该通知已生成任务，不能再次接收识别结果');
  }

  // 字段映射 → 预填表单（用户仍可修改）。
  taskTitleInput.value = String(extractionResult.title).trim();
  taskCourseInput.value = extractionResult.course ? String(extractionResult.course) : '';
  taskContentInput.value = extractionResult.content ? String(extractionResult.content) : '';
  taskDeadlineInput.value = toLocalInputValue(extractionResult.deadline);
  taskDeadlineTextInput.value = extractionResult.deadlineText ? String(extractionResult.deadlineText) : '';

  extractState.selectedId = notificationId;
  hideExtractError();
  renderNotificationPicker();
  refreshExtractSubmit();
}

// 「加载模拟AI识别结果」按钮处理：使用当前已选择通知的真实 ID 作为来源。
async function handleLoadMockAi() {
  if (!extractState.selectedId) {
    showExtractError('请先选择来源通知，再加载模拟AI识别结果');
    return;
  }
  hideExtractError();
  try {
    const extractionResult = await loadAiExtraction();
    await receiveExtraction({
      notificationId: extractState.selectedId,
      extractionStatus: 'pending',
      extractionResult,
    });
  } catch (error) {
    showExtractError(error?.message || '加载模拟AI识别结果失败');
    console.error(error);
  }
}

// 生成失败（并发重复、来源失效等）后重新读取通知，同步「已生成任务」状态。
function refreshExtractNotifications() {
  let rows;
  try {
    rows = getNotifications();
  } catch (error) {
    // 读取失败保留原列表，不覆盖调用方已展示的错误提示。
    return;
  }
  extractState.notifications = rows;
  const selected = rows.find(n => n.id === extractState.selectedId);
  if (!selected || selected.extractionStatus === 'confirmed') {
    extractState.selectedId = null;
  }
  renderNotificationPicker();
}

async function submitExtract() {
  if (extractState.submitting) return;
  const sourceId = extractState.selectedId;
  if (!sourceId) {
    showExtractError('请先选择来源通知');
    return;
  }
  const title = taskTitleInput.value.trim();
  if (!title) {
    showExtractError('请填写任务标题');
    return;
  }
  const { deadline, deadlineText } = buildDeadline();

  extractState.submitting = true;
  refreshExtractSubmit();
  hideExtractError();
  try {
    const task = await createTaskFromNotification(sourceId, {
      title,
      course: taskCourseInput.value.trim(),
      content: taskContentInput.value.trim(),
      deadline,
      deadlineText,
    });
    closeExtractModal();
    hideBanner();
    showBanner(`已生成任务「${task.title}」`, 'success');
  } catch (error) {
    showExtractError(error instanceof DataError ? `${error.code}：${error.message}` : '生成失败，请重试');
    console.error(error);
    refreshExtractNotifications();
  } finally {
    extractState.submitting = false;
    refreshExtractSubmit();
    load(); // 写入可能部分成功，一律重新读取
  }
}

extractEntryEl.addEventListener('click', openExtractModal);
extractCloseEl.addEventListener('click', closeExtractModal);
extractCancelEl.addEventListener('click', closeExtractModal);
extractSubmitEl.addEventListener('click', () => void submitExtract());
extractFormEl.addEventListener('submit', event => {
  event.preventDefault();
  void submitExtract();
});
extractNotificationListEl.addEventListener('click', event => {
  const option = event.target.closest('.notice-option');
  if (!option || option.disabled) return;
  selectNotification(option.dataset.id);
});
loadMockAiEl.addEventListener('click', () => void handleLoadMockAi());
extractModalEl.addEventListener('click', event => {
  if (event.target === extractModalEl) closeExtractModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !extractModalEl.hidden) closeExtractModal();
});

attach();
