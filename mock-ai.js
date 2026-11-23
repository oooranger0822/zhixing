// C 模块专属：模拟 AI 识别结果（仅供开发测试）。
// 不包含 notificationId —— 加载时使用任务弹窗中「当前已选择」的真实通知 ID 作为来源。
// 接入 B 模块真实识别后，可删除本文件或停止引用，无需改动任务流程。
export const MOCK_AI_RESULT = Object.freeze({
  title: '数据结构课程作业',
  course: '数据结构',
  content: '完成第三章课后习题，并整理实验报告。',
  deadline: '2026-11-25T23:59:00+08:00',
  deadlineText: '11月25日晚上11:59',
});
