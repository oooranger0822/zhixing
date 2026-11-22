import { getNotifications, addNotification, updateNotification, subscribe } from '../js/data.js';

let notifications = [];
let activeCategory = 'all';
let visibleCount = 5;

const list = document.getElementById('notificationList');
const tabs = document.querySelectorAll('.tab');
const markAllButton = document.getElementById('markAllRead');
const loadMoreButton = document.getElementById('loadMore');

const toggleMessageForm = document.getElementById('toggleMessageForm');
const messageForm = document.getElementById('messageForm');
const senderInput = document.getElementById('senderInput');
const contentInput = document.getElementById('contentInput');
const typeInput = document.getElementById('typeInput');
const submitMessage = document.getElementById('submitMessage');
const formStatus = document.getElementById('formStatus');

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
      <div><strong>通知加载失败</strong>${escapeHtml(message)}</div>
    </div>`;
  markAllButton.disabled = true;
  loadMoreButton.disabled = true;
}

function loadNotifications() {
  try {
    notifications = getNotifications();
    renderNotifications();
  } catch (error) {
    notifications = [];
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

  const sender = senderInput.value.trim();
  const content = contentInput.value.trim();
  if (!sender || !content) {
    formStatus.className = 'form-status error';
    formStatus.textContent = '请填写发送人和消息内容';
    return;
  }

  submitMessage.disabled = true;
  formStatus.className = 'form-status';
  formStatus.textContent = '正在提交…';

  try {
    await addNotification({
      sender,
      source: '模拟群消息',
      content,
      type: typeInput.value,
      isImportant: false,
      isRead: false
    });

    messageForm.reset();
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

subscribe(loadNotifications);
loadNotifications();
