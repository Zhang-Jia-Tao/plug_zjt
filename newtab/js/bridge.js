// bridge.js — 跨扩展通信：向「程序员便利贴」扩展请求规划清单数据
// 机制：chrome.runtime.sendMessage(extId, msg, callback)
// 便利贴侧需在 manifest 声明 externally_connectable.ids 允许本扩展接入。

const STICKY_TIMEOUT_MS = 5000;

function friendlyError(message) {
  const text = String(message || '');
  if (/Receiving end does not exist|Could not establish connection/i.test(text)) {
    return '便利贴扩展未安装或未开启';
  }
  if (text === '来源未授权') {
    return '来源未授权：请检查便利贴 manifest 的 externally_connectable.ids 是否包含本扩展 ID';
  }
  return text || '便利贴扩展响应失败';
}

// 发送消息给便利贴扩展；返回 { ok, data, message }
// 带超时：目标扩展未响应时不能让任务卡一直停在「正在读取」
export function sendToSticky(extId, action, payload = {}) {
  return new Promise((resolve) => {
    if (!extId) {
      resolve({ ok: false, message: '未配置便利贴扩展 ID' });
      return;
    }
    let settled = false;
    let timer = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      finish({ ok: false, message: '便利贴扩展响应超时，请确认扩展已启用' });
    }, STICKY_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage(extId, { action, payload }, (res) => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, message: friendlyError(chrome.runtime.lastError.message) });
          return;
        }
        if (!res || !res.ok) {
          finish({ ok: false, message: friendlyError(res?.message) });
          return;
        }
        finish({ ok: true, data: res.data });
      });
    } catch (e) {
      finish({ ok: false, message: friendlyError(e && e.message || e) });
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
