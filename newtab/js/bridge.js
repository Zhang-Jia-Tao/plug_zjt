// bridge.js — 跨扩展通信：向「程序员便利贴」扩展请求规划清单数据
// 机制：chrome.runtime.sendMessage(extId, msg, callback)
// 便利贴侧需在 manifest 声明 externally_connectable.ids 允许本扩展接入。

// 发送消息给便利贴扩展；返回 { ok, data, message }
export function sendToSticky(extId, action, payload = {}) {
  return new Promise((resolve) => {
    if (!extId) {
      resolve({ ok: false, message: '未配置便利贴扩展 ID' });
      return;
    }
    try {
      chrome.runtime.sendMessage(extId, { action, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, message: '便利贴扩展未安装或未授权' });
          return;
        }
        if (!res || !res.ok) {
          resolve({ ok: false, message: res?.message || '便利贴扩展响应失败' });
          return;
        }
        resolve({ ok: true, data: res.data });
      });
    } catch (e) {
      resolve({ ok: false, message: String(e && e.message || e) });
    }
  });
}

// 拉取便利贴全部规划清单（task_list 分类）
export async function fetchTaskNotes(extId) {
  return sendToSticky(extId, 'getTaskNotes');
}

// 拉取便利贴提醒/会议事项（reminder/meeting 分类，含 remindAt 时间）
export async function fetchReminders(extId) {
  return sendToSticky(extId, 'getReminders');
}

// 勾选/取消一条任务（便利贴侧处理「已完成」标题联动）
export async function toggleStickyTask(extId, noteId, taskId) {
  return sendToSticky(extId, 'toggleTask', { noteId, taskId });
}
