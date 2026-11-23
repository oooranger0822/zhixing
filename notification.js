import { getNotifications, addNotification, updateNotification, subscribe } from './js/data.js';

let notifications = [];
let activeCategory = 'all';
let visibleCount = 5;
let loadError = null;
let aiBusy = false;
let pendingSaveId = null;
let pendingSaveData = null;

const list = document.getElementById('notificationList');
const tabs = document.querySelectorAll('.tab');
const markAllButton = document.getElementById('markAllRead');
const loadMoreButton = document.getElementById('loadMore');

const toggleMessageForm = document.getElementById('toggleMessageForm');
const messageForm = document.getElementById('messageForm');
const senderInput = document.getElementById('senderInput');
const contentInput = document.getElementById('contentInput');
const sourceInput = document.getElementById('sourceInput');
const typeInput = document.getElementById('typeInput');
const submitMessage = document.getElementById('submitMessage');
const formStatus = document.getElementById('formStatus');
const aiTokenInput = document.getElementById('aiTokenInput');
const aiRecognizeButton = document.getElementById('aiRecognize');
const aiResult = document.getElementById('aiResult');
const aiResultClose = document.getElementById('aiResultClose');
const aiRetrySave = document.getElementById('aiRetrySave');
const aiPreviewType = document.getElementById('aiPreviewType');
const aiPreviewCourse = document.getElementById('aiPreviewCourse');
const aiPreviewTitle = document.getElementById('aiPreviewTitle');
const aiPreviewContent = document.getElementById('aiPreviewContent');
const aiPreviewDeadline = document.getElementById('aiPreviewDeadline');
const aiPreviewDeadlineText = document.getElementById('aiPreviewDeadlineText');
const aiPreviewConfidence = document.getElementById('aiPreviewConfidence');

const typeNames = {
  course: '课程',
  assignment: '作业',
  exam: '考试',
  activity: '活动',
  class: '班级',
  other: '其他'
};

const typeIcons = {
  course: '课',
  assignment: '作',
  exam: '考',
  activity: '动',
  class: '班',
  other: '讯'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return escapeHtml(value);

  const now = new Date();
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffSeconds < 60) return '刚刚';

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}小时前`;

  const pad = number => String(number).padStart(2, '0');
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${clock}`;
  }

  return `${date.getFullYear()}-${monthDay} ${clock}`;
}

function getFilteredNotifications() {
  return activeCategory === 'all'
    ? notifications
    : notifications.filter(item => item.type === activeCategory);
}

function updateCounts() {
  document.getElementById('allCount').textContent = notifications.length;

  Object.keys(typeNames).forEach(category => {
    const count = notifications.filter(item => item.type === category).length;
    document.getElementById(`${category}Count`).textContent = count;
  });

  const unreadCount = notifications.filter(item => !item.isRead).length;
  markAllButton.disabled = unreadCount === 0;
  markAllButton.style.opacity = unreadCount === 0 ? '.55' : '1';
}

function renderNotifications() {
  if (loadError) {
    showError(loadError);
    return;
  }
  const filtered = getFilteredNotifications();
  const visible = filtered.slice(0, visibleCount);

  if (visible.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div><strong>暂无通知</strong>当前分类下没有新的消息</div>
      </div>`;
  } else {
    list.innerHTML = visible.map(item => {
      const type = typeNames[item.type] ? item.type : 'other';
      const title = escapeHtml(item.sender);
      const description = escapeHtml(item.content);

      return `
        <article class="notification-item ${item.isRead ? '' : 'unread'}" data-id="${escapeHtml(item.id)}">
          <div class="notice-icon" aria-hidden="true">${typeIcons[type]}</div>
          <div class="notice-content">
            <div class="notice-title-row">
              <h2 class="notice-title">${title}</h2>
              ${item.isRead ? '' : '<span class="unread-dot" title="未读"></span>'}
            </div>
            <p class="notice-description">${description}</p>
            <div class="notice-meta">
              <span class="notice-tag">${escapeHtml(typeNames[type])}</span>
              ${item.isImportant ? '<span class="notice-tag">重要</span>' : ''}
              <time class="notice-time">${formatTime(item.time)}</time>
            </div>
          </div>
          <button class="notice-action" type="button" data-id="${escapeHtml(item.id)}" title="标记为已读" aria-label="标记 ${title} 的通知为已读" ${item.isRead ? 'disabled' : ''}>✓</button>
        </article>`;
    }).join('');
  }

  loadMoreButton.disabled = visibleCount >= filtered.length;
  loadMoreButton.textContent = visibleCount >= filtered.length ? '已显示全部通知' : '加载更多通知';
  updateCounts();
}

function showError(error) {
  const message = error?.message || '无法读取通知数据，请稍后重试';
  list.innerHTML = `
    <div class="empty-state">
      <div><strong>通知加载失败</strong>${escapeHtml(message)}<br><button type="button" class="load-more" data-action="retry">重新加载</button></div>
    </div>`;
  markAllButton.disabled = true;
  loadMoreButton.disabled = true;
}

function loadNotifications() {
  try {
    notifications = getNotifications();
    loadError = null;
    renderNotifications();
  } catch (error) {
    notifications = [];
    loadError = error;
    document.getElementById('allCount').textContent = '—';
    Object.keys(typeNames).forEach(category => {
      document.getElementById(`${category}Count`).textContent = '—';
    });
    showError(error);
  }
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    activeCategory = tab.dataset.category;
    visibleCount = 5;
    renderNotifications();
  });
});

markAllButton.addEventListener('click', async () => {
  const unreadNotifications = notifications.filter(item => !item.isRead);
  if (unreadNotifications.length === 0) return;

  markAllButton.disabled = true;
  try {
    for (const item of unreadNotifications) {
      await updateNotification(item.id, { isRead: true });
    }
    loadNotifications();
  } catch (error) {
    loadNotifications();
    showError(error);
  }
});

list.addEventListener('click', async event => {
  if (event.target.closest('[data-action="retry"]')) {
    loadNotifications();
    return;
  }
  const action = event.target.closest('.notice-action');
  if (!action || action.disabled) return;

  try {
    await updateNotification(action.dataset.id, { isRead: true });
    loadNotifications();
  } catch (error) {
    showError(error);
  }
});

loadMoreButton.addEventListener('click', () => {
  visibleCount += 5;
  renderNotifications();
});

toggleMessageForm.addEventListener('click', () => {
  const willOpen = messageForm.hidden;
  messageForm.hidden = !willOpen;
  toggleMessageForm.setAttribute('aria-expanded', String(willOpen));
  toggleMessageForm.querySelector('span').textContent = willOpen ? '−' : '＋';
  if (willOpen) senderInput.focus();
});

messageForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (aiBusy) return;

  const sender = senderInput.value.trim();
  const source = sourceInput.value.trim();
  const content = contentInput.value.trim();
  if (!sender || !source || !content) {
    formStatus.className = 'form-status error';
    formStatus.textContent = '请填写发送人、消息来源和消息内容';
    return;
  }

  submitMessage.disabled = true;
  formStatus.className = 'form-status';
  formStatus.textContent = '正在提交…';

  try {
    await addNotification({
      sender,
      source,
      content,
      type: typeInput.value,
      isImportant: false,
      isRead: false
    });

    clearFormKeepToken();
    resetAiPreview();
    formStatus.className = 'form-status success';
    formStatus.textContent = '消息已提交';
    activeCategory = 'all';
    tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.category === 'all'));
    loadNotifications();
  } catch (error) {
    formStatus.className = 'form-status error';
    formStatus.textContent = `提交失败：${error?.message || '未知错误'}`;
  } finally {
    submitMessage.disabled = false;
  }
});

// ---------- AI 识别 ----------
const AI_ENDPOINT = 'https://zhixing-ai.vercel.app/api/extract';

function showFormStatus(message, kind = '') {
  formStatus.className = `form-status${kind ? ` ${kind}` : ''}`;
  formStatus.textContent = message;
}

function setAiBusy(busy) {
  aiBusy = busy;
  aiRecognizeButton.disabled = busy;
  submitMessage.disabled = busy;
  aiRetrySave.disabled = busy;
  aiRecognizeButton.textContent = busy ? '识别中…' : 'AI 识别';
}

function formatPreviewDeadline(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function resetAiPreview() {
  aiResult.hidden = true;
  aiPreviewType.textContent = '';
  aiPreviewCourse.textContent = '';
  aiPreviewTitle.textContent = '';
  aiPreviewContent.textContent = '';
  aiPreviewDeadline.textContent = '';
  aiPreviewDeadlineText.textContent = '';
  aiPreviewConfidence.textContent = '';
}

function showAiPreview(data) {
  aiPreviewType.textContent = typeNames[data.type] || '其他';
  aiPreviewCourse.textContent = data.course || '—';
  aiPreviewTitle.textContent = data.title || '—';
  aiPreviewContent.textContent = data.content || '—';
  aiPreviewDeadline.textContent = formatPreviewDeadline(data.deadline);
  aiPreviewDeadlineText.textContent = data.deadlineText || '—';
  aiPreviewConfidence.textContent = typeof data.confidence === 'number' ? `${Math.round(data.confidence * 100)}%` : '—';
  aiResult.hidden = false;
}

function clearFormKeepToken() {
  const token = aiTokenInput.value;
  messageForm.reset();
  aiTokenInput.value = token;
}

async function requestAiExtraction(token, content) {
  let response;
  try {
    response = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ content }),
    });
  } catch {
    throw new Error('识别失败：无法连接 AI 服务，请检查网络后重试。');
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* 非 JSON 响应 */ }
  if (!payload) throw new Error('识别失败：AI 服务返回异常，请稍后重试。');
  return payload;
}

function setPendingSave(id, data) {
  pendingSaveId = id;
  pendingSaveData = data;
  aiRetrySave.hidden = !id;
}

function clearPendingSave() {
  pendingSaveId = null;
  pendingSaveData = null;
  aiRetrySave.hidden = true;
}

async function recognizeWithAI() {
  if (aiBusy) return;
  const sender = senderInput.value.trim();
  const source = sourceInput.value.trim();
  const content = contentInput.value.trim();
  if (!sender || !source || !content) {
    showFormStatus('请填写发送人、消息来源和消息内容', 'error');
    return;
  }
  const token = aiTokenInput.value.trim();
  if (!token) {
    showFormStatus('请先填写 AI 令牌', 'error');
    return;
  }

  setAiBusy(true);
  showFormStatus('AI 识别中…');

  // 阶段一：AI 请求（网络异常 / 后端非成功 / 响应异常）。
  let payload;
  try {
    payload = await requestAiExtraction(token, content);
  } catch (error) {
    showFormStatus(error?.message || '识别失败：无法连接 AI 服务，请稍后重试。', 'error');
    setAiBusy(false);
    return;
  }
  if (payload.success !== true) {
    const message = payload?.error?.message || 'AI 服务返回异常，请稍后重试';
    showFormStatus(`识别失败：${message}`, 'error');
    setAiBusy(false);
    return;
  }

  // 阶段二：创建通知（取得 id）。
  let created;
  try {
    created = await addNotification({
      sender,
      source,
      content,
      type: payload.data.type,
      isImportant: false,
      isRead: false,
    });
  } catch (error) {
    showFormStatus(`通知创建失败：${error?.message || '未知错误'}`, 'error');
    setAiBusy(false);
    return;
  }

  // 阶段三：一次 updateNotification 保存 type + 完整 extraction + pending。
  try {
    await updateNotification(created.id, {
      type: payload.data.type,
      extraction: payload.data,
      extractionStatus: 'pending',
    });
  } catch (error) {
    // 消息已创建，仅识别结果未保存：保留 id 与识别结果，供「重试保存」。
    setPendingSave(created.id, payload.data);
    showAiPreview(payload.data);
    clearFormKeepToken();
    showFormStatus('消息已创建，但 AI 识别结果未保存，请重试。', 'error');
    activeCategory = 'all';
    tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.category === 'all'));
    loadNotifications();
    setAiBusy(false);
    return;
  }

  clearPendingSave();
  showAiPreview(payload.data);
  clearFormKeepToken();
  showFormStatus('识别已保存为待确认，请在近期待办页人工确认并生成任务', 'success');
  activeCategory = 'all';
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.category === 'all'));
  loadNotifications();
  setAiBusy(false);
}

async function retrySaveExtraction() {
  if (aiBusy) return;
  if (!pendingSaveId || !pendingSaveData) return;

  setAiBusy(true);
  showFormStatus('正在重试保存识别结果…');
  try {
    // 重试必须沿用原来的 notificationId，不再次 addNotification。
    await updateNotification(pendingSaveId, {
      type: pendingSaveData.type,
      extraction: pendingSaveData,
      extractionStatus: 'pending',
    });
    clearPendingSave();
    showFormStatus('识别结果已保存为待确认', 'success');
    loadNotifications();
  } catch (error) {
    showFormStatus(`重试保存失败：${error?.message || '未知错误'}，请重试。`, 'error');
  } finally {
    setAiBusy(false);
  }
}

aiRecognizeButton.addEventListener('click', () => void recognizeWithAI());
aiRetrySave.addEventListener('click', () => void retrySaveExtraction());
aiResultClose.addEventListener('click', resetAiPreview);

subscribe(loadNotifications);
loadNotifications();
