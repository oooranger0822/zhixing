# 知行公共数据接口 V1.0

页面只导入 `js/data.js`，不得自行调用 LocalStorage。无需第三方依赖。通过 HTTPS 或 localhost 加载原生 ES Modules；写入需要 Web Locks 和 crypto.randomUUID。所有标签页应使用本模块，共享写锁。

## 调用约定

- `getNotifications()` / `getTasks()`：同步返回完整数组，新解析的对象可安全用于展示。
- `getNotificationById(id)` / `getTaskById(id)`：同步返回对象，不存在返回 `null`。
- `addNotification(data)` / `addTask(data)`：Promise，返回新增对象。
- `updateNotification(id, changes)` / `updateTask(id, changes)`：Promise，返回更新对象；不存在抛出 `NOT_FOUND`。
- `deleteNotification(id)` / `deleteTask(id)`：Promise，成功删除返回 `true`，记录不存在返回 `false`（不触发更新事件）。删除通知保留关联任务及其来源 ID。删除任务后，来源通知仍保持 `confirmed`，V1 暂不支持重新生成任务。
- `createTaskFromNotification(id, taskData)`：Promise，返回新任务并将通知提取状态设为 `confirmed`。自动填入来源 ID，默认复制原文至任务内容；taskData 可覆盖任务内容，不会修改通知原文。已有任务或已 confirmed 的通知拒绝重复生成。来源不存在抛出 `NOT_FOUND`。
- `subscribe(callback)`：返回退订函数。回调参数为 `{ source: 'local' | 'external', keys: string[] }`，接到事件后重新读取数据。一个回调失败不阻断其他回调。

通知必填 `sender`、`source`、`content`（非空字符串）；可选 `type` 默认 `other`，`summary` 默认空串，`time` 默认当前时间，`isImportant` / `isRead` 默认 false，`extractionStatus` 默认 `none`。

`confirmed` 只能由 `createTaskFromNotification` 在任务成功生成后设置（带来源的 `addTask` 也会进入此流程）。`addNotification` 仅允许以 `none` 或 `pending` 初始化；`updateNotification` 不允许直接传入 `extractionStatus: 'confirmed'`，即使原状态已经是 confirmed 也会抛出 `VALIDATION`。尚未确认的通知仍允许在 none / pending 之间切换；已确认通知可正常编辑其他允许字段，但不能撤销提取状态。

任务必填 `title`；`course`、`content`、`deadlineText` 默认空串，`deadline` 和 `sourceNotificationId` 默认 null，`status` 默认 `pending`。`id`、`createdAt`、`completedAt` 由模块生成。

### addTask 的来源处理

省略 `sourceNotificationId` 或传入 `null` 时创建独立任务。当该字段提供非 null 的来源 ID 时，`addTask` 会将剩余参数交给 `createTaskFromNotification`，在同一共享写锁内执行完整提取流程：检查来源通知存在、检查关联任务及 confirmed 状态以防重复、校验并创建任务、保存任务后更新来源通知为 confirmed，再发送更新事件。保存失败执行下文规定的回滚处理。两种入口共享业务约束，页面不得通过 addTask 绕过检查或自行修改 confirmed。

调用方只能传字符串来源 ID 或 null，也可以省略该字段；不要显式传入 undefined。当前实现的 `!= null` 分支会略过 undefined，但显式传入的 undefined 随后会被任务字段校验拒绝，并不会按省略字段处理。

枚举：通知类型 `course | assignment | exam | activity | class | other`，提取状态 `none | pending | confirmed`，任务状态 `pending | completed`。时间使用带时区的 ISO 字符串，例如 `2026-11-23T18:00:00+08:00`。未确认截止时间使用 null，口语描述放在 deadlineText。

更新不允许修改任何记录的 id、通知原始 content、任务 sourceNotificationId / createdAt / completedAt；未知字段也会报错。通知的摘要和分类可以编辑。任务完成时间由状态变化维护；重复完成保留原时间，取消完成恢复 null。已 confirmed 的通知不可退回其他提取状态。

## 首页口径

- `getDashboardStats()`：通知总数 notificationCount、未读通知数 unreadCount、pending 任务数 pendingTaskCount、**未读且重要的通知数** importantCount。重要任务不另行累加，避免重复统计。
- `getTodayHighlights()`：返回浏览器本地日历日期为今天的**全部通知，不只是重要通知**，包含普通通知以及已读通知；重要优先，同等重要程度下按 time 倒序。返回通知数组。
- `getRecentTasks()`：返回最多五条 pending 任务；按截止时间升序（包含逾期任务），null 排最后，同截止时间按 createdAt 倒序。返回任务数组。

## 存储与错误

固定键名：`zhixing_notifications`、`zhixing_tasks`、`zhixing_settings`。settings 在 V1 仅保留键名并监听变化，尚未定义设置结构和读写 API，页面不要自行实现设置存储。

模块同时导出 `STORAGE_KEYS`（只读键名映射）和 `DataError`。通过错误对象的 `code` 处理以下错误：

| DataError.code | 含义 |
| --- | --- |
| `VALIDATION` | 字段、类型、枚举、时间格式或状态修改权限不符合约定 |
| `NOT_FOUND` | 更新的记录或生成任务所需的来源通知不存在 |
| `DUPLICATE_TASK` | 通知已有关联任务或已经 confirmed |
| `CORRUPT_DATA` | 存储内容不是合法的数据数组，含非法记录、重复 ID 或重复任务来源 |
| `STORAGE_UNAVAILABLE` | 无法访问或读取本地存储 |
| `STORAGE_WRITE_FAILED` | 保存失败；提取流程如已写入任务，会尝试回滚 |
| `PARTIAL_WRITE` | 提取流程部分保存成功，且回滚失败，页面应重新读取数据 |
| `LOCK_UNAVAILABLE` | 当前环境不支持写入所需的 Web Locks |

损坏的 JSON、非法结构和重复 ID 均报 CORRUPT_DATA，原键保持原样；不会清空存储或自动用空列表覆盖。页面应显示读取失败并停止依赖该数据的编辑，不要自行初始化覆盖。独立的其他键仍可读写。

页面对所有同步读取接口都应使用 try/catch。出现 `CORRUPT_DATA`、`STORAGE_UNAVAILABLE` 或其他读取异常时，显示明确的错误状态，禁用依赖失败数据的新增、修改、删除和提取操作；不得将失败伪装成空列表，也不得调用 clear、removeItem 或 setItem 自动清空、初始化或覆盖存储。保留上次结果时必须标注为不可用的旧数据。重试及订阅回调都应重新读取，只有相关读取成功后才能恢复编辑。组合页面依赖多个数据集时，任一必需数据集读取失败都应阻止依赖它的操作。

缺失的通知或任务键读取为空数组，不会在读取时写入默认数据。普通单键写入失败时抛出 STORAGE_WRITE_FAILED，不发送成功更新事件。提取流程回滚成功时保留原有任务数据；原任务键不存在时恢复为不存在，而非创建空数组。回滚失败时发送任务键更新事件，提示订阅者重新读取实际保存状态。

同页写入成功主动通知；同源其他标签页通过浏览器 storage 事件通知（含 settings）。浏览器可能为提取流程发送多次事件，页面刷新需可重复执行。LocalStorage 不提供跨键事务：提取流程第二次写入失败会回滚任务；若回滚也失败抛 PARTIAL_WRITE。浏览器在两次写入之间崩溃仍可能留下任务与提取状态不同步，但来源 ID 检查能阻止重复生成任务。V1 不承诺跨键原子快照。

读取异常边界：当前提取流程读取回滚备份的 `store.getItem(STORAGE_KEYS.tasks)` 位于写入 try/catch 外。在先前读取成功、该次读取失败的情况下，可能抛出浏览器原生异常，而非 DataError。带来源的 addTask 也受影响；页面需对非 DataError 提供兜底处理。本次不修改此实现。
