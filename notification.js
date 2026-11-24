import { getNotifications, addNotification, updateNotification, subscribe } from './js/data.js';

let notifications = [];
let activeCategory = 'all';
let visibleCount = 5;
let loadError = null;
let aiBusy = false;
let pendingSaveData = null;
let pendingNotification = null;

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
    // 每次成功写入已由同步订阅更新，不再次全量渲染。
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
    // subscribe(loadNotifications) 在保存成功后立即执行。
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
  if (aiBusy || pendingSaveData) return;

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
  aiRecognizeButton.disabled = busy || !!pendingSaveData;
  submitMessage.disabled = busy || !!pendingSaveData;
  aiRetrySave.disabled = busy;
  for (const input of [senderInput, sourceInput, contentInput, typeInput, aiTokenInput]) input.disabled = busy || !!pendingSaveData;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65_000);
  try {
    const response = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(`识别失败：AI 服务返回非 JSON 响应（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      const messages = { 401: '队员令牌无效，请检查令牌。', 403: '当前页面来源未获允许，请联系管理员。',
        429: '调用次数已达限制，请稍后重试。', 503: 'AI 服务暂不可用，请稍后重试或联系管理员。', 504: 'AI 服务响应超时，请稍后重试。' };
      throw new Error(`识别失败（HTTP ${response.status}）：${messages[response.status] || 'AI 服务调用失败，请稍后重试。'}`);
    }
    if (payload?.success !== true || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw new Error('识别失败：AI 服务未返回有效识别结果。');
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('识别超时：等待已超过 65 秒，请稍后重试。');
    if (error instanceof TypeError) throw new Error('识别失败：无法连接 AI 服务，请检查网络或来源授权后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function setPendingSave(data) {
  pendingSaveData = data;
  aiRetrySave.hidden = !data;
}

function clearPendingSave() {
  pendingSaveData = null;
  pendingNotification = null;
  aiRetrySave.hidden = true;
}

async function recognizeWithAI() {
  if (aiBusy) return;
  if (pendingSaveData) {
    showFormStatus('尚有未保存的识别草稿，请先重试保存。草稿仅在当前页面，刷新或离开会丢失。', 'error');
    return;
  }
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
  try {
    showFormStatus('AI 识别中…');

    // 阶段一：AI 请求（网络异常 / 后端非成功 / 响应异常）。
    let payload;
    try {
      payload = await requestAiExtraction(token, content);
    } catch (error) {
      showFormStatus(error?.message || '识别失败：无法连接 AI 服务，请稍后重试。', 'error');
      return;
    }

    // 公共接口已支持完整草稿：一次写入通知和 extraction，避免半成功记录。
    // 用户主动识别并查看结果；普通新增仍默认未读。
    pendingNotification = { sender, source, content, type: payload.data.type, isImportant: false, isRead: true };
    setPendingSave(payload.data);
    try {
      await addNotification({
        ...pendingNotification,
        extraction: payload.data,
        extractionStatus: 'pending',
      });
    } catch (error) {
      if (error?.code === 'VALIDATION') {
        clearPendingSave();
        showFormStatus('识别结果字段不合法，未保存通知。请重新识别或手工填写。', 'error');
        return;
      }
      showAiPreview(payload.data);
      showFormStatus(`通知和识别结果未保存：${error?.message || '存储不可用'}。草稿仅保留在当前页面，请恢复存储后重试；刷新或离开会丢失。`, 'error');
      activeCategory = 'all';
      tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.category === 'all'));
      loadNotifications();
      return;
    }

    clearPendingSave();
    showAiPreview(payload.data);
    clearFormKeepToken();
    showFormStatus('识别已保存为待确认，请在近期待办页人工确认并生成任务', 'success');
    activeCategory = 'all';
    tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.category === 'all'));
    loadNotifications();
  } finally {
    setAiBusy(false);
  }
}

async function retrySaveExtraction() {
  if (aiBusy) return;
  if (!pendingSaveData) return;

  setAiBusy(true);
  showFormStatus('正在重试保存识别结果…');
  try {
    const changes = {
      type: pendingSaveData.type,
      extraction: pendingSaveData,
      extractionStatus: 'pending',
    };
    await addNotification({ ...pendingNotification, ...changes });
    clearPendingSave();
    clearFormKeepToken();
    showFormStatus('识别结果已保存为待确认', 'success');
    loadNotifications();
  } catch (error) {
    showFormStatus(`重试保存失败：${error?.message || '存储不可用'}。草稿仍仅在当前页面，刷新或离开会丢失。`, 'error');
  } finally {
    setAiBusy(false);
  }
}

aiRecognizeButton.addEventListener('click', () => void recognizeWithAI());
aiRetrySave.addEventListener('click', () => void retrySaveExtraction());
aiResultClose.addEventListener('click', resetAiPreview);
window.addEventListener('beforeunload', event => {
  if (pendingSaveData || aiBusy) {
    event.preventDefault();
    event.returnValue = '';
  }
});

subscribe(loadNotifications);
loadNotifications();
